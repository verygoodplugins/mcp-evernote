/**
 * USN-keyed note body cache.
 *
 * Evernote's hourly rate limit is a per-token call-count quota, so the only way
 * to survive re-reading the same notebook is to stop re-fetching notes that
 * have not changed. This cache holds note bodies (ENML + metadata, resource
 * binaries stripped) keyed by GUID and invalidates them two ways:
 *
 *  - External edits: a TTL-gated `getSyncState()` probe. When the account-wide
 *    `updateCount` advances, we walk `getFilteredSyncChunk` from our last cursor
 *    and evict exactly the notes that changed or were expunged. Unlike the
 *    polling path (which reads a single 100-entry chunk and force-advances its
 *    cursor, silently skipping changes past 100), this LOOPS the chunk walk so
 *    no change is missed. If the backlog is too large to track precisely, or the
 *    walk errors, we clear the whole cache — correctness over hit-rate.
 *  - Self writes: the API layer evicts a GUID the moment we update or delete it,
 *    so a read that follows our own write is always consistent immediately.
 *
 * Extracted OCR / attachment text is never cached: recognition data updates
 * asynchronously without bumping the note USN, so resource bodies and
 * recognition are stripped before storing and re-fetched live on read.
 */

import type { SyncChunkFilterShape } from "./polling.js";

export const DEFAULT_NOTE_CACHE_SIZE = 200;
export const DEFAULT_NOTE_CACHE_SYNC_TTL_MS = 30_000;
/** Skip caching note bodies larger than this (~1MB of ENML). */
export const DEFAULT_NOTE_CACHE_MAX_ENTRY_BYTES = 1_048_576;

/** Cap the chunk walk so a huge backlog can't spin the loop unbounded. */
const MAX_CHUNK_ITERATIONS = 10;
const CHUNK_SIZE = 100;

export interface NoteCacheOptions {
  /** Max notes held; 0 disables the cache entirely. */
  maxEntries?: number;
  /** How long a `getSyncState` probe result is trusted before re-checking. */
  syncTtlMs?: number;
  /** Skip caching bodies whose ENML exceeds this many bytes. */
  maxEntryBytes?: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  /** Observability sink; defaults to a no-op. */
  logger?: (message: string) => void;
}

/**
 * The sync surface the cache needs. `EvernoteAPI` satisfies this structurally,
 * so the read-through layer passes `this`; tests pass a lightweight fake.
 */
export interface NoteCacheSyncApi {
  getSyncState(): Promise<{ updateCount: number }>;
  getFilteredSyncChunk(
    afterUSN: number,
    maxEntries: number,
    filter: SyncChunkFilterShape,
  ): Promise<{
    chunkHighUSN?: number;
    updateCount?: number;
    notes?: Array<{ guid?: string; updateSequenceNum?: number }>;
    expungedNotes?: string[];
  }>;
}

interface CacheEntry {
  usn: number;
  hasResources: boolean;
  note: any;
}

export interface NoteCacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

/**
 * Note-focused sync filter: the cache only cares about note changes and
 * expunged notes, not notebooks/tags/resources.
 */
export function buildNoteCacheSyncFilter(): SyncChunkFilterShape {
  return {
    includeNotes: true,
    includeNoteResources: false,
    includeNoteAttributes: false,
    includeNotebooks: false,
    includeTags: false,
    includeSearches: false,
    includeResources: false,
    includeLinkedNotebooks: false,
    includeExpunged: true,
  };
}

export class NoteCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly syncTtlMs: number;
  private readonly maxEntryBytes: number;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;

  // `null` until the first successful sync probe seeds the cursor.
  private lastUpdateCount: number | null = null;
  private lastSyncCheckAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: NoteCacheOptions = {}) {
    this.maxEntries = Math.max(
      0,
      options.maxEntries ?? DEFAULT_NOTE_CACHE_SIZE,
    );
    this.syncTtlMs = Math.max(
      0,
      options.syncTtlMs ?? DEFAULT_NOTE_CACHE_SYNC_TTL_MS,
    );
    this.maxEntryBytes = Math.max(
      0,
      options.maxEntryBytes ?? DEFAULT_NOTE_CACHE_MAX_ENTRY_BYTES,
    );
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? (() => {});
  }

  /** False when disabled (maxEntries 0) — callers skip the cache path entirely. */
  get enabled(): boolean {
    return this.maxEntries > 0;
  }

  stats(): NoteCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.map.size,
      evictions: this.evictions,
    };
  }

  /**
   * Return a cached note, or `undefined` on a miss. A hit only counts when the
   * entry carries what the caller needs: an entry cached without resource
   * metadata does not satisfy a request that wants it.
   */
  get(guid: string, needResources: boolean): any | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const entry = this.map.get(guid);
    if (!entry || (needResources && !entry.hasResources)) {
      this.misses++;
      return undefined;
    }
    // LRU bump: re-insert so this GUID becomes most-recently-used.
    this.map.delete(guid);
    this.map.set(guid, entry);
    this.hits++;
    return entry.note;
  }

  /**
   * Store a content-bearing note. Resource binaries and recognition are stripped
   * first (never serve stale OCR / attachment bytes). Oversized bodies are
   * skipped so a handful of huge notes can't dominate memory.
   */
  set(guid: string, note: any, hasResources: boolean): void {
    if (!this.enabled || !guid || !note) {
      return;
    }
    const content = typeof note.content === "string" ? note.content : "";
    if (
      this.maxEntryBytes > 0 &&
      Buffer.byteLength(content, "utf8") > this.maxEntryBytes
    ) {
      return;
    }
    const usn =
      typeof note.updateSequenceNum === "number" ? note.updateSequenceNum : -1;
    // Delete-then-set moves an existing key to the most-recently-used position.
    this.map.delete(guid);
    this.map.set(guid, { usn, hasResources, note: stripForCache(note) });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }

  /** Drop a GUID (self-write eviction on update/delete). */
  evict(guid: string): void {
    if (this.map.delete(guid)) {
      this.evictions++;
    }
  }

  clear(reason?: string): void {
    if (this.map.size > 0) {
      this.evictions += this.map.size;
      this.map.clear();
    }
    if (reason) {
      this.logger(`note-cache: cleared (${reason})`);
    }
  }

  /**
   * Reconcile the cache with external edits before a read. TTL-gated so a burst
   * of reads triggers at most one `getSyncState` per window, and de-duplicated
   * so concurrent reads await a single in-flight refresh (and therefore observe
   * the same post-eviction state).
   */
  async ensureFresh(syncApi: NoteCacheSyncApi): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    const now = this.now();
    if (
      this.lastSyncCheckAt !== 0 &&
      now - this.lastSyncCheckAt < this.syncTtlMs
    ) {
      return;
    }
    // Stamp the check time up front so a failing probe still rate-limits itself.
    this.lastSyncCheckAt = now;
    this.refreshInFlight = this.refresh(syncApi).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refresh(syncApi: NoteCacheSyncApi): Promise<void> {
    let updateCount: number;
    try {
      const state = await syncApi.getSyncState();
      updateCount = state.updateCount;
    } catch (error) {
      // The probe failed — often the very rate limit this cache exists to dodge.
      // Keep serving what we have; the next probe after the TTL retries.
      this.logger(
        `note-cache: getSyncState failed, serving existing cache (${errText(error)})`,
      );
      return;
    }

    if (this.lastUpdateCount === null) {
      // First observation seeds the cursor; a cold cache has nothing to evict.
      this.lastUpdateCount = updateCount;
      return;
    }
    if (updateCount === this.lastUpdateCount) {
      // Account-wide unchanged: every cached entry is still valid, zero chunks.
      return;
    }

    try {
      let cursor = this.lastUpdateCount;
      let iterations = 0;
      let evicted = 0;
      while (cursor < updateCount && iterations < MAX_CHUNK_ITERATIONS) {
        iterations++;
        const chunk = await syncApi.getFilteredSyncChunk(
          cursor,
          CHUNK_SIZE,
          buildNoteCacheSyncFilter(),
        );
        for (const note of chunk.notes ?? []) {
          if (
            note.guid &&
            this.evictIfStale(note.guid, note.updateSequenceNum)
          ) {
            evicted++;
          }
        }
        for (const guid of chunk.expungedNotes ?? []) {
          if (guid) {
            const before = this.map.size;
            this.evict(guid);
            if (this.map.size < before) {
              evicted++;
            }
          }
        }
        const high = chunk.chunkHighUSN;
        if (typeof high !== "number" || high <= cursor) {
          // No forward progress — bail rather than risk serving stale entries.
          throw new Error("sync chunk did not advance");
        }
        cursor = high;
      }
      if (cursor < updateCount) {
        // Backlog outran the iteration cap: too much changed to reconcile
        // precisely, so drop everything.
        this.clear(`sync backlog exceeded ${MAX_CHUNK_ITERATIONS} chunks`);
      } else if (evicted > 0) {
        this.logger(
          `note-cache: sync ${this.lastUpdateCount}→${updateCount}, evicted ${evicted}`,
        );
      }
      this.lastUpdateCount = updateCount;
    } catch (error) {
      // Couldn't determine precisely what changed — clear and advance the cursor
      // so the next window starts from a clean, consistent baseline.
      this.clear(`sync walk failed: ${errText(error)}`);
      this.lastUpdateCount = updateCount;
    }
  }

  /**
   * Evict `guid` unless the change chunk reports a USN we already hold — a fresh
   * `getNote` can race ahead of the sync cursor, and re-evicting it would just
   * force a needless re-fetch.
   */
  private evictIfStale(guid: string, chunkUsn: number | undefined): boolean {
    const entry = this.map.get(guid);
    if (!entry) {
      return false;
    }
    if (typeof chunkUsn === "number" && chunkUsn <= entry.usn) {
      return false;
    }
    this.evict(guid);
    return true;
  }
}

/** Shallow-clone a note with resource binaries and recognition removed. */
function stripForCache(note: any): any {
  if (!note?.resources?.length) {
    return note;
  }
  return {
    ...note,
    resources: note.resources.map((resource: any) => stripResource(resource)),
  };
}

function stripResource(resource: any): any {
  if (!resource) {
    return resource;
  }
  const out: any = { ...resource };
  if (out.data) {
    // Keep size + bodyHash (cheap metadata); drop the binary body.
    out.data = { ...out.data, body: undefined };
  }
  if (out.recognition != null) {
    out.recognition = undefined;
  }
  return out;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
