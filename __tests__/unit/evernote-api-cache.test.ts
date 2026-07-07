import { describe, it, expect, jest } from "@jest/globals";
import { EvernoteAPI } from "../../src/evernote-api.js";

// Build an EvernoteAPI over a fake NoteStore with the note cache enabled. The
// RPC auto-retry is disabled so error paths stay deterministic.
function makeApi(noteStore: any, clock: () => number = () => 1000) {
  const client = { getNoteStore: () => noteStore };
  return new EvernoteAPI(
    client as any,
    { noteStoreUrl: "https://x/notestore" } as any,
    {
      rateLimitAutoRetrySeconds: 0,
      noteCache: { maxEntries: 50, syncTtlMs: 30000, now: clock },
    },
  );
}

const noteFixture = (guid: string, usn = 1) => ({
  guid,
  title: `T-${guid}`,
  updateSequenceNum: usn,
  notebookGuid: "nb1",
  content: `<en-note><div>${guid}</div></en-note>`,
});

describe("EvernoteAPI note cache", () => {
  it("serves a repeat read from cache without a second getNote", async () => {
    const getNote = jest.fn(async (guid: string) => noteFixture(guid));
    const getSyncState = jest.fn(async () => ({ updateCount: 10 }));
    const api = makeApi({
      getNote,
      getSyncState,
      getFilteredSyncChunk: jest.fn(),
    });

    const first = await api.getNoteCached("g1", { withResources: false });
    const second = await api.getNoteCached("g1", { withResources: false });

    expect(first.guid).toBe("g1");
    expect(second.guid).toBe("g1");
    expect(getNote).toHaveBeenCalledTimes(1);
    // One sync probe seeds the cursor; the second read is inside the TTL.
    expect(getSyncState).toHaveBeenCalledTimes(1);
  });

  it("refetches after an update evicts the cached body", async () => {
    const getNote = jest.fn(async (guid: string) => noteFixture(guid));
    const getSyncState = jest.fn(async () => ({ updateCount: 10 }));
    const updateNote = jest.fn(async () => ({ guid: "g1" }));
    const api = makeApi({
      getNote,
      getSyncState,
      getFilteredSyncChunk: jest.fn(),
      updateNote,
    });

    await api.getNoteCached("g1", { withResources: false });
    await api.updateNote({ guid: "g1", content: "x" });
    await api.getNoteCached("g1", { withResources: false });

    expect(getNote).toHaveBeenCalledTimes(2);
  });

  it("evicts a deleted note from the cache", async () => {
    const getNote = jest.fn(async (guid: string) => noteFixture(guid));
    const getSyncState = jest.fn(async () => ({ updateCount: 10 }));
    const deleteNote = jest.fn(async () => undefined);
    const api = makeApi({
      getNote,
      getSyncState,
      getFilteredSyncChunk: jest.fn(),
      deleteNote,
    });

    await api.getNoteCached("g1", { withResources: false });
    await api.deleteNote("g1");
    await api.getNoteCached("g1", { withResources: false });

    expect(getNote).toHaveBeenCalledTimes(2);
  });

  it("reuses cached bodies across getNotesBatch calls", async () => {
    const getNote = jest.fn(async (guid: string) => noteFixture(guid));
    const getSyncState = jest.fn(async () => ({ updateCount: 10 }));
    const api = makeApi({
      getNote,
      getSyncState,
      getFilteredSyncChunk: jest.fn(),
    });

    await api.getNotesBatch(["g1", "g2"], {
      includeContent: true,
      format: "text",
    });
    await api.getNotesBatch(["g1", "g2"], {
      includeContent: true,
      format: "text",
    });

    // Second batch is fully served from cache.
    expect(getNote).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when freshness probes fail past the TTL", async () => {
    let now = 1000;
    let mode: "ok" | "fail" = "ok";
    const getNote = jest.fn(async (guid: string) => noteFixture(guid));
    const getSyncState = jest.fn(async () => {
      if (mode === "fail") {
        throw new Error("network");
      }
      return { updateCount: 10 };
    });
    const api = makeApi(
      { getNote, getSyncState, getFilteredSyncChunk: jest.fn() },
      () => now,
    );

    await api.getNoteCached("g1", { withResources: false }); // probe ok → caches
    await api.getNoteCached("g1", { withResources: false }); // within TTL → hit
    expect(getNote).toHaveBeenCalledTimes(1);

    // Probes now fail; advance past the TTL so the cache can't be verified fresh.
    mode = "fail";
    now += 60000;
    await api.getNoteCached("g1", { withResources: false }); // unverifiable → getNote
    expect(getNote).toHaveBeenCalledTimes(2);
  });

  it("disables the cache when the NoteStore lacks sync methods", async () => {
    const getNote = jest.fn(async (guid: string) => noteFixture(guid));
    // No getSyncState / getFilteredSyncChunk — a partial store.
    const client = { getNoteStore: () => ({ getNote }) };
    const api = new EvernoteAPI(
      client as any,
      { noteStoreUrl: "https://x/notestore" } as any,
      { rateLimitAutoRetrySeconds: 0, noteCache: { maxEntries: 50 } },
    );

    await api.getNoteCached("g1", { withResources: false });
    await api.getNoteCached("g1", { withResources: false });

    // Cache disabled → every read hits getNote (and no getSyncState call is made).
    expect(getNote).toHaveBeenCalledTimes(2);
  });

  it("re-fetches a stripped PDF resource body during extraction (cache-hit path)", async () => {
    // On a cache hit the resource body is stripped, so the single-note handler
    // passes a body-less PDF resource as `prefetched`. Extraction must re-fetch
    // the body live rather than give up and return the fallback.
    const getResource = jest.fn(async (..._args: any[]) => ({
      guid: "r1",
      mime: "application/pdf",
      data: { size: 100, bodyHash: Buffer.from("h") },
    }));
    const api = makeApi({
      getNote: jest.fn(),
      getResource,
      getResourceRecognition: jest.fn(async () => null),
      getSyncState: jest.fn(async () => ({ updateCount: 1 })),
      getFilteredSyncChunk: jest.fn(),
    });

    const strippedPdf = {
      guid: "r1",
      mime: "application/pdf",
      data: { size: 100, bodyHash: Buffer.from("h") }, // body already stripped
    };
    await api.extractResourceText("r1", strippedPdf);

    // getResource(guid, withData=true, ...) — the live re-fetch of the body.
    expect(getResource).toHaveBeenCalledWith("r1", true, false, false, false);
  });

  it("re-fetches a multi-PDF note in one getNote on repeat attachment reads", async () => {
    const pdfNote = (guid: string) => ({
      ...noteFixture(guid),
      resources: [
        {
          guid: "p1",
          mime: "application/pdf",
          data: {
            size: 10,
            bodyHash: Buffer.from("a"),
            body: Buffer.from("x"),
          },
        },
        {
          guid: "p2",
          mime: "application/pdf",
          data: {
            size: 10,
            bodyHash: Buffer.from("b"),
            body: Buffer.from("y"),
          },
        },
      ],
    });
    const getNote = jest.fn(async (guid: string) => pdfNote(guid));
    const getResource = jest.fn(async (..._a: any[]) => ({
      mime: "application/pdf",
      data: { size: 10 },
    }));
    const getSyncState = jest.fn(async () => ({ updateCount: 10 }));
    const api = makeApi({
      getNote,
      getResource,
      getSyncState,
      getFilteredSyncChunk: jest.fn(),
    });

    // First attachment-text read fetches + caches (bodies stripped).
    await api.getNoteCached("g1", { withResources: true });
    // Repeat attachment-text read: PDFs present → re-fetch the note once (bodies
    // inline) rather than a per-PDF getResource storm.
    const second = await api.getNoteCached("g1", { withResources: true });

    expect(getNote).toHaveBeenCalledTimes(2); // one getNote per attachment read
    expect(second.resources[0].data.body).toBeDefined(); // inline bodies, no getResource needed
  });

  it("still serves image-only notes from cache on attachment reads", async () => {
    const imageNote = (guid: string) => ({
      ...noteFixture(guid),
      resources: [
        {
          guid: "i1",
          mime: "image/png",
          data: { size: 10, bodyHash: Buffer.from("a") },
        },
      ],
    });
    const getNote = jest.fn(async (guid: string) => imageNote(guid));
    const getSyncState = jest.fn(async () => ({ updateCount: 10 }));
    const api = makeApi({
      getNote,
      getSyncState,
      getFilteredSyncChunk: jest.fn(),
    });

    await api.getNoteCached("g1", { withResources: true });
    await api.getNoteCached("g1", { withResources: true });

    // Images use recognition (fetched separately), so the note itself is served
    // from cache — the getNote isn't repeated.
    expect(getNote).toHaveBeenCalledTimes(1);
  });

  it("re-fetches a batch note when a caller-known USN is newer than the cached body", async () => {
    let calls = 0;
    const getNote = jest.fn(async (guid: string) => {
      calls += 1;
      return noteFixture(guid, calls === 1 ? 5 : 9);
    });
    const getSyncState = jest.fn(async () => ({ updateCount: 10 }));
    const api = makeApi({
      getNote,
      getSyncState,
      getFilteredSyncChunk: jest.fn(),
    });

    // Prime the cache at USN 5.
    await api.getNotesBatch(["g1"], { includeContent: true, format: "text" });
    // A later search read knows g1 is now at USN 9 → the USN-5 body is evicted
    // and re-fetched rather than served stale alongside fresh metadata.
    await api.getNotesBatch(["g1"], {
      includeContent: true,
      format: "text",
      knownUsns: new Map([["g1", 9]]),
    });

    expect(getNote).toHaveBeenCalledTimes(2);
  });

  it("drops a cached note after an external edit is detected via sync", async () => {
    let now = 1000;
    let updateCount = 10;
    const getNote = jest.fn(async (guid: string) => noteFixture(guid, 5));
    const getSyncState = jest.fn(async () => ({ updateCount }));
    const getFilteredSyncChunk = jest.fn(async () => ({
      chunkHighUSN: updateCount,
      notes: [{ guid: "g1", updateSequenceNum: 12 }],
    }));
    const api = makeApi(
      { getNote, getSyncState, getFilteredSyncChunk },
      () => now,
    );

    await api.getNoteCached("g1", { withResources: false }); // seed 10, cache g1@5
    now += 30000;
    updateCount = 15;
    await api.getNoteCached("g1", { withResources: false }); // walk evicts g1 → refetch

    expect(getFilteredSyncChunk).toHaveBeenCalled();
    expect(getNote).toHaveBeenCalledTimes(2);
  });
});
