/**
 * Streamable HTTP transport for the Evernote MCP server.
 *
 * One long-lived process serves every local client over HTTP instead of each
 * client spawning its own stdio instance, so all callers share one Evernote
 * client, one auth session, and one request queue (src/request-queue.ts).
 *
 * Deliberately free of Evernote imports: `src/index.ts` passes in a
 * `createServer` factory (one MCP `Server` per session, all sharing the same
 * module-level API/queue state), which keeps this module unit-testable with a
 * stub server.
 *
 * Endpoints:
 * - `POST|GET|DELETE /mcp` — MCP Streamable HTTP (stateful sessions).
 * - `GET /metrics` — queue metrics + session counts (authenticated).
 * - `GET /health` — liveness only, unauthenticated, no details (`/healthz` is an alias).
 *
 * `/mcp` and `/metrics` are rate limited per authenticated caller; requests
 * with a missing or invalid key share one bucket
 * (`EVERNOTE_HTTP_RATE_LIMIT_PER_MINUTE`, default 600).
 */

import { createHash, randomUUID, timingSafeEqual } from "crypto";
import type { Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import express, { NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  hostHeaderValidation,
  localhostHostValidation,
} from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3100;
export const DEFAULT_HTTP_SESSION_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_HTTP_MAX_SESSIONS = 64;
export const DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE = 600;
/** Longest Authorization header we bother parsing. */
const MAX_AUTHORIZATION_LENGTH = 4096;
const MAX_BODY_SIZE = "10mb";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface CallerKey {
  /** Caller name, used in logs and session ownership. */
  name: string;
  key: string;
}

export interface HttpConfig {
  host: string;
  port: number;
  callerKeys: CallerKey[];
  /** Allow requests without a caller key (loopback only). */
  allowUnauthenticated: boolean;
  /** Extra Host header names to accept (DNS rebinding protection). */
  allowedHosts?: string[];
  sessionIdleMs: number;
  maxSessions: number;
  /** Requests per minute per caller on /mcp and /metrics. */
  rateLimitPerMinute?: number;
}

export interface HttpServerOptions extends HttpConfig {
  /** Build a fresh MCP server for one session. */
  createServer: () => McpServer;
  /** Extra data for GET /metrics (e.g. request-queue metrics). */
  getMetrics?: () => unknown;
  logger?: (message: string) => void;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  caller: string;
  lastSeen: number;
}

/**
 * Parse `EVERNOTE_HTTP_CALLER_KEYS`: comma-separated `name:key` pairs
 * (e.g. `hub:abc123,cursor:def456`). A bare entry without `:` becomes
 * `caller-<n>`. Splits on the FIRST colon so keys may contain colons only if a
 * name is given.
 */
export function parseCallerKeys(raw: string | undefined): CallerKey[] {
  if (!raw) {
    return [];
  }
  const keys: CallerKey[] = [];
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const colon = entry.indexOf(":");
      const name = colon > 0 ? entry.slice(0, colon).trim() : `caller-${index + 1}`;
      const key = colon > 0 ? entry.slice(colon + 1).trim() : entry;
      if (key) {
        keys.push({ name, key });
      }
    });
  return keys;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve HTTP settings from the environment. Throws on unsafe combinations:
 * no caller keys is only allowed when explicitly opted in AND bound to
 * loopback, so a misconfigured hub never exposes Evernote unauthenticated.
 */
export function resolveHttpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const host = env.EVERNOTE_HTTP_HOST?.trim() || DEFAULT_HTTP_HOST;
  const rawPort = env.EVERNOTE_HTTP_PORT;
  const port =
    rawPort === undefined || rawPort === "" ? DEFAULT_HTTP_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`EVERNOTE_HTTP_PORT must be an integer 0-65535 (got "${rawPort}")`);
  }
  const callerKeys = parseCallerKeys(env.EVERNOTE_HTTP_CALLER_KEYS);
  const allowUnauthenticated = env.EVERNOTE_HTTP_ALLOW_UNAUTHENTICATED === "true";
  if (callerKeys.length === 0) {
    if (!allowUnauthenticated) {
      throw new Error(
        "EVERNOTE_HTTP_CALLER_KEYS is required in HTTP mode (comma-separated name:key pairs). " +
          "For local testing on a loopback host only, set EVERNOTE_HTTP_ALLOW_UNAUTHENTICATED=true.",
      );
    }
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(
        `Refusing to serve unauthenticated on non-loopback host "${host}". Set EVERNOTE_HTTP_CALLER_KEYS.`,
      );
    }
  }
  const allowedHosts = env.EVERNOTE_HTTP_ALLOWED_HOSTS
    ? env.EVERNOTE_HTTP_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
    : undefined;
  return {
    host,
    port,
    callerKeys,
    allowUnauthenticated: callerKeys.length === 0 && allowUnauthenticated,
    allowedHosts,
    sessionIdleMs: parsePositiveInt(
      env.EVERNOTE_HTTP_SESSION_IDLE_MS,
      DEFAULT_HTTP_SESSION_IDLE_MS,
    ),
    maxSessions: parsePositiveInt(
      env.EVERNOTE_HTTP_MAX_SESSIONS,
      DEFAULT_HTTP_MAX_SESSIONS,
    ),
    rateLimitPerMinute: parsePositiveInt(
      env.EVERNOTE_HTTP_RATE_LIMIT_PER_MINUTE,
      DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE,
    ),
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Match an `Authorization: Bearer <key>` header against the configured keys.
 * Compares sha256 digests with timingSafeEqual so neither content nor length
 * leaks through timing. Returns the caller, or null.
 */
export function authenticateCaller(
  authorization: string | undefined,
  callerKeys: CallerKey[],
): CallerKey | null {
  // Parsed without a regex: a backtracking pattern on this header is a ReDoS
  // vector (CodeQL js/polynomial-redos).
  if (!authorization || authorization.length > MAX_AUTHORIZATION_LENGTH) {
    return null;
  }
  const header = authorization.trim();
  const scheme = header.slice(0, 6).toLowerCase();
  const separator = header.charAt(6);
  if (scheme !== "bearer" || (separator !== " " && separator !== "\t")) {
    return null;
  }
  const token = header.slice(7).trim();
  if (!token) {
    return null;
  }
  const presented = digest(token);
  let found: CallerKey | null = null;
  for (const caller of callerKeys) {
    // No early exit: every key is compared on every request.
    if (timingSafeEqual(presented, digest(caller.key)) && !found) {
      found = caller;
    }
  }
  return found;
}

function jsonRpcError(res: Response, status: number, message: string): void {
  if (res.headersSent) {
    return;
  }
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

export interface HttpApp {
  app: express.Express;
  /** Close every open MCP session. */
  closeAllSessions: () => Promise<void>;
  sessionCount: () => number;
  /** Close sessions idle longer than `sessionIdleMs`. Returns how many. */
  sweepIdleSessions: (now?: number) => Promise<number>;
}

export function createHttpApp(options: HttpServerOptions): HttpApp {
  const log = options.logger ?? ((message: string) => console.error(message));
  const sessions = new Map<string, Session>();
  const app = express();

  app.disable("x-powered-by");
  // DNS rebinding protection: browsers must not reach a loopback server via a
  // hostile domain. Explicit allow-list wins; loopback gets it automatically.
  if (options.allowedHosts?.length) {
    app.use(hostHeaderValidation(options.allowedHosts));
  } else if (LOOPBACK_HOSTS.has(options.host)) {
    app.use(localhostHostValidation());
  }

  const health = (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  };
  app.get("/health", health);
  app.get("/healthz", health);

  const requireCaller = (req: Request, res: Response, next: NextFunction) => {
    if (options.allowUnauthenticated) {
      res.locals.caller = "anonymous";
      next();
      return;
    }
    const caller = authenticateCaller(req.headers.authorization, options.callerKeys);
    if (!caller) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-evernote"');
      jsonRpcError(res, 401, "Unauthorized: missing or invalid caller key");
      return;
    }
    res.locals.caller = caller.name;
    next();
  };

  // Keyed by the authenticated caller rather than the client IP: behind the
  // hub proxy every caller shares 127.0.0.1. Resolving the caller (instead of
  // hashing the raw header) means scheme-casing/whitespace variants of the
  // same key share one bucket. Missing, malformed or unknown keys all share a
  // single "unauthenticated" bucket, so key-guessing is throttled without
  // affecting valid callers.
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: options.rateLimitPerMinute ?? DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const caller = options.allowUnauthenticated
        ? null
        : authenticateCaller(req.headers.authorization, options.callerKeys);
      return caller ? `caller:${caller.name}` : "unauthenticated";
    },
    validate: false,
    handler: (_req, res) => {
      jsonRpcError(res, 429, "Too many requests; slow down and retry");
    },
  });

  app.use(["/mcp", "/metrics"], limiter, requireCaller);
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  const closeSession = async (id: string): Promise<void> => {
    const session = sessions.get(id);
    if (!session) {
      return;
    }
    sessions.delete(id);
    try {
      await session.server.close();
    } catch (error) {
      log(`[http] error closing session ${id}: ${(error as Error).message}`);
    }
  };

  /** Look up a session, enforcing that only its creating caller can use it. */
  const getOwnedSession = (
    id: string | undefined,
    caller: string,
  ): Session | undefined => {
    if (!id) {
      return undefined;
    }
    const session = sessions.get(id);
    if (!session || session.caller !== caller) {
      return undefined;
    }
    session.lastSeen = Date.now();
    return session;
  };

  const atCapacity = (res: Response): boolean => {
    if (sessions.size < options.maxSessions) {
      return false;
    }
    jsonRpcError(res, 503, "Too many open MCP sessions; close idle sessions and retry");
    return true;
  };

  // --- Streamable HTTP -----------------------------------------------------

  app.post("/mcp", async (req, res) => {
    const caller: string = res.locals.caller;
    const sessionId = req.header("mcp-session-id");
    try {
      if (sessionId) {
        const session = getOwnedSession(sessionId, caller);
        if (!session) {
          jsonRpcError(res, 404, "Session not found");
          return;
        }
        await session.transport.handleRequest(
          req,
          res,
          req.body,
        );
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, "Bad Request: no session ID and not an initialize request");
        return;
      }
      if (atCapacity(res)) {
        return;
      }
      const server = options.createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, {
            transport,
            server,
            caller,
            lastSeen: Date.now(),
          });
          log(`[http] session ${id} opened by ${caller}`);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.has(id)) {
          sessions.delete(id);
          log(`[http] session ${id} closed`);
        }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log(`[http] POST /mcp failed: ${(error as Error).message}`);
      jsonRpcError(res, 500, "Internal server error");
    }
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const caller: string = res.locals.caller;
    const session = getOwnedSession(req.header("mcp-session-id"), caller);
    if (!session) {
      jsonRpcError(res, req.header("mcp-session-id") ? 404 : 400, "Session not found");
      return;
    }
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      log(`[http] ${req.method} /mcp failed: ${(error as Error).message}`);
      jsonRpcError(res, 500, "Internal server error");
    }
  };
  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  // --- Metrics ---------------------------------------------------------------

  app.get("/metrics", (_req, res) => {
    res.json({
      sessions: { streamable: sessions.size, max: options.maxSessions },
      ...(options.getMetrics ? { queue: options.getMetrics() } : {}),
    });
  });

  // Last-resort error handler: never let a route failure become an
  // unhandledRejection (which exits the process and drops every caller).
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error?.status === "number" ? error.status : 500;
    if (status >= 500) {
      log(`[http] request failed: ${error?.message ?? error}`);
    }
    jsonRpcError(res, status, status >= 500 ? "Internal server error" : String(error?.message ?? "Bad request"));
  });

  return {
    app,
    sessionCount: () => sessions.size,
    closeAllSessions: async () => {
      await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
    },
    sweepIdleSessions: async (now = Date.now()) => {
      const idle = [...sessions.entries()]
        .filter(([, s]) => now - s.lastSeen > options.sessionIdleMs)
        .map(([id]) => id);
      await Promise.all(idle.map((id) => closeSession(id)));
      if (idle.length) {
        log(`[http] closed ${idle.length} idle session(s)`);
      }
      return idle.length;
    },
  };
}

export interface RunningHttpServer {
  httpServer: HttpServer;
  url: string;
  close: () => Promise<void>;
  sessionCount: () => number;
}

/** Start listening. Resolves once the port is bound. */
export async function startHttpServer(
  options: HttpServerOptions,
): Promise<RunningHttpServer> {
  const { app, closeAllSessions, sessionCount, sweepIdleSessions } = createHttpApp(options);
  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(options.port, options.host, () => resolve(server));
    server.once("error", reject);
  });
  const sweep = setInterval(
    () => void sweepIdleSessions(),
    Math.min(options.sessionIdleMs, 60_000),
  );
  sweep.unref();

  const address = httpServer.address() as AddressInfo;
  const hostForUrl = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    httpServer,
    url: `http://${hostForUrl}:${address.port}/mcp`,
    sessionCount,
    close: async () => {
      clearInterval(sweep);
      await closeAllSessions();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}
