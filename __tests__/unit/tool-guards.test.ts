import { describe, it, expect } from "@jest/globals";
import {
  applyDestructiveGate,
  closeMatches,
  destructiveCallError,
  DESTRUCTIVE_ENV_FLAG,
  findNotebookByName,
  isDestructiveEnabled,
  pageTags,
  unknownNotebookMessage,
  wantsTagPage,
} from "../../src/tool-guards.js";

const tool = (name: string, extra: Record<string, unknown> = {}) =>
  ({
    name,
    description: `${name} description`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: { type: "object", properties: {} },
    ...extra,
  }) as any;

const connection = tool("evernote_connection", {
  description: 'Manage the connection. "revoke" clears the stored auth token.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["status", "user", "reconnect", "revoke"] },
      verbose: { type: "boolean" },
    },
    required: ["action"],
  },
});

const surface = [
  tool("evernote_get_note"),
  tool("evernote_delete_note", { annotations: { readOnlyHint: false, destructiveHint: true } }),
  connection,
  tool("evernote_revoke_auth", { annotations: { readOnlyHint: false, destructiveHint: true } }),
];

describe("destructive gate", () => {
  it("reads the env flag strictly", () => {
    expect(DESTRUCTIVE_ENV_FLAG).toBe("EVERNOTE_ENABLE_DESTRUCTIVE");
    expect(isDestructiveEnabled({})).toBe(false);
    expect(isDestructiveEnabled({ EVERNOTE_ENABLE_DESTRUCTIVE: "1" })).toBe(false);
    expect(isDestructiveEnabled({ EVERNOTE_ENABLE_DESTRUCTIVE: "true" })).toBe(true);
  });

  it("hides delete_note, revoke_auth, and the revoke action by default", () => {
    const gated = applyDestructiveGate(surface, false);
    expect(gated.map((t) => t.name)).toEqual(["evernote_get_note", "evernote_connection"]);
    const conn = gated.find((t) => t.name === "evernote_connection")!;
    expect((conn.inputSchema as any).properties.action.enum).toEqual([
      "status",
      "user",
      "reconnect",
    ]);
    expect(conn.description).not.toMatch(/revoke/);
    expect(conn.description!.length).toBeLessThanOrEqual(300);
    // Without revoke nothing on the connection tool destroys data.
    expect(conn.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // The original declarations are not mutated.
    expect((connection.inputSchema as any).properties.action.enum).toContain("revoke");
    expect(connection.annotations.destructiveHint).toBe(true);
  });

  it("advertises the full surface when enabled", () => {
    expect(applyDestructiveGate(surface, true)).toBe(surface);
  });

  it("blocks destructive calls (including aliases) unless enabled", () => {
    expect(destructiveCallError("evernote_delete_note", { guid: "n1" }, false)).toMatch(
      /evernote_delete_note is disabled\. Set EVERNOTE_ENABLE_DESTRUCTIVE=true/,
    );
    expect(
      destructiveCallError("evernote_connection", { action: "revoke" }, false, "evernote_revoke_auth"),
    ).toMatch(/evernote_revoke_auth action:"revoke" is disabled/);
    expect(destructiveCallError("evernote_connection", { action: "status" }, false)).toBeNull();
    expect(destructiveCallError("evernote_get_note", { guid: "n1" }, false)).toBeNull();
    expect(destructiveCallError("evernote_connection", undefined, false)).toBeNull();
    expect(destructiveCallError("evernote_delete_note", { guid: "n1" }, true)).toBeNull();
    expect(destructiveCallError("evernote_connection", { action: "revoke" }, true)).toBeNull();
  });
});

describe("notebook resolution", () => {
  const notebooks = [
    { guid: "g1", name: "Music" },
    { guid: "g2", name: "Mastermind Notes" },
    { guid: "g3", name: "Meetings" },
    { guid: "g4", name: "Finance" },
  ];

  it("matches exact names, then a unique case-insensitive name", () => {
    expect(findNotebookByName(notebooks, "Music").notebook?.guid).toBe("g1");
    expect(findNotebookByName(notebooks, "finance").notebook?.guid).toBe("g4");
  });

  it("returns close matches for a typo instead of a notebook", () => {
    const result = findNotebookByName(notebooks, "Meetngs");
    expect(result.notebook).toBeUndefined();
    expect(result.suggestions).toEqual(["Meetings"]);
    expect(findNotebookByName(notebooks, "mastermind").suggestions).toEqual(["Mastermind Notes"]);
    expect(findNotebookByName(notebooks, "Zzzzzzzz").suggestions).toEqual([]);
  });

  it("caps and orders suggestions", () => {
    const many = Array.from({ length: 10 }, (_, i) => `Work ${i}`);
    expect(closeMatches("work", many)).toHaveLength(5);
    expect(closeMatches("Musik", ["Music", "Musicals", "Taxes"])[0]).toBe("Music");
  });

  it("builds an actionable error message", () => {
    expect(unknownNotebookMessage("Meetngs", ["Meetings"])).toBe(
      'Notebook "Meetngs" not found. Did you mean: "Meetings"? Pass createNotebook: true to create it, or use evernote_list_notebooks to see existing names.',
    );
    expect(unknownNotebookMessage("X", [])).not.toMatch(/Did you mean/);
  });
});

describe("tag paging", () => {
  const tags = ["todo", "to-do", "WP Fusion", "wp-fusion", "taxes2026", "autojack"].map(
    (name, i) => ({ guid: `t${i}`, name }),
  );

  it("only switches to the paged shape when a paging param is present", () => {
    expect(wantsTagPage({})).toBe(false);
    expect(wantsTagPage({ query: "x" })).toBe(true);
    expect(wantsTagPage({ limit: 5 })).toBe(true);
    expect(wantsTagPage({ offset: 0 })).toBe(true);
  });

  it("filters case-insensitively and reports the filtered total", () => {
    const page = pageTags(tags, { query: "wp" });
    expect(page.total).toBe(2);
    expect(page.tags.map((t) => t.name)).toEqual(["WP Fusion", "wp-fusion"]);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeUndefined();
  });

  it("pages with limit/offset and nextOffset", () => {
    const first = pageTags(tags, { limit: 4 });
    expect(first).toMatchObject({ total: 6, offset: 0, limit: 4, returned: 4, hasMore: true, nextOffset: 4 });
    const second = pageTags(tags, { limit: 4, offset: first.nextOffset });
    expect(second).toMatchObject({ total: 6, offset: 4, returned: 2, hasMore: false });
    expect([...first.tags, ...second.tags].map((t) => t.guid).sort()).toEqual(
      tags.map((t) => t.guid).sort(),
    );
  });

  it("returns everything from offset when no limit is given", () => {
    expect(pageTags(tags, { offset: 2 }).returned).toBe(4);
    expect(pageTags(tags, { offset: 99 })).toMatchObject({ total: 6, returned: 0, hasMore: false });
  });
});
