import assert from "node:assert/strict";
import process from "node:process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercise the built MCP dispatcher; mock only the upstream Evernote API.
const require = createRequire(import.meta.url);
async function withServer(errorCode, run, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "evernote-connection-"));
  const preload = join(dir, "evernote.cjs");
  await writeFile(
    preload,
    `
const Evernote = require(${JSON.stringify(require.resolve("evernote"))});
const reject = async () => { throw {errorCode: ${errorCode}, parameter: 'authenticationToken'}; };
Evernote.Client = class {
  getUserStore() { return {getUser: ${errorCode ? "reject" : 'async () => ({id: 1, username: "test"})'}}; }
  getNoteStore() { return ${options.noteStore || "{listNotebooks: async () => [], findNotesMetadata: reject}"}; }
};
`,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--require",
      preload,
      process.env.EVERNOTE_TEST_ENTRY || resolve("dist/index.js"),
    ],
    cwd: dir,
    env: {
      EVERNOTE_CONSUMER_KEY: "test-key",
      EVERNOTE_CONSUMER_SECRET: "test-secret",
      EVERNOTE_ACCESS_TOKEN: "test-token",
      EVERNOTE_NOTESTORE_URL: "https://example.com/notestore",
      EVERNOTE_POLLING_ENABLED: "false",
      ...options.env,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client(
    { name: "connection-regression", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const call = (client, name, args) => client.callTool({ name, arguments: args });
const body = (result) => JSON.parse(result.content[0].text);

for (const errorCode of [8, 9]) {
  test(`auth ${errorCode}: cold/warm status, reconnect and search preserve API rejection`, async () => {
    await withServer(errorCode, async (client) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = body(
          await call(client, "evernote_connection", {
            action: "status",
            verbose: true,
          }),
        );
        assert.equal(result.status, "needs_auth");
        assert.equal(result.authentication.errorCode, errorCode);
        assert.ok(
          result.authentication.apiError.includes("authenticationToken"),
        );
      }
      const reconnect = await call(client, "evernote_connection", {
        action: "reconnect",
      });
      assert.equal(reconnect.isError, true);
      assert.equal(body(reconnect).errorCode, errorCode);
      const search = await call(client, "evernote_search_notes", {
        query: "test",
      });
      assert.equal(search.isError, true);
      assert.equal(body(search).errorCode, errorCode);
      assert.ok(!search.content[0].text.includes("restored"));
    });
  });
}

test("valid credentials: cold status and reconnect succeed after API verification", async () => {
  await withServer(0, async (client) => {
    assert.equal(
      body(await call(client, "evernote_connection", { action: "status" }))
        .status,
      "healthy",
    );
    const result = await call(client, "evernote_connection", {
      action: "reconnect",
    });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /Successfully reconnected/);
  });
});

// Guardrail regressions through the real dispatcher (ListTools + CallTool).
const guardNoteStore = `{
  listNotebooks: async () => [
    {guid: "nb1", name: "Meetings", defaultNotebook: true},
    {guid: "nb2", name: "Music"},
  ],
  createNotebook: async (nb) => ({...nb, guid: "nb-new"}),
  listTags: async () => ["todo", "to-do", "WP Fusion", "wp-fusion", "autojack"].map(
    (name, i) => ({guid: "t" + i, name}),
  ),
  createNote: async (n) => ({...n, guid: "n-new"}),
  findNotesMetadata: async () => ({totalNotes: 0, notes: []}),
}`;

test("destructive tools are hidden and refused unless EVERNOTE_ENABLE_DESTRUCTIVE=true", async () => {
  await withServer(
    0,
    async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      assert.ok(!names.includes("evernote_delete_note"));
      assert.ok(!names.includes("evernote_revoke_auth"));
      const connection = tools.find((t) => t.name === "evernote_connection");
      assert.deepEqual(connection.inputSchema.properties.action.enum, [
        "status",
        "user",
        "reconnect",
      ]);
      assert.equal(connection.annotations.destructiveHint, false);

      for (const [name, args] of [
        ["evernote_delete_note", { guid: "n1" }],
        ["evernote_revoke_auth", {}],
        ["evernote_connection", { action: "revoke" }],
      ]) {
        const result = await call(client, name, args);
        assert.equal(result.isError, true, name);
        assert.match(result.content[0].text, /EVERNOTE_ENABLE_DESTRUCTIVE=true/);
      }
    },
    { noteStore: guardNoteStore },
  );
});

test("destructive tools are advertised when EVERNOTE_ENABLE_DESTRUCTIVE=true", async () => {
  await withServer(
    0,
    async (client) => {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "evernote_delete_note"));
      const connection = tools.find((t) => t.name === "evernote_connection");
      assert.ok(connection.inputSchema.properties.action.enum.includes("revoke"));
      assert.equal(connection.annotations.destructiveHint, true);
    },
    { noteStore: guardNoteStore, env: { EVERNOTE_ENABLE_DESTRUCTIVE: "true" } },
  );
});

test("unknown notebook names are rejected with close matches unless createNotebook is true", async () => {
  await withServer(
    0,
    async (client) => {
      const typo = await call(client, "evernote_create_note", {
        title: "t",
        content: "c",
        notebookName: "Meetngs",
      });
      assert.equal(typo.isError, true);
      assert.match(body(typo).message, /Notebook "Meetngs" not found\. Did you mean: "Meetings"\?/);

      const move = await call(client, "evernote_update_note", {
        guids: ["a", "b"],
        notebookName: "Muzic",
      });
      assert.equal(move.isError, true);
      assert.match(body(move).message, /Did you mean: "Music"/);

      const folded = await call(client, "evernote_create_note", {
        title: "t",
        content: "c",
        notebookName: "music",
      });
      assert.ok(!folded.isError, folded.content[0].text);
      assert.ok(!folded.content[0].text.includes("did not exist"));

      const created = await call(client, "evernote_create_note", {
        title: "t",
        content: "c",
        notebookName: "Brand New",
        createNotebook: true,
      });
      assert.ok(!created.isError, created.content[0].text);
      assert.match(created.content[0].text, /was created \(createNotebook: true\)/);
    },
    { noteStore: guardNoteStore },
  );
});

test("list_tags pages and filters, and stays a plain array without paging params", async () => {
  await withServer(
    0,
    async (client) => {
      const all = body(await call(client, "evernote_list_tags", {}));
      assert.ok(Array.isArray(all));
      assert.equal(all.length, 5);

      const filtered = body(await call(client, "evernote_list_tags", { query: "WP" }));
      assert.equal(filtered.total, 2);
      assert.deepEqual(filtered.tags.map((t) => t.name), ["WP Fusion", "wp-fusion"]);

      const page = body(await call(client, "evernote_list_tags", { limit: 2, offset: 2 }));
      assert.equal(page.total, 5);
      assert.equal(page.returned, 2);
      assert.equal(page.nextOffset, 4);
    },
    { noteStore: guardNoteStore },
  );
});
