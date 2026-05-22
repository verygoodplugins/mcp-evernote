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

  try {
    const chunk = await evernoteApi.getFilteredSyncChunk(
      lastUpdateCount,
      maxEntries,
      buildSyncChunkFilter()
    );

    return {
      changes: changesFromSyncChunk(chunk, now),
      currentUpdateCount,
      nextUpdateCount: currentUpdateCount,
    };
  } catch (error: unknown) {
    return {
      changes: [],
      currentUpdateCount,
      nextUpdateCount: lastUpdateCount,
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
