import { describe, it, expect, jest } from "@jest/globals";
import { NoteCache, buildNoteCacheSyncFilter } from "../../src/note-cache.js";

// A note as returned by getNote — only the fields the cache reads.
const note = (
  guid: string,
  usn: number,
  content = `<en-note>${guid}</en-note>`,
) => ({
  guid,
  title: `T-${guid}`,
  updateSequenceNum: usn,
  content,
});

describe("NoteCache get/set", () => {
  it("evicts the least-recently-used entry past the ceiling", () => {
    const cache = new NoteCache({ maxEntries: 2 });
    cache.set("a", note("a", 1), false);
    cache.set("b", note("b", 1), false);
    cache.set("c", note("c", 1), false); // size 3 > 2 → evict oldest "a"

    expect(cache.get("a", false)).toBeUndefined();
    // Touching "b" makes it most-recently-used, so "c" is now the oldest.
    expect(cache.get("b", false)).toBeTruthy();
    cache.set("d", note("d", 1), false); // evict "c"

    expect(cache.get("c", false)).toBeUndefined();
    expect(cache.get("b", false)).toBeTruthy();
    expect(cache.get("d", false)).toBeTruthy();
  });

  it("misses when a resource-less entry can't satisfy a resource request", () => {
    const cache = new NoteCache({ maxEntries: 10 });
    cache.set("a", note("a", 1), false);
    expect(cache.get("a", true)).toBeUndefined();
    expect(cache.get("a", false)).toBeTruthy();
  });

  it("preserves resource metadata on a hit read without resources", () => {
    const cache = new NoteCache({ maxEntries: 10 });
    const withRes: any = {
      ...note("a", 1),
      resources: [{ guid: "r1", mime: "image/png", data: { size: 5 } }],
    };
    cache.set("a", withRes, true);

    // Only bodies are stripped — resource metadata stays so content rendering
    // (attachment filenames/mime) and listings are consistent regardless of
    // which read primed the cache.
    const hit = cache.get("a", false);
    expect(hit.resources).toHaveLength(1);
    expect(hit.resources[0].guid).toBe("r1");
    expect(hit.resources[0].mime).toBe("image/png");
  });

  it("evicts and misses a cached body older than a caller-known USN", () => {
    const cache = new NoteCache({ maxEntries: 10 });
    cache.set("a", note("a", 5), false); // cached at USN 5
    // Caller read fresh metadata: the note is now at USN 8, so the USN-5 body
    // is stale and must not be served.
    expect(cache.get("a", false, 8)).toBeUndefined();
    // The stale entry was evicted, so a follow-up read also misses.
    expect(cache.get("a", false)).toBeUndefined();
  });

  it("serves a cached body whose USN already matches the caller-known USN", () => {
    const cache = new NoteCache({ maxEntries: 10 });
    cache.set("a", note("a", 8), false);
    expect(cache.get("a", false, 8)).toBeTruthy(); // usn 8 is not older than 8
  });

  it("strips resource binaries and recognition before caching", () => {
    const cache = new NoteCache({ maxEntries: 10 });
    const withRes: any = {
      ...note("a", 1),
      resources: [
        {
          guid: "r1",
          mime: "image/png",
          data: { size: 10, bodyHash: "hash", body: Buffer.from("binary") },
          recognition: Buffer.from("<recoIndex/>"),
        },
      ],
    };
    cache.set("a", withRes, true);

    const hit = cache.get("a", true);
    expect(hit.resources[0].data.body).toBeUndefined();
    expect(hit.resources[0].data.size).toBe(10);
    expect(hit.resources[0].data.bodyHash).toBe("hash");
    // Recognition is replaced with a non-parseable marker (keeps OCR
    // eligibility, forces a live re-fetch), not deleted outright.
    expect(hit.resources[0].recognition).toBeTruthy();
    expect(Buffer.isBuffer(hit.resources[0].recognition)).toBe(false);
    // The caller's original object is untouched — it still has the body inline
    // for its own (miss-path) attachment extraction.
    expect(withRes.resources[0].data.body).toBeDefined();
    expect(Buffer.isBuffer(withRes.resources[0].recognition)).toBe(true);
  });

  it("skips caching bodies larger than maxEntryBytes", () => {
    const cache = new NoteCache({ maxEntries: 10, maxEntryBytes: 8 });
    cache.set("a", note("a", 1, "0123456789"), false); // 10 bytes > 8
    expect(cache.get("a", false)).toBeUndefined();
    cache.set("b", note("b", 1, "tiny"), false);
    expect(cache.get("b", false)).toBeTruthy();
  });

  it("evicts a guid on demand (self-write path)", () => {
    const cache = new NoteCache({ maxEntries: 10 });
    cache.set("a", note("a", 1), false);
    cache.evict("a");
    expect(cache.get("a", false)).toBeUndefined();
  });

  it("is inert when maxEntries is 0", async () => {
    const getSyncState = jest.fn();
    const cache = new NoteCache({ maxEntries: 0 });
    expect(cache.enabled).toBe(false);
    cache.set("a", note("a", 1), false);
    expect(cache.get("a", false)).toBeUndefined();
    await cache.ensureFresh({
      getSyncState,
      getFilteredSyncChunk: jest.fn(),
    } as any);
    expect(getSyncState).not.toHaveBeenCalled();
  });
});

describe("NoteCache.ensureFresh", () => {
  it("seeds the sync cursor on first probe without walking chunks", async () => {
    const getSyncState = jest.fn(async () => ({ updateCount: 50 }));
    const getFilteredSyncChunk = jest.fn();
    const cache = new NoteCache({ maxEntries: 10, now: () => 1000 });

    await cache.ensureFresh({ getSyncState, getFilteredSyncChunk } as any);

    expect(getSyncState).toHaveBeenCalledTimes(1);
    expect(getFilteredSyncChunk).not.toHaveBeenCalled();
  });

  it("suppresses repeat probes within the TTL, then re-probes after it", async () => {
    let now = 1000;
    const getSyncState = jest.fn(async () => ({ updateCount: 50 }));
    const getFilteredSyncChunk = jest.fn();
    const api = { getSyncState, getFilteredSyncChunk } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    await cache.ensureFresh(api); // seeds + probes
    await cache.ensureFresh(api); // within TTL → skipped
    expect(getSyncState).toHaveBeenCalledTimes(1);

    now += 30000;
    await cache.ensureFresh(api); // TTL elapsed, unchanged count → no chunk walk
    expect(getSyncState).toHaveBeenCalledTimes(2);
    expect(getFilteredSyncChunk).not.toHaveBeenCalled();
  });

  it("evicts only changed and expunged notes on an external edit", async () => {
    let now = 1000;
    let updateCount = 50;
    const getSyncState = jest.fn(async () => ({ updateCount }));
    const getFilteredSyncChunk = jest.fn(
      async (_afterUSN: number, _maxEntries: number, _filter: any) => ({
        chunkHighUSN: 60,
        notes: [{ guid: "changed", updateSequenceNum: 55 }],
        expungedNotes: ["gone"],
      }),
    );
    const api = { getSyncState, getFilteredSyncChunk } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    await cache.ensureFresh(api); // seed at 50
    cache.set("changed", note("changed", 40), false);
    cache.set("gone", note("gone", 40), false);
    cache.set("kept", note("kept", 40), false);

    now += 30000;
    updateCount = 60;
    await cache.ensureFresh(api);

    expect(getFilteredSyncChunk).toHaveBeenCalledWith(
      50,
      100,
      expect.objectContaining({ includeNotes: true, includeExpunged: true }),
    );
    expect(cache.get("changed", false)).toBeUndefined();
    expect(cache.get("gone", false)).toBeUndefined();
    expect(cache.get("kept", false)).toBeTruthy();
  });

  it("keeps an entry whose cached USN already covers the reported change", async () => {
    let now = 1000;
    let updateCount = 50;
    const getSyncState = jest.fn(async () => ({ updateCount }));
    const getFilteredSyncChunk = jest.fn(async () => ({
      chunkHighUSN: 60,
      notes: [{ guid: "a", updateSequenceNum: 55 }],
    }));
    const api = { getSyncState, getFilteredSyncChunk } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    await cache.ensureFresh(api); // seed 50
    cache.set("a", note("a", 60), false); // a fresh fetch raced ahead to USN 60

    now += 30000;
    updateCount = 60;
    await cache.ensureFresh(api); // chunk reports a@55 ≤ 60 → keep

    expect(cache.get("a", false)).toBeTruthy();
  });

  it("walks multiple chunks until the cursor reaches updateCount", async () => {
    let now = 1000;
    let updateCount = 50;
    const seen: number[] = [];
    const getSyncState = jest.fn(async () => ({ updateCount }));
    const getFilteredSyncChunk = jest.fn(async (afterUSN: number) => {
      seen.push(afterUSN);
      return afterUSN === 50
        ? { chunkHighUSN: 150, notes: [{ guid: "a", updateSequenceNum: 100 }] }
        : { chunkHighUSN: 250, notes: [{ guid: "b", updateSequenceNum: 200 }] };
    });
    const api = { getSyncState, getFilteredSyncChunk } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    await cache.ensureFresh(api); // seed 50
    cache.set("a", note("a", 40), false);
    cache.set("b", note("b", 40), false);

    now += 30000;
    updateCount = 250;
    await cache.ensureFresh(api);

    expect(seen).toEqual([50, 150]);
    expect(getFilteredSyncChunk).toHaveBeenCalledTimes(2);
    expect(cache.get("a", false)).toBeUndefined();
    expect(cache.get("b", false)).toBeUndefined();
  });

  it("clears the cache when the backlog outruns the chunk-iteration cap", async () => {
    let now = 1000;
    let updateCount = 50;
    const getSyncState = jest.fn(async () => ({ updateCount }));
    // Each chunk advances the cursor by only 1 USN, never catching up.
    const getFilteredSyncChunk = jest.fn(async (afterUSN: number) => ({
      chunkHighUSN: afterUSN + 1,
      notes: [],
    }));
    const api = { getSyncState, getFilteredSyncChunk } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    await cache.ensureFresh(api); // seed 50
    cache.set("a", note("a", 40), false);

    now += 30000;
    updateCount = 1000;
    await cache.ensureFresh(api); // 10 iterations, still behind → clear()

    expect(getFilteredSyncChunk).toHaveBeenCalledTimes(10);
    expect(cache.get("a", false)).toBeUndefined();
  });

  it("retains entries on a transient probe failure (does not clear)", async () => {
    let now = 1000;
    let fail = false;
    const getSyncState = jest.fn(async () => {
      if (fail) {
        throw new Error("rate limited");
      }
      return { updateCount: 50 };
    });
    const getFilteredSyncChunk = jest.fn();
    const api = { getSyncState, getFilteredSyncChunk } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    await cache.ensureFresh(api); // seed 50
    cache.set("a", note("a", 40), false);

    now += 30000;
    fail = true;
    await cache.ensureFresh(api); // transient failure → don't clear

    // The entry survives in the map (a transient blip must not wipe the cache);
    // whether it's actually *served* is gated separately by isFresh() at the
    // read-through layer.
    expect(cache.get("a", false)).toBeTruthy();
    expect(getFilteredSyncChunk).not.toHaveBeenCalled();
  });

  it("reports not-fresh once the last successful probe is older than the TTL", async () => {
    let now = 1000;
    let mode: "ok" | "fail" = "ok";
    const getSyncState = jest.fn(async () => {
      if (mode === "fail") {
        throw new Error("network"); // transient
      }
      return { updateCount: 5 };
    });
    const api = { getSyncState, getFilteredSyncChunk: jest.fn() } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    await cache.ensureFresh(api); // probe ok → verified at 1000
    expect(cache.isFresh()).toBe(true);

    mode = "fail";
    now += 60000; // 60s later, well past the 30s TTL
    await cache.ensureFresh(api); // probe fails → verified timestamp unchanged
    expect(cache.isFresh()).toBe(false);
  });

  it("rethrows auth failures from the sync probe instead of serving stale", async () => {
    let now = 1000;
    let mode: "ok" | "auth" = "ok";
    const getSyncState = jest.fn(async () => {
      if (mode === "auth") {
        const e: any = new Error("authentication expired");
        e.errorCode = 9;
        throw e;
      }
      return { updateCount: 50 };
    });
    const api = { getSyncState, getFilteredSyncChunk: jest.fn() } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    await cache.ensureFresh(api); // seed 50
    cache.set("a", note("a", 40), false);

    now += 30000;
    mode = "auth";
    await expect(cache.ensureFresh(api)).rejects.toThrow(
      "authentication expired",
    );
    // TTL gate was reset, so the very next read re-probes and re-surfaces the
    // auth error rather than silently serving stale for a whole TTL window.
    await expect(cache.ensureFresh(api)).rejects.toThrow(
      "authentication expired",
    );
    expect(getSyncState).toHaveBeenCalledTimes(3);
  });

  it("clears entries cached before the cursor was known when finally seeding", async () => {
    let now = 1000;
    let mode: "fail" | "ok" = "fail";
    const getSyncState = jest.fn(async () => {
      if (mode === "fail") {
        throw new Error("network blip"); // transient (no errorCode) → swallowed
      }
      return { updateCount: 50 };
    });
    const getFilteredSyncChunk = jest.fn();
    const api = { getSyncState, getFilteredSyncChunk } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    // First probe fails: lastUpdateCount stays null, but a read still caches a body.
    await cache.ensureFresh(api);
    cache.set("a", note("a", 40), false);
    expect(cache.get("a", false)).toBeTruthy();

    // Next probe succeeds and seeds the cursor — the entry cached during the
    // unknown-cursor window can't be reconciled, so it's dropped, not kept.
    now += 30000;
    mode = "ok";
    await cache.ensureFresh(api);
    expect(cache.get("a", false)).toBeUndefined();
    expect(getFilteredSyncChunk).not.toHaveBeenCalled();
  });

  it("clears the cache when the chunk walk fails", async () => {
    let now = 1000;
    let updateCount = 50;
    const getSyncState = jest.fn(async () => ({ updateCount }));
    const getFilteredSyncChunk = jest.fn(async () => {
      throw new Error("boom");
    });
    const api = { getSyncState, getFilteredSyncChunk } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => now,
    });

    await cache.ensureFresh(api); // seed 50
    cache.set("a", note("a", 40), false);

    now += 30000;
    updateCount = 60;
    await cache.ensureFresh(api); // walk throws → clear()

    expect(cache.get("a", false)).toBeUndefined();
  });

  it("de-duplicates concurrent refreshes into a single probe", async () => {
    let resolveState: (value: { updateCount: number }) => void = () => {};
    const getSyncState = jest.fn(
      () =>
        new Promise<{ updateCount: number }>((resolve) => {
          resolveState = resolve;
        }),
    );
    const api = { getSyncState, getFilteredSyncChunk: jest.fn() } as any;
    const cache = new NoteCache({
      maxEntries: 10,
      syncTtlMs: 30000,
      now: () => 1000,
    });

    const p1 = cache.ensureFresh(api);
    const p2 = cache.ensureFresh(api); // in-flight → shares p1's probe
    resolveState({ updateCount: 50 });
    await Promise.all([p1, p2]);

    expect(getSyncState).toHaveBeenCalledTimes(1);
  });
});

describe("buildNoteCacheSyncFilter", () => {
  it("requests a note-focused sync filter", () => {
    expect(buildNoteCacheSyncFilter()).toEqual({
      includeNotes: true,
      includeNoteResources: false,
      includeNoteAttributes: false,
      includeNotebooks: false,
      includeTags: false,
      includeSearches: false,
      includeResources: false,
      includeLinkedNotebooks: false,
      includeExpunged: true,
    });
  });
});
