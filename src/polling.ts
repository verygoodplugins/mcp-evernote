export type PollingChangeType =
  | 'note_created'
  | 'note_updated'
  | 'note_deleted'
  | 'notebook_changed'
  | 'tag_changed';

export interface PollingChange {
  type: PollingChangeType;
  guid?: string;
  title?: string;
  notebookGuid?: string;
  timestamp: string;
}

export interface SyncChunkFilterShape {
  includeNotes: boolean;
  includeNoteResources: boolean;
  includeNoteAttributes: boolean;
  includeNotebooks: boolean;
  includeTags: boolean;
  includeSearches: boolean;
  includeResources: boolean;
  includeLinkedNotebooks: boolean;
  includeExpunged: boolean;
}

export interface PollingCheckResult {
  changes: PollingChange[];
  currentUpdateCount: number;
  nextUpdateCount: number | null;
  error?: Error;
}

interface PollingEvernoteApi {
  getSyncState(): Promise<{ updateCount: number }>;
  getFilteredSyncChunk(
    afterUSN: number,
    maxEntries: number,
    filter: SyncChunkFilterShape
  ): Promise<{
    /**
     * Highest USN covered by this chunk. The service sets it across the whole
     * scanned range, including objects this filter excludes, so it is the
     * authoritative "how far did we get" marker. Absent when the chunk is empty.
     */
    chunkHighUSN?: number;
    /** The account's updateCount as of this chunk — the walk's end marker. */
    updateCount?: number;
    notes?: Array<{
      guid?: string;
      title?: string;
      notebookGuid?: string;
      created?: number;
      updated?: number;
    }>;
    expungedNotes?: string[];
    notebooks?: Array<{ guid?: string; name?: string }>;
    tags?: Array<{ guid?: string; name?: string }>;
  }>;
}

interface CheckForPollingChangesOptions {
  evernoteApi: PollingEvernoteApi;
  lastUpdateCount: number | null;
  maxEntries?: number;
  now?: () => Date;
}

/**
 * Chunks walked per poll. Deliberately far above note-cache's MAX_CHUNK_ITERATIONS
 * of 10: that cap ends in clear(), which is safe for a cache because a dropped
 * entry only forces a re-fetch, while a dropped change here is a webhook that
 * never fires. Because the cursor advances only as far as the walk actually read,
 * this cap costs an extra interval on a huge backlog rather than losing anything.
 */
const MAX_POLL_CHUNK_ITERATIONS = 50;

export function buildSyncChunkFilter(): SyncChunkFilterShape {
  return {
    includeNotes: true,
    includeNoteResources: false,
    includeNoteAttributes: false,
    includeNotebooks: true,
    includeTags: true,
    includeSearches: false,
    includeResources: false,
    includeLinkedNotebooks: false,
    includeExpunged: true,
  };
}

export function buildWebhookPayload(
  change: PollingChange,
  now: () => Date = () => new Date()
): {
  source: 'mcp-evernote';
  timestamp: string;
  changes: PollingChange[];
} {
  return {
    source: 'mcp-evernote',
    timestamp: now().toISOString(),
    changes: [change],
  };
}

export async function checkForPollingChanges({
  evernoteApi,
  lastUpdateCount,
  maxEntries = 100,
  now = () => new Date(),
}: CheckForPollingChangesOptions): Promise<PollingCheckResult> {
  const syncState = await evernoteApi.getSyncState();
  const currentUpdateCount = syncState.updateCount;

  if (lastUpdateCount === null || currentUpdateCount === lastUpdateCount) {
    return {
      changes: [],
      currentUpdateCount,
      nextUpdateCount: currentUpdateCount,
    };
  }

  // Collected outside the try: a failure partway through the walk must keep the
  // chunks already read and the cursor already reached. Resetting to
  // lastUpdateCount would re-walk them next poll, so a backlog larger than one
  // rate-limit window could never drain and would trip the poll error limit.
  const changes: PollingChange[] = [];
  let cursor = lastUpdateCount;

  try {
    for (let i = 0; i < MAX_POLL_CHUNK_ITERATIONS; i++) {
      const chunk = await evernoteApi.getFilteredSyncChunk(
        cursor,
        maxEntries,
        buildSyncChunkFilter()
      );

      // Prefer the chunk's own updateCount: it is consistent with chunkHighUSN,
      // whereas the getSyncState value was read before the walk started.
      const head =
        typeof chunk.updateCount === 'number'
          ? chunk.updateCount
          : currentUpdateCount;
      const high = chunk.chunkHighUSN;

      if (typeof high !== 'number') {
        // Empty chunk: nothing matching the filter remains past the cursor, so
        // the walk is done. Advance past the scanned range.
        changes.push(...changesFromSyncChunk(chunk, now));
        cursor = Math.max(cursor, head);
        break;
      }

      if (high <= cursor) {
        // No forward progress. Advancing would skip changes and looping would
        // spin, so stop and surface it. Note the return happens before this
        // chunk is appended and leaves the cursor where it was, so its changes
        // are deferred to the next poll rather than lost or double-sent.
        return {
          changes,
          currentUpdateCount,
          nextUpdateCount: cursor,
          error: new Error(
            `sync chunk did not advance past USN ${cursor} (chunkHighUSN ${high})`
          ),
        };
      }

      // Append and advance together, so the two never disagree.
      changes.push(...changesFromSyncChunk(chunk, now));
      cursor = high;

      if (high >= head) {
        break;
      }
    }

    // Hitting the iteration cap is not an error: the cursor advanced only as far
    // as we actually read, so the rest of the backlog arrives on the next poll.
    return { changes, currentUpdateCount, nextUpdateCount: cursor };
  } catch (error: unknown) {
    return {
      changes,
      currentUpdateCount,
      nextUpdateCount: cursor,
      error: normalizeError(error),
    };
  }
}

function changesFromSyncChunk(
  chunk: Awaited<ReturnType<PollingEvernoteApi['getFilteredSyncChunk']>>,
  now: () => Date
): PollingChange[] {
  const changes: PollingChange[] = [];

  for (const note of chunk.notes || []) {
    const updated = note.updated || now().getTime();
    changes.push({
      type: note.created === note.updated ? 'note_created' : 'note_updated',
      guid: note.guid,
      title: note.title,
      notebookGuid: note.notebookGuid,
      timestamp: new Date(updated).toISOString(),
    });
  }

  for (const guid of chunk.expungedNotes || []) {
    changes.push({
      type: 'note_deleted',
      guid,
      timestamp: now().toISOString(),
    });
  }

  for (const notebook of chunk.notebooks || []) {
    changes.push({
      type: 'notebook_changed',
      guid: notebook.guid,
      title: notebook.name,
      timestamp: now().toISOString(),
    });
  }

  for (const tag of chunk.tags || []) {
    changes.push({
      type: 'tag_changed',
      guid: tag.guid,
      title: tag.name,
      timestamp: now().toISOString(),
    });
  }

  return changes;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return new Error(message);
    }
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}
