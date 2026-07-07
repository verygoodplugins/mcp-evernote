import { describe, it, expect, jest } from "@jest/globals";
import {
  EvernoteAPI,
  truncatePlainText,
} from "../../src/evernote-api.js";

// Build an EvernoteAPI whose noteStore.getNote is the supplied mock. Auto-retry
// is disabled so a rate-limit error propagates deterministically to the batch
// loop instead of being retried by the RPC limiter.
function makeApi(getNote: jest.Mock<(...args: any[]) => Promise<any>>) {
  const noteStore = { getNote };
  const client = { getNoteStore: () => noteStore };
  return new EvernoteAPI(
    client as any,
    { noteStoreUrl: "https://x/notestore" } as any,
    { rateLimitAutoRetrySeconds: 0 },
  );
}

const noteFixture = (guid: string, content?: string) => ({
  guid,
  title: `T-${guid}`,
  created: 1700000000000,
  updated: 1700000001000,
  notebookGuid: "nb1",
  tagNames: ["poem"],
  contentLength: content ? content.length : 0,
  content,
});

describe("EvernoteAPI.getNotesBatch", () => {
  it("fetches all notes with rendered content", async () => {
    const getNote = jest.fn(async (guid: string) =>
      noteFixture(guid, `<en-note><div>Hello ${guid}</div></en-note>`),
    );
    const api = makeApi(getNote);

    const res = await api.getNotesBatch(["g1", "g2"], {
      includeContent: true,
      format: "markdown",
    });

    expect(res.failed).toHaveLength(0);
    expect(res.aborted).toBeUndefined();
    expect(res.notes.map((n) => n.guid)).toEqual(["g1", "g2"]);
    expect(res.notes[0]).toMatchObject({
      guid: "g1",
      title: "T-g1",
      notebookGuid: "nb1",
      tagNames: ["poem"],
    });
    expect(res.notes[0].content).toContain("Hello g1");
  });

  it("aborts on a mid-batch rate limit and returns the remaining guids", async () => {
    const getNote = jest.fn(async (guid: string) => {
      if (guid === "g3") {
        const e: any = new Error("rate limited");
        e.errorCode = 19;
        e.rateLimitDuration = 600;
        throw e;
      }
      return noteFixture(guid, `<en-note>${guid}</en-note>`);
    });
    const api = makeApi(getNote);

    const res = await api.getNotesBatch(["g1", "g2", "g3", "g4", "g5"], {
      includeContent: true,
      format: "text",
    });

    expect(res.notes.map((n) => n.guid)).toEqual(["g1", "g2"]);
    expect(res.aborted).toEqual({
      reason: "rate_limited",
      retryAfterSeconds: 600,
      remainingGuids: ["g3", "g4", "g5"],
    });
    expect(getNote).toHaveBeenCalledTimes(3); // g1, g2, g3(fails) — stops
  });

  it("records non-rate-limit failures and keeps going", async () => {
    const getNote = jest.fn(async (guid: string) => {
      if (guid === "g2") {
        const e: any = new Error("boom");
        e.errorCode = 2;
        throw e;
      }
      return noteFixture(guid, `<en-note>${guid}</en-note>`);
    });
    const api = makeApi(getNote);

    const res = await api.getNotesBatch(["g1", "g2", "g3"], {
      includeContent: true,
      format: "markdown",
    });

    expect(res.notes.map((n) => n.guid)).toEqual(["g1", "g3"]);
    expect(res.failed).toEqual([{ guid: "g2", message: "boom", errorCode: 2 }]);
    expect(res.aborted).toBeUndefined();
  });

  it("projects content per requested format", async () => {
    const enml = "<en-note><div>Hello world</div></en-note>";
    const run = (format: "markdown" | "text" | "enml") =>
      makeApi(jest.fn(async (guid: string) => noteFixture(guid, enml))).getNotesBatch(
        ["g1"],
        { includeContent: true, format },
      );

    expect((await run("markdown")).notes[0].content).toContain("Hello world");
    expect((await run("text")).notes[0].content).toBe("Hello world");
    expect((await run("enml")).notes[0].content).toBe(enml);
  });

  it("omits content but keeps contentLength when includeContent is false", async () => {
    const getNote = jest.fn(async (guid: string, ..._rest: any[]) => ({
      ...noteFixture(guid, "<en-note>x</en-note>"),
      contentLength: 42,
    }));
    const api = makeApi(getNote);

    const res = await api.getNotesBatch(["g1"], {
      includeContent: false,
      format: "markdown",
    });

    expect(res.notes[0].content).toBeUndefined();
    expect(res.notes[0].contentLength).toBe(42);
    // getNote(guid, withContent=false, withResources=false, ...)
    expect(getNote).toHaveBeenCalledWith("g1", false, false, false, false);
  });
});

describe("truncatePlainText", () => {
  it("returns text unchanged when under the limit", () => {
    expect(truncatePlainText("short text", 300)).toBe("short text");
  });

  it("truncates with an ellipsis when over the limit", () => {
    const text = "word ".repeat(100); // 500 chars
    const out = truncatePlainText(text, 100);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(103);
    expect(out).not.toContain("wor..."); // clipped at a word boundary
  });
});
