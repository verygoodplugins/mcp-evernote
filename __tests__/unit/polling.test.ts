import { jest } from '@jest/globals';
import {
  buildSyncChunkFilter,
  buildWebhookPayload,
  checkForPollingChanges,
} from '../../src/polling';

describe('Evernote polling', () => {
  it('fetches filtered sync chunks and converts note changes', async () => {
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 15 }),
      getFilteredSyncChunk: jest.fn().mockResolvedValue({
        chunkHighUSN: 15,
        updateCount: 15,
        notes: [
          {
            guid: 'note-new',
            title: 'New note',
            notebookGuid: 'notebook-1',
            created: 1000,
            updated: 1000,
          },
          {
            guid: 'note-updated',
            title: 'Updated note',
            notebookGuid: 'notebook-1',
            created: 1000,
            updated: 2000,
          },
        ],
      }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 10,
      now: () => new Date('2026-05-22T10:00:00.000Z'),
    });

    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenCalledWith(
      10,
      100,
      expect.objectContaining({
        includeNotes: true,
        includeNotebooks: true,
        includeTags: true,
        includeExpunged: true,
      }),
    );
    expect(result.nextUpdateCount).toBe(15);
    expect(result.changes).toEqual([
      {
        type: 'note_created',
        guid: 'note-new',
        title: 'New note',
        notebookGuid: 'notebook-1',
        timestamp: '1970-01-01T00:00:01.000Z',
      },
      {
        type: 'note_updated',
        guid: 'note-updated',
        title: 'Updated note',
        notebookGuid: 'notebook-1',
        timestamp: '1970-01-01T00:00:02.000Z',
      },
    ]);
  });

  it('keeps the previous update count when chunk fetching fails', async () => {
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 15 }),
      getFilteredSyncChunk: jest.fn().mockRejectedValue(new Error('boom')),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 10,
    });

    expect(result.nextUpdateCount).toBe(10);
    expect(result.error?.message).toBe('boom');
    expect(result.changes).toEqual([]);
  });

  it('walks every chunk when more than one chunk of changes is pending', async () => {
    // 150 changes across two 100-entry chunks. The old single-chunk read dropped
    // everything past the first chunk and jumped the cursor to the account head.
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 250 }),
      getFilteredSyncChunk: jest
        .fn()
        .mockResolvedValueOnce({
          chunkHighUSN: 200,
          updateCount: 250,
          notes: [
            { guid: 'chunk-1-note', created: 1000, updated: 1000 },
          ],
        })
        .mockResolvedValueOnce({
          chunkHighUSN: 250,
          updateCount: 250,
          notes: [
            { guid: 'chunk-2-note', created: 1000, updated: 2000 },
          ],
        }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 100,
    });

    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenCalledTimes(2);
    // Second call resumes from the first chunk's high USN, not from the start.
    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenNthCalledWith(
      1,
      100,
      100,
      expect.any(Object),
    );
    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenNthCalledWith(
      2,
      200,
      100,
      expect.any(Object),
    );
    expect(result.changes.map((c) => c.guid)).toEqual([
      'chunk-1-note',
      'chunk-2-note',
    ]);
    expect(result.nextUpdateCount).toBe(250);
    expect(result.error).toBeUndefined();
  });

  it('stops after one chunk when that chunk already reaches the account head', async () => {
    // The service sets chunkHighUSN across the whole scanned range, including
    // objects this filter excludes, so a quiet account must cost exactly one
    // call. Looping on the getSyncState value instead would add an empty second
    // call to most ordinary polls.
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 20 }),
      getFilteredSyncChunk: jest.fn().mockResolvedValue({
        chunkHighUSN: 20,
        updateCount: 20,
        notes: [{ guid: 'only-note', created: 1000, updated: 1000 }],
      }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 10,
    });

    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenCalledTimes(1);
    expect(result.nextUpdateCount).toBe(20);
    expect(result.error).toBeUndefined();
  });

  it('keeps the chunks already read when the walk fails partway through', async () => {
    // A rate limit on chunk 2 must not discard chunk 1. Resetting the cursor
    // here would re-walk the same chunks next poll, so a backlog bigger than one
    // rate-limit window could never drain.
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 400 }),
      getFilteredSyncChunk: jest
        .fn()
        .mockResolvedValueOnce({
          chunkHighUSN: 200,
          updateCount: 400,
          notes: [{ guid: 'survived', created: 1000, updated: 1000 }],
        })
        .mockRejectedValueOnce(new Error('rate limited')),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 100,
    });

    expect(result.changes.map((c) => c.guid)).toEqual(['survived']);
    expect(result.nextUpdateCount).toBe(200);
    expect(result.error?.message).toBe('rate limited');
  });

  it('advances only as far as it read when the backlog outruns the chunk cap', async () => {
    // Cap exceeded is not an error: the remainder arrives on the next poll.
    let high = 100;
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 100000 }),
      getFilteredSyncChunk: jest.fn().mockImplementation(async () => {
        high += 100;
        return {
          chunkHighUSN: high,
          updateCount: 100000,
          notes: [{ guid: `note-${high}`, created: 1000, updated: 1000 }],
        };
      }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 100,
    });

    const calls = evernoteApi.getFilteredSyncChunk.mock.calls.length;
    expect(calls).toBe(50);
    expect(result.changes).toHaveLength(50);
    expect(result.nextUpdateCount).toBe(5100);
    expect(result.nextUpdateCount).toBeLessThan(100000);
    expect(result.error).toBeUndefined();
  });

  it('stops with an error when a chunk does not advance the cursor', async () => {
    // Advancing would skip changes and looping would spin, so surface it. The
    // non-advancing chunk's changes are dropped with the cursor rather than
    // re-sent on every later poll.
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 500 }),
      getFilteredSyncChunk: jest.fn().mockResolvedValue({
        chunkHighUSN: 100,
        updateCount: 500,
        notes: [{ guid: 'stuck', created: 1000, updated: 1000 }],
      }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 100,
    });

    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenCalledTimes(1);
    expect(result.nextUpdateCount).toBe(100);
    expect(result.changes).toEqual([]);
    expect(result.error?.message).toMatch(/did not advance/);
  });

  it('treats a chunk with no chunkHighUSN as the end of the walk', async () => {
    // Evernote omits chunkHighUSN on an empty chunk: nothing matching the filter
    // remains, so advance past the scanned range instead of stalling.
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 42 }),
      getFilteredSyncChunk: jest.fn().mockResolvedValue({ updateCount: 42 }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 10,
    });

    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenCalledTimes(1);
    expect(result.nextUpdateCount).toBe(42);
    expect(result.changes).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('makes exactly one call when only excluded objects changed', async () => {
    // The account head moved because of something this filter excludes (a
    // resource). The chunk comes back with no matching entries but a high USN
    // that already reaches the head, so the walk must end there.
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 20 }),
      getFilteredSyncChunk: jest.fn().mockResolvedValue({
        chunkHighUSN: 20,
        updateCount: 20,
      }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 10,
    });

    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenCalledTimes(1);
    expect(result.changes).toEqual([]);
    expect(result.nextUpdateCount).toBe(20);
    expect(result.error).toBeUndefined();
  });

  it('keeps a cursor that raced past the pre-walk sync state', async () => {
    // getSyncState runs before the walk, so a chunk can legitimately carry USNs
    // above it. Clamping back to the stale head would re-send those changes.
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 100 }),
      getFilteredSyncChunk: jest.fn().mockResolvedValue({
        chunkHighUSN: 150,
        updateCount: 150,
        notes: [{ guid: 'raced', created: 1000, updated: 1000 }],
      }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 90,
    });

    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenCalledTimes(1);
    expect(result.nextUpdateCount).toBe(150);
    expect(result.currentUpdateCount).toBe(100);
    expect(result.error).toBeUndefined();
  });

  it('falls back to the sync-state head when a chunk omits updateCount', async () => {
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 300 }),
      getFilteredSyncChunk: jest
        .fn()
        .mockResolvedValueOnce({
          chunkHighUSN: 200,
          notes: [{ guid: 'first', created: 1000, updated: 1000 }],
        })
        .mockResolvedValueOnce({
          chunkHighUSN: 300,
          notes: [{ guid: 'second', created: 1000, updated: 1000 }],
        }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 100,
    });

    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenCalledTimes(2);
    expect(result.changes.map((c) => c.guid)).toEqual(['first', 'second']);
    expect(result.nextUpdateCount).toBe(300);
    expect(result.error).toBeUndefined();
  });

  it('errors when a chunk reports a high USN below the cursor', async () => {
    const evernoteApi = {
      getSyncState: jest.fn().mockResolvedValue({ updateCount: 500 }),
      getFilteredSyncChunk: jest.fn().mockResolvedValue({
        chunkHighUSN: 50,
        updateCount: 500,
        notes: [{ guid: 'backwards', created: 1000, updated: 1000 }],
      }),
    };

    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount: 100,
    });

    expect(evernoteApi.getFilteredSyncChunk).toHaveBeenCalledTimes(1);
    expect(result.nextUpdateCount).toBe(100);
    expect(result.changes).toEqual([]);
    expect(result.error?.message).toMatch(/did not advance/);
  });

  it('builds the MCP webhook payload for one change at a time', () => {
    const change = {
      type: 'note_created' as const,
      guid: 'note-1',
      title: 'Note 1',
      timestamp: '2026-05-22T10:00:00.000Z',
    };

    expect(
      buildWebhookPayload(change, () => new Date('2026-05-22T10:01:00.000Z')),
    ).toEqual({
      source: 'mcp-evernote',
      timestamp: '2026-05-22T10:01:00.000Z',
      changes: [change],
    });
  });

  it('uses the SDK-supported filtered sync chunk shape', () => {
    expect(buildSyncChunkFilter()).toEqual({
      includeNotes: true,
      includeNoteResources: false,
      includeNoteAttributes: false,
      includeNotebooks: true,
      includeTags: true,
      includeSearches: false,
      includeResources: false,
      includeLinkedNotebooks: false,
      includeExpunged: true,
    });
  });
});
