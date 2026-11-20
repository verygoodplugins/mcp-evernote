import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  authenticateCaller,
  parseCallerKeys,
  resolveHttpConfig,
  startHttpServer,
  RunningHttpServer,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE,
} from "../../src/http-server.js";

describe("parseCallerKeys", () => {
  it("parses name:key pairs, splitting on the first colon", () => {
    expect(parseCallerKeys("hub:abc, cursor:def:ghi ,")).toEqual([
      { name: "hub", key: "abc" },
      { name: "cursor", key: "def:ghi" },
    ]);
  });

  it("names bare keys caller-<n> and ignores empties", () => {
    expect(parseCallerKeys("tok1,,hub:")).toEqual([{ name: "caller-1", key: "tok1" }]);
    expect(parseCallerKeys(undefined)).toEqual([]);
  });
});

describe("resolveHttpConfig", () => {
  it("defaults to 127.0.0.1 and the default port", () => {
    const config = resolveHttpConfig({ EVERNOTE_HTTP_CALLER_KEYS: "hub:k" });
    expect(config).toMatchObject({
      host: DEFAULT_HTTP_HOST,
      port: DEFAULT_HTTP_PORT,
      allowUnauthenticated: false,
      callerKeys: [{ name: "hub", key: "k" }],
    });
    expect(DEFAULT_HTTP_HOST).toBe("127.0.0.1");
  });

  it("requires caller keys unless explicitly opted out", () => {
    expect(() => resolveHttpConfig({})).toThrow(/EVERNOTE_HTTP_CALLER_KEYS/);
  });

  it("allows unauthenticated only on loopback", () => {
    expect(
      resolveHttpConfig({ EVERNOTE_HTTP_ALLOW_UNAUTHENTICATED: "true" }).allowUnauthenticated,
    ).toBe(true);
    expect(() =>
      resolveHttpConfig({
        EVERNOTE_HTTP_ALLOW_UNAUTHENTICATED: "true",
        EVERNOTE_HTTP_HOST: "0.0.0.0",
      }),
    ).toThrow(/non-loopback/);
  });

  it("keys win over the unauthenticated flag", () => {
    const config = resolveHttpConfig({
      EVERNOTE_HTTP_CALLER_KEYS: "hub:k",
      EVERNOTE_HTTP_ALLOW_UNAUTHENTICATED: "true",
    });
    expect(config.allowUnauthenticated).toBe(false);
  });

  it("rejects an invalid port", () => {
    expect(() =>
      resolveHttpConfig({ EVERNOTE_HTTP_CALLER_KEYS: "k", EVERNOTE_HTTP_PORT: "abc" }),
    ).toThrow(/EVERNOTE_HTTP_PORT/);
  });
});

describe("authenticateCaller", () => {
  const keys = parseCallerKeys("hub:secret-1,cursor:secret-2");

  it("matches a Bearer key to its caller", () => {
    expect(authenticateCaller("Bearer secret-2", keys)?.name).toBe("cursor");
    expect(authenticateCaller("bearer   secret-1 ", keys)?.name).toBe("hub");
  });

  it("rejects missing, malformed, or unknown keys", () => {
    expect(authenticateCaller(undefined, keys)).toBeNull();
    expect(authenticateCaller("secret-1", keys)).toBeNull();
    expect(authenticateCaller("Basic secret-1", keys)).toBeNull();
    expect(authenticateCaller("Bearer secret-", keys)).toBeNull();
    expect(authenticateCaller("Bearer secret-1", [])).toBeNull();
    expect(authenticateCaller("Bearer", keys)).toBeNull();
    expect(authenticateCaller("Bearer   ", keys)).toBeNull();
    expect(authenticateCaller("Bearersecret-1", keys)).toBeNull();
    expect(authenticateCaller(`Bearer ${"x".repeat(5000)}`, keys)).toBeNull();
  });

  it("accepts a tab separator", () => {
    expect(authenticateCaller("Bearer\tsecret-1", keys)?.name).toBe("hub");
  });

  it("parses pathological whitespace in linear time (no ReDoS)", () => {
    const hostile = `bearer ${" ".repeat(4000)}x`;
    const started = Date.now();
    for (let i = 0; i < 50; i++) {
      authenticateCaller(hostile, keys);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("resolveHttpConfig rate limit", () => {
  const base = { EVERNOTE_HTTP_CALLER_KEYS: "hub:k" };

  it("defaults to DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE", () => {
    expect(resolveHttpConfig(base).rateLimitPerMinute).toBe(DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE);
  });

  it("reads EVERNOTE_HTTP_RATE_LIMIT_PER_MINUTE", () => {
    expect(
      resolveHttpConfig({ ...base, EVERNOTE_HTTP_RATE_LIMIT_PER_MINUTE: "30" }).rateLimitPerMinute,
    ).toBe(30);
  });
});

describe("HTTP rate limiting", () => {
  it("returns 429 per caller once the per-minute limit is hit", async () => {
    const running = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      callerKeys: parseCallerKeys("hub:hub-key,cursor:cursor-key"),
      allowUnauthenticated: false,
      sessionIdleMs: 60_000,
      maxSessions: 4,
      rateLimitPerMinute: 2,
      createServer: () => new Server({ name: "stub", version: "0.0.0" }, { capabilities: {} }),
      getMetrics: () => ({}),
      logger: () => {},
    });
    try {
      const metrics = running.url.replace(/\/mcp$/, "/metrics");
      const get = (key: string) => fetch(metrics, { headers: { authorization: `Bearer ${key}` } });
      expect((await get("hub-key")).status).toBe(200);
      expect((await get("hub-key")).status).toBe(200);
      const limited = await get("hub-key");
      expect(limited.status).toBe(429);
      expect((await limited.json()).error.message).toMatch(/Too many requests/);
      // Header variants of the same key share the caller's bucket.
      const variant = await fetch(metrics, { headers: { authorization: "bearer   hub-key " } });
      expect(variant.status).toBe(429);
      // A different caller has its own bucket.
      expect((await get("cursor-key")).status).toBe(200);
      // Invalid keys share one bucket, separate from valid callers.
      expect((await get("guess-1")).status).toBe(401);
      expect((await get("guess-2")).status).toBe(401);
      expect((await get("guess-3")).status).toBe(429);
      expect((await get("cursor-key")).status).toBe(200);
    } finally {
      await running.close();
    }
  });
});

describe("HTTP app (Streamable HTTP) with a stub MCP server", () => {
  let running: RunningHttpServer;
  let base: string;
  let serversCreated = 0;

  const createServer = () => {
    serversCreated++;
    const server = new Server(
      { name: "stub", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "stub_tool", inputSchema: { type: "object" } }],
    }));
    return server;
  };

  beforeAll(async () => {
    running = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      callerKeys: parseCallerKeys("hub:hub-key,cursor:cursor-key"),
      allowUnauthenticated: false,
      sessionIdleMs: 60_000,
      maxSessions: 4,
      createServer,
      getMetrics: () => ({ queued: 0, inFlight: 0 }),
      logger: () => {},
    });
    base = running.url.replace(/\/mcp$/, "");
  });

  afterAll(async () => {
    await running?.close();
  });

  const headers = (key?: string, sessionId?: string) => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "jest", version: "0" },
    },
  };

  /** Parse a JSON or event-stream-framed JSON-RPC response body. */
  async function readRpc(res: Response): Promise<any> {
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
      return JSON.parse(data[data.length - 1]);
    }
    return JSON.parse(text);
  }

  async function openSession(key: string): Promise<string> {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify(initialize),
    });
    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await readRpc(res);
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers(key, sessionId!),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    return sessionId!;
  }

  it("serves /healthz without auth and without details", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves /health as an unauthenticated alias of /healthz", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
    expect(Object.keys(body)).toEqual(["status"]);
  });

  it("rejects /mcp without a key or with a bad key", async () => {
    const none = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(initialize),
    });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/Bearer/);

    const bad = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers("nope"),
      body: JSON.stringify(initialize),
    });
    expect(bad.status).toBe(401);
  });

  it("protects /metrics with the caller key too", async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
  });

  it("initializes a session and serves tools/list on it", async () => {
    const before = serversCreated;
    const sessionId = await openSession("hub-key");
    expect(serversCreated).toBe(before + 1); // one MCP server per session

    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers("hub-key", sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    const body = await readRpc(res);
    expect(body.result.tools.map((t: any) => t.name)).toEqual(["stub_tool"]);
  });

  it("refuses a session to a different caller", async () => {
    const sessionId = await openSession("hub-key");
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers("cursor-key", sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown session and 400 for a non-initialize without one", async () => {
    const unknown = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers("hub-key", "not-a-session"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    expect(unknown.status).toBe(404);

    const noSession = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: headers("hub-key"),
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
    });
    expect(noSession.status).toBe(400);
  });

  it("DELETE closes the session", async () => {
    const sessionId = await openSession("cursor-key");
    const count = running.sessionCount();
    const res = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: headers("cursor-key", sessionId),
    });
    expect(res.status).toBe(200);
    expect(running.sessionCount()).toBe(count - 1);
  });

  it("exposes session counts and queue metrics on /metrics", async () => {
    const res = await fetch(`${base}/metrics`, { headers: headers("hub-key") });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.queue).toEqual({ queued: 0, inFlight: 0 });
    expect(body.sessions).toMatchObject({ max: 4 });
    expect(typeof body.sessions.streamable).toBe("number");
  });

  it("rejects a foreign Host header (DNS rebinding protection on loopback)", async () => {
    const http = await import("http");
    const url = new URL(`${base}/healthz`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: { host: "evil.example.com" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});
