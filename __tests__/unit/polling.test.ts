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
