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
async function withServer(errorCode, run) {
  const dir = await mkdtemp(join(tmpdir(), "evernote-connection-"));
  const preload = join(dir, "evernote.cjs");
  await writeFile(
    preload,
    `
const Evernote = require(${JSON.stringify(require.resolve("evernote"))});
const reject = async () => { throw {errorCode: ${errorCode}, parameter: 'authenticationToken'}; };
Evernote.Client = class {
  getUserStore() { return {getUser: ${errorCode ? "reject" : 'async () => ({id: 1, username: "test"})'}}; }
  getNoteStore() { return {listNotebooks: async () => [], findNotesMetadata: reject}; }
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
