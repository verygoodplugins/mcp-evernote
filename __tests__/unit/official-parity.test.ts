import { describe, it, expect, jest } from "@jest/globals";
import { EvernoteAPI, RESOURCE_SIZE_MAX_BYTES } from "../../src/evernote-api.js";

function makeApi(noteStore: any) {
  const client = { getNoteStore: () => noteStore };
  return new EvernoteAPI(
    client as any,
    { noteStoreUrl: "https://x/notestore" } as any,
    { rateLimitAutoRetrySeconds: 0, sleep: async () => {}, noteCache: { maxEntries: 0 } },
  );
}

const note = (overrides: Record<string, unknown> = {}) => ({
  guid: "n1",
  title: "Invoice",
  notebookGuid: "nb-old",
  tagGuids: ["t-keep"],
  active: true,
  ...overrides,
});

describe("official MCP parity — EvernoteAPI", () => {
  describe("deleteNote and restoreNote", () => {
    it("deleteNote uses NoteStore.deleteNote (trash) and does not expunge", async () => {
      const deleteNote = jest.fn(async () => 10);
      const expungeNote = jest.fn(async () => 11);
      const api = makeApi({ deleteNote, expungeNote });
      await api.deleteNote("n1");
      expect(deleteNote).toHaveBeenCalledWith("n1");
      expect(expungeNote).not.toHaveBeenCalled();
    });

    it("restoreNote sets active=true on a trashed note", async () => {
      const getNote = jest.fn(async () =>
        note({ active: false, deleted: 123 }),
      );
      const updateNote = jest.fn(async (n: any) => n);
      const api = makeApi({ getNote, updateNote });
      const restored = await api.restoreNote("n1");
      expect(getNote).toHaveBeenCalledWith("n1", false, false, false, false);
      expect(updateNote).toHaveBeenCalledWith(
        expect.objectContaining({ guid: "n1", title: "Invoice", active: true }),
      );
      const payload = updateNote.mock.calls[0][0] as any;
      expect(payload.content).toBeUndefined();
      expect(payload.resources).toBeUndefined();
      expect(restored.active).toBe(true);
    });

    it("restoreNote rejects a note that is not in the trash", async () => {
      const api = makeApi({
        getNote: jest.fn(async () => note({ active: true })),
        updateNote: jest.fn(),
      });
      await expect(api.restoreNote("n1")).rejects.toThrow(/not in the trash/);
    });
  });

  describe("updateNotesMetadata (move + additive tags)", () => {
    it("moves notes to a notebook without sending content or resources", async () => {
      const getNote = jest.fn(async (guid: string) => note({ guid }));
      const updateNote = jest.fn(async (n: any) => n);
      const api = makeApi({ getNote, updateNote });

      const result = await api.updateNotesMetadata({
        guids: ["n1", "n2"],
        notebookGuid: "nb-new",
      });

      expect(result.updated).toHaveLength(2);
      expect(result.failed).toEqual([]);
      expect(updateNote).toHaveBeenCalledTimes(2);
      for (const [payload] of updateNote.mock.calls as unknown as [any][]) {
        expect(payload.notebookGuid).toBe("nb-new");
        expect(payload.content).toBeUndefined();
        expect(payload.resources).toBeUndefined();
        expect(payload.title).toBe("Invoice");
      }
    });

    it("adds and removes tags without replacing the others", async () => {
      const getNote = jest.fn(async () => note({ tagGuids: ["t-keep", "t-old"] }));
      const updateNote = jest.fn(async (n: any) => n);
      const listTags = jest.fn(async () => [
        { guid: "t-keep", name: "keep" },
        { guid: "t-old", name: "old" },
        { guid: "t-new", name: "urgent" },
      ]);
      const api = makeApi({ getNote, updateNote, listTags });

      const result = await api.updateNotesMetadata({
        guids: ["n1"],
        addTags: ["urgent"],
        removeTags: ["old"],
      });

      expect(result.failed).toEqual([]);
      const payload = updateNote.mock.calls[0][0] as any;
      expect(payload.tagGuids).toEqual(["t-keep", "t-new"]);
    });

    it("creates a missing addTags name", async () => {
      const getNote = jest.fn(async () => note({ tagGuids: ["t-keep"] }));
      const updateNote = jest.fn(async (n: any) => n);
      const listTags = jest.fn(async () => [
        { guid: "t-keep", name: "keep" },
      ]);
      const createTag = jest.fn(async (tag: any) => ({
        guid: "t-created",
        name: tag.name,
      }));
      const api = makeApi({ getNote, updateNote, listTags, createTag });

      await api.updateNotesMetadata({
        guids: ["n1"],
        addTags: ["brand-new"],
      });

      expect(createTag).toHaveBeenCalled();
      const payload = updateNote.mock.calls[0][0] as any;
      expect(payload.tagGuids).toEqual(["t-keep", "t-created"]);
    });

    it("collects per-note failures and continues the batch", async () => {
      const getNote = jest.fn(async (guid: string) => {
        if (guid === "bad") throw new Error("boom");
        return note({ guid });
      });
      const updateNote = jest.fn(async (n: any) => n);
      const api = makeApi({ getNote, updateNote });

      const result = await api.updateNotesMetadata({
        guids: ["n1", "bad", "n3"],
        notebookGuid: "nb-new",
      });

      expect(result.updated.map((u) => u.guid)).toEqual(["n1", "n3"]);
      expect(result.failed).toEqual([{ guid: "bad", error: "boom" }]);
    });

    it("aborts a batch on a structured rate-limit error and keeps remaining guids", async () => {
      const getNote = jest.fn(async (guid: string) => note({ guid }));
      const rateLimit = Object.assign(new Error("rate limited"), {
        errorCode: 19,
        rateLimitDuration: 60,
      });
      const updateNote = jest.fn(async (n: any) => {
        if (n.guid === "n2") throw rateLimit;
        return n;
      });
      const api = makeApi({ getNote, updateNote });

      const result = await api.updateNotesMetadata({
        guids: ["n1", "n2", "n3"],
        notebookGuid: "nb-new",
      });

      expect(result.updated.map((u) => u.guid)).toEqual(["n1"]);
      expect(result.failed).toEqual([]);
      expect(result.aborted).toEqual({
        reason: "rate_limited",
        retryAfterSeconds: 60,
        remainingGuids: ["n2", "n3"],
      });
      expect(updateNote).toHaveBeenCalledTimes(2);
    });

    it("records an edit-lock (code 19 without duration) and continues the batch", async () => {
      const getNote = jest.fn(async (guid: string) => note({ guid }));
      const editLock = Object.assign(new Error("edit lock"), {
        errorCode: 19,
      });
      const updateNote = jest.fn(async (n: any) => {
        if (n.guid === "n2") throw editLock;
        return n;
      });
      const api = makeApi({ getNote, updateNote });

      const result = await api.updateNotesMetadata({
        guids: ["n1", "n2", "n3"],
        notebookGuid: "nb-new",
      });

      expect(result.updated.map((u) => u.guid)).toEqual(["n1", "n3"]);
      expect(result.failed).toEqual([
        expect.objectContaining({ guid: "n2", errorCode: 19 }),
      ]);
      expect(result.aborted).toBeUndefined();
    });

    it("rejects a tag that is both added and removed", async () => {
      const api = makeApi({
        getNote: jest.fn(async () => note()),
        listTags: jest.fn(async () => [{ guid: "t1", name: "urgent" }]),
      });
      await expect(
        api.updateNotesMetadata({
          guids: ["n1"],
          addTags: ["urgent"],
          removeTags: ["urgent"],
        }),
      ).rejects.toThrow(/cannot be both added and removed/);
    });
  });

  describe("addResourceToNoteFromBytes", () => {
    it("attaches a buffer and appends en-media without requiring a file path", async () => {
      const getNote = jest.fn(async () => ({
        guid: "n1",
        title: "Invoice",
        content: "<?xml?><en-note>body</en-note>",
        resources: [],
      }));
      const updateNote = jest.fn(async (n: any) => n);
      const api = makeApi({ getNote, updateNote });

      const body = Buffer.from("hello");
      await api.addResourceToNoteFromBytes(
        "n1",
        body,
        "hello.txt",
        "text/plain",
      );

      expect(getNote).toHaveBeenCalledWith("n1", true, true, false, false);
      const updated = updateNote.mock.calls[0][0] as any;
      expect(updated.resources).toHaveLength(1);
      expect(updated.resources[0].mime).toBe("text/plain");
      expect(updated.resources[0].attributes.fileName).toBe("hello.txt");
      expect(updated.content).toContain("en-media");
      expect(updated.content).toContain('type="text/plain"');
    });

    it("rejects an attachment over the 200 MiB EDAM cap", async () => {
      const api = makeApi({
        getNote: jest.fn(),
        updateNote: jest.fn(),
      });
      const tooBig = { length: RESOURCE_SIZE_MAX_BYTES + 1 } as Buffer;
      await expect(
        api.addResourceToNoteFromBytes("n1", tooBig, "huge.bin"),
      ).rejects.toThrow(/200 MiB/);
    });
  });
});
