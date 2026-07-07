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
