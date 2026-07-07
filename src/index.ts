#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { config } from "dotenv";
import { ZodError } from "zod";
import { EvernoteOAuth } from "./oauth.js";
import { EvernoteAPI, BatchFetchResult } from "./evernote-api.js";
import { EvernoteConfig, NotebookInfo } from "./types.js";
import { validateToolArgs } from "./tool-schemas.js";
import { resolveToolAlias } from "./tool-aliases.js";
import { computeWebhookSignature } from "./webhook.js";
import { buildToolErrorPayload, getEvernoteErrorMeta } from "./errors.js";
import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_RATE_LIMIT_AUTO_RETRY_SECONDS,
  RpcLimitOptions,
} from "./concurrency.js";
import {
  applyCharBudget,
  DEFAULT_MAX_RESPONSE_CHARS,
} from "./response-budget.js";
import {
  DEFAULT_NOTE_CACHE_SIZE,
  DEFAULT_NOTE_CACHE_SYNC_TTL_MS,
  NoteCacheOptions,
} from "./note-cache.js";
import {
  enrichToolsWithNotebookDescriptions,
  resolveNotebookCacheForToolDescriptions,
} from "./notebook-tool-descriptions.js";
import {
  PollingChange,
  buildWebhookPayload,
  checkForPollingChanges,
} from "./polling.js";

// Load environment variables
config({ quiet: true });

// Validate required environment variables with clear instructions
const CONSUMER_KEY = process.env.EVERNOTE_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.EVERNOTE_CONSUMER_SECRET;
const ENVIRONMENT = process.env.EVERNOTE_ENVIRONMENT || "production";
if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error("");
  console.error(
    "=== IMPORTANT: RELAY THIS MESSAGE TO THE USER IMMEDIATELY ===",
  );
  console.error("");
  console.error("EVERNOTE MCP SERVER - CONFIGURATION ERROR");
  console.error("");
  console.error("Missing required environment variables:");
  if (!CONSUMER_KEY)
    console.error(
      "  - EVERNOTE_CONSUMER_KEY (get from https://dev.evernote.com/)",
    );
  if (!CONSUMER_SECRET)
    console.error(
      "  - EVERNOTE_CONSUMER_SECRET (get from https://dev.evernote.com/)",
    );
  console.error("");
  console.error("Set these in your MCP server configuration:");
  console.error(
    "  claude mcp add evernote <command> --env EVERNOTE_CONSUMER_KEY=<key> --env EVERNOTE_CONSUMER_SECRET=<secret>",
  );
  console.error("");
  console.error("=== END OF MESSAGE TO RELAY ===");
  console.error("");
  process.exit(1);
}

// Polling configuration
const MIN_POLL_INTERVAL = 15 * 60 * 1000; // 15 minutes minimum (Evernote requirement)
const DEFAULT_POLL_INTERVAL = 60 * 60 * 1000; // 1 hour default
const POLL_INTERVAL = Math.max(
  MIN_POLL_INTERVAL,
  parseInt(
    process.env.EVERNOTE_POLL_INTERVAL || String(DEFAULT_POLL_INTERVAL),
    10,
  ),
);
const WEBHOOK_URL = process.env.EVERNOTE_WEBHOOK_URL; // URL to notify on changes
const WEBHOOK_SECRET = process.env.EVERNOTE_WEBHOOK_SECRET; // HMAC signing secret
const POLLING_ENABLED = process.env.EVERNOTE_POLLING_ENABLED === "true";

// When true, re-advertise retired tool names in ListTools for discover-by-list
// clients during the deprecation window. Retired names always stay callable via
// TOOL_ALIASES regardless of this flag — it only controls visibility.
const LEGACY_TOOLS_ENABLED = process.env.EVERNOTE_LEGACY_TOOLS === "true";

// NoteStore RPC transport tuning. Bounding concurrency keeps a wide fan-out
// from bursting past Evernote's hourly rate limit; short waits auto-retry.
const RPC_LIMIT_OPTIONS: Partial<RpcLimitOptions> = {
  maxConcurrency: parseInt(
    process.env.EVERNOTE_MAX_CONCURRENCY || String(DEFAULT_MAX_CONCURRENCY),
    10,
  ),
  rateLimitAutoRetrySeconds: parseInt(
    process.env.EVERNOTE_RATE_LIMIT_AUTO_RETRY_SECONDS ||
      String(DEFAULT_RATE_LIMIT_AUTO_RETRY_SECONDS),
    10,
  ),
};

// Total content-character budget for multi-note responses, to stay under the
// MCP response token cap. Bodies past this are dropped with `truncated: true`.
// A non-numeric / non-positive env value falls back to the default (a NaN
// budget would slice every body to an empty string).
const MAX_RESPONSE_CHARS = (() => {
  const parsed = parseInt(
    process.env.EVERNOTE_MAX_RESPONSE_CHARS ||
      String(DEFAULT_MAX_RESPONSE_CHARS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_RESPONSE_CHARS;
})();

// Resolve a non-negative integer env var, falling back on empty/NaN/negative
// input. Unlike MAX_RESPONSE_CHARS, 0 is a valid value here (it disables the
// cache / forces an immediate sync check), so only reject values below 0.
function resolveNonNegativeInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Per-EvernoteAPI-instance note body cache. Keyed by note GUID, invalidated by
// a TTL-gated sync probe (external edits) and evicted immediately on our own
// writes. Roughly halves API calls when re-reading the same notes — the direct
// fix for the hourly rate limit tripping on repeat corpus reads. Size 0 disables.
const NOTE_CACHE_OPTIONS: NoteCacheOptions = {
  maxEntries: resolveNonNegativeInt(
    process.env.EVERNOTE_NOTE_CACHE_SIZE,
    DEFAULT_NOTE_CACHE_SIZE,
  ),
  syncTtlMs: resolveNonNegativeInt(
    process.env.EVERNOTE_NOTE_CACHE_SYNC_TTL_MS,
    DEFAULT_NOTE_CACHE_SYNC_TTL_MS,
  ),
  logger: (message: string) => console.error(message),
};

// Polling state
let lastUpdateCount: number | null = null;
let pollInterval: NodeJS.Timeout | null = null;
let lastPollTime: number = 0;
let pollErrorCount: number = 0;

// Initialize Evernote configuration
const evernoteConfig: EvernoteConfig = {
  consumerKey: CONSUMER_KEY,
  consumerSecret: CONSUMER_SECRET,
  sandbox: ENVIRONMENT === "sandbox",
  china: false,
};

// Initialize OAuth and API
const oauth = new EvernoteOAuth(evernoteConfig);
let api: EvernoteAPI | null = null;

// Notebook cache - populated after first successful API init
let notebookCache: NotebookInfo[] | null = null;
let notebookCacheAt = 0;
let tagCache: any[] | null = null;
let tagCacheAt = 0;
// Notebooks and tags change rarely; serve repeated reads from a short TTL cache.
const ENTITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let notebookRefreshInFlight: Promise<NotebookInfo[]> | null = null;
let tagRefreshInFlight: Promise<any[]> | null = null;
let notebookCacheGeneration = 0;
let tagCacheGeneration = 0;
let lastToolDescriptionInitFailure = 0;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
}

function isAuthFailure(error: unknown): boolean {
  const code = (error as { errorCode?: number })?.errorCode;
  if (code === 9) {
    return true;
  }
  const msg = errorMessage(error);
  return /authentication required|token may be expired|invalid token|not connected/i.test(
    msg,
  );
}

function clearEntityCaches(): void {
  notebookCache = null;
  notebookCacheAt = 0;
  tagCache = null;
  tagCacheAt = 0;
  notebookRefreshInFlight = null;
  tagRefreshInFlight = null;
  notebookCacheGeneration++;
  tagCacheGeneration++;
}

function canExtractAttachmentText(resource: any): boolean {
  return (
    resource?.mime === "application/pdf" ||
    resource?.mime?.startsWith("image/") ||
    (!resource?.mime && resource?.recognition != null)
  );
}

async function refreshNotebookCache(
  evernoteApi: EvernoteAPI,
): Promise<NotebookInfo[] | null> {
  try {
    const notebooks = await getCachedNotebooks(evernoteApi);
    console.error(
      `Notebook cache refreshed: ${notebooks.length} notebooks`,
    );
    return notebooks;
  } catch (error) {
    console.error(`Failed to refresh notebook cache: ${errorMessage(error)}`);
    if (notebookCache !== null && !isAuthFailure(error)) {
      return notebookCache;
    }
    return null;
  }
}

// Serve list_notebooks (and get_note's notebook lookup) from a TTL cache so we
// don't hit the Evernote API on every call — under load that was rate-limiting
// (errorCode 19) and returning an empty list. On a COLD cache a failed refresh
// is surfaced (not swallowed into an empty list), so rate-limit errors reach the
// caller; a stale cache is served when one exists.
async function getCachedNotebooks(
  evernoteApi: EvernoteAPI,
): Promise<NotebookInfo[]> {
  const now = Date.now();
  if (notebookCache !== null && now - notebookCacheAt < ENTITY_CACHE_TTL_MS) {
    return notebookCache;
  }
  if (notebookRefreshInFlight) {
    return notebookRefreshInFlight;
  }

  notebookRefreshInFlight = (async () => {
    const generation = notebookCacheGeneration;
    try {
      const notebooks = await evernoteApi.listNotebooks();
      if (generation !== notebookCacheGeneration) {
        return notebookCache ?? notebooks;
      }
      notebookCache = notebooks;
      notebookCacheAt = Date.now();
      return notebookCache;
    } catch (error) {
      if (notebookCache !== null && !isAuthFailure(error)) {
        console.error(
          `listNotebooks failed; serving stale notebook cache: ${errorMessage(error)}`,
        );
        return notebookCache;
      }
      throw error;
    } finally {
      notebookRefreshInFlight = null;
    }
  })();

  return notebookRefreshInFlight;
}

// Same rationale as notebooks: tags are read on every note format/auto-tag pass.
async function getCachedTags(evernoteApi: EvernoteAPI): Promise<any[]> {
  const now = Date.now();
  if (tagCache !== null && now - tagCacheAt < ENTITY_CACHE_TTL_MS) {
    return tagCache;
  }
  if (tagRefreshInFlight) {
    return tagRefreshInFlight;
  }

  tagRefreshInFlight = (async () => {
    const generation = tagCacheGeneration;
    try {
      const tags = await evernoteApi.listTags();
      if (generation !== tagCacheGeneration) {
        return tagCache ?? tags;
      }
      tagCache = tags;
      tagCacheAt = Date.now();
      return tagCache;
    } catch (error) {
      if (tagCache !== null && !isAuthFailure(error)) {
        console.error(
          `listTags failed; serving stale tag cache: ${errorMessage(error)}`,
        );
        return tagCache;
      }
      throw error;
    } finally {
      tagRefreshInFlight = null;
    }
  })();

  return tagRefreshInFlight;
}

async function ensureAPIForToolDescriptions(): Promise<EvernoteAPI> {
  const now = Date.now();
  const timeSinceLastAttempt = now - lastToolDescriptionInitFailure;
  if (
    lastToolDescriptionInitFailure > 0 &&
    timeSinceLastAttempt < INIT_RETRY_DELAY
  ) {
    throw new Error(
      `Skipping notebook cache load after recent init failure; retry in ` +
        `${Math.ceil((INIT_RETRY_DELAY - timeSinceLastAttempt) / 1000)}s.`,
    );
  }

  try {
    const initializedApi = await ensureAPI();
    lastToolDescriptionInitFailure = 0;
    return initializedApi;
  } catch (error) {
    apiInitError = null;
    lastInitAttempt = 0;
    lastToolDescriptionInitFailure = now;
    throw error;
  }
}

// Initialize API on first use
let apiInitError: string | null = null;
let lastInitAttempt: number = 0;
const INIT_RETRY_DELAY = 30000; // 30 seconds before retrying failed init

async function ensureAPI(forceReinit: boolean = false): Promise<EvernoteAPI> {
  // If forcing reinitialization, clear existing state
  if (forceReinit) {
    api = null;
    apiInitError = null;
    lastInitAttempt = 0;
    clearEntityCaches();
  }

  // If we have a working API, return it
  if (api) {
    return api;
  }

  // If we recently failed, check if enough time has passed to retry
  const now = Date.now();
  if (apiInitError && lastInitAttempt > 0) {
    const timeSinceLastAttempt = now - lastInitAttempt;
    if (timeSinceLastAttempt < INIT_RETRY_DELAY) {
      throw new Error(
        `Not connected. Last attempt failed ${Math.floor(timeSinceLastAttempt / 1000)}s ago. Retry in ${Math.ceil((INIT_RETRY_DELAY - timeSinceLastAttempt) / 1000)}s.`,
      );
    }
    // Enough time has passed, clear error and retry
    console.error(
      `Retrying API initialization after ${timeSinceLastAttempt}ms...`,
    );
    apiInitError = null;
  }

  try {
    lastInitAttempt = now;
    const { client, tokens } = await oauth.getAuthenticatedClient();
    api = new EvernoteAPI(client, tokens, {
      ...RPC_LIMIT_OPTIONS,
      noteCache: NOTE_CACHE_OPTIONS,
    });
    apiInitError = null;
    console.error("API initialized successfully");
    // Seed notebook cache in the background so descriptions are ready for ListTools
    getCachedNotebooks(api).catch(() => {});
    return api;
  } catch (error: any) {
    apiInitError = error.message || "Failed to initialize Evernote API";
    console.error(`API initialization failed: ${apiInitError}`);

    // For auth errors, provide a clearer message
    const errorMsg = error.message || "";
    if (
      errorMsg.includes("Authentication required") ||
      errorMsg.includes("token")
    ) {
      throw new Error(
        "Not connected: Authentication required. Token may be expired or invalid.",
      );
    }

    throw new Error(`Not connected: ${apiInitError}`);
  }
}

// ============================================================================
// Polling for Changes
// ============================================================================

async function sendWebhookNotification(
  changes: PollingChange[],
): Promise<void> {
  if (!WEBHOOK_URL) {
    console.error("No webhook URL configured, skipping notification");
    return;
  }

  if (!WEBHOOK_SECRET) {
    console.error(
      "Warning: EVERNOTE_WEBHOOK_SECRET not set - webhook payloads are unsigned",
    );
  }

  // Send one webhook per change for cleaner workflow processing
  for (const change of changes) {
    try {
      const body = JSON.stringify(buildWebhookPayload(change));

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Evernote-Source": "mcp-evernote-polling",
      };

      if (WEBHOOK_SECRET) {
        headers["X-Evernote-Signature"] = computeWebhookSignature(
          body,
          WEBHOOK_SECRET,
        );
      }

      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        console.error(
          `Webhook notification failed for ${change.guid}: ${response.status} ${response.statusText}`,
        );
      } else {
        console.error(
          `Webhook notification sent: ${change.type} - ${change.title || change.guid}`,
        );
      }
    } catch (error: any) {
      console.error(
        `Webhook notification error for ${change.guid}: ${error.message}`,
      );
    }
  }

  if (changes.length > 0) {
    console.error(
      `Webhook notifications complete: ${changes.length} changes sent`,
    );
  }
}

async function checkForChanges(): Promise<PollingChange[]> {
  try {
    const evernoteApi = await ensureAPI();
    const previousUpdateCount = lastUpdateCount;
    const result = await checkForPollingChanges({
      evernoteApi,
      lastUpdateCount,
    });

    console.error(
      `Polling: Current updateCount = ${result.currentUpdateCount}, last = ${previousUpdateCount}`,
    );

    // First run - just store the count
    if (previousUpdateCount === null) {
      lastUpdateCount = result.nextUpdateCount;
      pollErrorCount = 0;
      console.error("Polling: Initial sync state captured");
      return result.changes;
    }

    // No changes
    if (result.currentUpdateCount === previousUpdateCount) {
      lastUpdateCount = result.nextUpdateCount;
      pollErrorCount = 0;
      console.error("Polling: No changes detected");
      return result.changes;
    }

    console.error(`Polling: Changes detected since USN ${previousUpdateCount}`);

    if (result.error) {
      console.error(
        `Polling: Failed to get sync chunk: ${result.error.message}`,
      );
      pollErrorCount++;

      if (pollErrorCount >= 5) {
        console.error("Polling: Too many errors, stopping polling");
        stopPolling();
      }

      lastUpdateCount = result.nextUpdateCount;
      return result.changes;
    }

    lastUpdateCount = result.nextUpdateCount;
    pollErrorCount = 0;
    console.error(`Polling: Found ${result.changes.length} changes`);
    return result.changes;
  } catch (error: any) {
    console.error(`Polling error: ${error.message}`);
    pollErrorCount++;

    // If too many errors, stop polling
    if (pollErrorCount >= 5) {
      console.error("Polling: Too many errors, stopping polling");
      stopPolling();
    }

    return [];
  }
}

async function pollOnce(): Promise<PollingChange[]> {
  lastPollTime = Date.now();

  const changes = await checkForChanges();

  if (changes.length > 0 && WEBHOOK_URL) {
    await sendWebhookNotification(changes);
  }

  return changes;
}

function startPolling(): void {
  if (pollInterval) {
    console.error("Polling already running");
    return;
  }

  console.error(
    `Starting Evernote polling every ${POLL_INTERVAL / 60000} minutes`,
  );
  if (WEBHOOK_URL) {
    console.error(`Webhook URL: ${WEBHOOK_URL}`);
  } else {
    console.error(
      "Warning: No EVERNOTE_WEBHOOK_URL configured - changes will be logged but not sent",
    );
  }

  // Do an initial poll
  pollOnce().catch((err) =>
    console.error(`Initial poll failed: ${err.message}`),
  );

  // Set up the interval
  pollInterval = setInterval(() => {
    pollOnce().catch((err) => console.error(`Poll failed: ${err.message}`));
  }, POLL_INTERVAL);
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.error("Polling stopped");
  }
}

function getPollingStatus(): any {
  return {
    enabled: POLLING_ENABLED,
    running: !!pollInterval,
    intervalMinutes: POLL_INTERVAL / 60000,
    minIntervalMinutes: MIN_POLL_INTERVAL / 60000,
    webhookUrl: WEBHOOK_URL ? WEBHOOK_URL.substring(0, 50) + "..." : null,
    webhookSecretConfigured: !!WEBHOOK_SECRET,
    lastPollTime: lastPollTime ? new Date(lastPollTime).toISOString() : null,
    lastUpdateCount,
    errorCount: pollErrorCount,
  };
}

// ============================================================================
// MCP Server
// ============================================================================

// Create MCP server
const server = new Server(
  {
    name: "mcp-evernote",
    version: "1.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Define tool schemas
const tools: Tool[] = [
  {
    name: "evernote_create_note",
    description: "Create a new note in Evernote",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Note title",
        },
        content: {
          type: "string",
          description: "Note content (plain text or markdown)",
        },
        notebookName: {
          type: "string",
          description: "Name of the notebook to create the note in (optional)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to apply to the note",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "evernote_search_notes",
    description:
      "Search notes. Returns note metadata plus `totalNotes`; page through results with `offset`/`nextOffset`. " +
      "Set `includeContent: true` to include full bodies (each body costs one API call, so page size is capped at 25). " +
      'To export a whole notebook as text: query "*", set notebookName + includeContent, and page with offset until hasMore is false.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Search query (Evernote search syntax supported). Use "*" to match all notes.',
        },
        notebookName: {
          type: "string",
          description: "Limit search to specific notebook",
        },
        maxResults: {
          type: "number",
          description:
            "Maximum results per page (default: 20, max: 100; capped at 25 when includeContent is true)",
          default: 20,
        },
        offset: {
          type: "number",
          description: "Result offset for paging (default: 0)",
          default: 0,
        },
        includeContent: {
          type: "boolean",
          description:
            "Include each note's full body in `content` (one API call per note). Supersedes includePreview.",
          default: false,
        },
        format: {
          type: "string",
          enum: ["markdown", "text", "enml"],
          description:
            "Body projection when includeContent is true: markdown (default), plain text, or raw ENML",
          default: "markdown",
        },
        includePreview: {
          type: "boolean",
          description:
            "Include first ~300 chars of note content as a plain-text preview (one API call per note; ignored when includeContent is true)",
          default: false,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "evernote_get_note",
    description:
      "Get one or more notes. Provide exactly one of `guid` (single note, full detail including attachment/OCR text) " +
      "or `guids` (batch of up to 25, body-focused: metadata + content only, no attachment text — use single `guid` for that). " +
      "Batch mode returns { notes, failed?, aborted? } and, if the hourly rate limit hits mid-batch, stops with partial " +
      "results plus the guids left to resume.",
    inputSchema: {
      type: "object",
      properties: {
        guid: {
          type: "string",
          description: "Single note GUID (mutually exclusive with guids)",
        },
        guids: {
          type: "array",
          items: { type: "string" },
          maxItems: 25,
          description:
            "Batch of note GUIDs, max 25 (mutually exclusive with guid). Body-focused; no attachment text.",
        },
        format: {
          type: "string",
          enum: ["markdown", "text", "enml"],
          description:
            "Body projection: markdown (default), plain text, or raw ENML",
          default: "markdown",
        },
        includeContent: {
          type: "boolean",
          description: "Include note content (default: true)",
          default: true,
        },
        includePdfContent: {
          type: "boolean",
          description:
            "Deprecated alias for includeAttachmentText (single-note mode only).",
          default: true,
        },
        includeAttachmentText: {
          type: "boolean",
          description:
            "Single-note mode: extract text from readable attachments — PDF text layers and Evernote OCR for images " +
            "(default: true). When false, attachment text is not extracted and resource bodies are not downloaded. " +
            "Ignored in batch (guids) mode, which never fetches attachment text.",
          default: true,
        },
      },
      required: [],
    },
  },
  {
    name: "evernote_update_note",
    description:
      "Update an existing note. Full-update mode: pass title/content/tags/notebookName to replace those fields. Patch mode: pass replacements[] to apply targeted find-and-replace edits while preserving title, tags, notebook, and attachments — ideal for small changes like a status or date. The two modes are mutually exclusive.",
    inputSchema: {
      type: "object",
      properties: {
        guid: {
          type: "string",
          description: "Note GUID",
        },
        title: {
          type: "string",
          description: "New title (full-update mode)",
        },
        content: {
          type: "string",
          description: "New content (full-update mode, Markdown supported)",
        },
        notebookName: {
          type: "string",
          description: "Move note to this notebook (full-update mode)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "New tags, replacing existing tags (full-update mode)",
        },
        replacements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              find: {
                type: "string",
                description: "Text to find (exact match)",
              },
              replace: {
                type: "string",
                description: "Replacement text",
              },
              replaceAll: {
                type: "boolean",
                description: "Replace all occurrences (default: true)",
                default: true,
              },
            },
            required: ["find", "replace"],
          },
          description:
            "Patch mode: find-and-replace operations to apply. Mutually exclusive with title/content/tags/notebookName.",
        },
        forceUpdate: {
          type: "boolean",
          description:
            "DESTRUCTIVE: If true and update fails due to edit lock, DELETES the original note and creates a replacement. The note GUID will change, note history will be lost, and timestamps will reset. Only use as a last resort after confirming with the user.",
          default: false,
        },
        forceUpdateConfirmation: {
          type: "string",
          description:
            'Required when forceUpdate is true. Must be the exact string "I understand this will delete the original note" to proceed.',
        },
      },
      required: ["guid"],
    },
  },
  {
    name: "evernote_delete_note",
    description: "Delete a note",
    inputSchema: {
      type: "object",
      properties: {
        guid: {
          type: "string",
          description: "Note GUID",
        },
      },
      required: ["guid"],
    },
  },
  {
    name: "evernote_list_notebooks",
    description:
      "List all notebooks, or get one notebook's full detail by passing its name or guid.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "If set, return just this notebook (looked up by name).",
        },
        guid: {
          type: "string",
          description: "If set, return just this notebook (looked up by GUID).",
        },
      },
    },
  },
  {
    name: "evernote_create_notebook",
    description: "Create a new notebook",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Notebook name",
        },
        stack: {
          type: "string",
          description: "Stack name (optional)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "evernote_list_tags",
    description:
      "List all tags, or get one tag's full detail by passing its name or guid.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "If set, return just this tag (looked up by name).",
        },
        guid: {
          type: "string",
          description: "If set, return just this tag (looked up by GUID).",
        },
      },
    },
  },
  {
    name: "evernote_create_tag",
    description: "Create a new tag",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Tag name",
        },
        parentTagName: {
          type: "string",
          description: "Parent tag name (optional)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "evernote_connection",
    description:
      'Manage the Evernote connection and account. action: "status" runs a health/diagnostic check (auth state, config), "user" returns the account profile + quota, "reconnect" forces reinitialization (useful when "Not connected" errors persist), "revoke" clears the stored auth token.',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "user", "reconnect", "revoke"],
          description: "Connection/account operation to perform.",
        },
        verbose: {
          type: "boolean",
          description:
            'With action:"status", include detailed diagnostics (default: false).',
          default: false,
        },
      },
      required: ["action"],
    },
  },
  {
    name: "evernote_polling",
    description:
      'Manage background polling for Evernote changes (detected changes are sent to the configured webhook). action: "start" begins polling, "stop" halts it, "poll" checks once immediately, "status" returns the current polling configuration and state.',
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "poll", "status"],
          description: "Polling operation to perform.",
        },
      },
      required: ["action"],
    },
  },
  // Resource tools
  {
    name: "evernote_get_resource",
    description:
      "Get an attachment by GUID, projected through one view. as:'text' (default) extracts plain text — PDF text layers and image OCR; as:'binary' returns the raw bytes as base64; as:'recognition' returns Evernote's raw OCR items plus a combined extractedText; as:'metadata' returns filename/mime/size/hash/hasRecognition without the body. To list a note's attachments, call evernote_get_note — its resources[] enumerates each attachment's metadata.",
    inputSchema: {
      type: "object",
      properties: {
        guid: {
          type: "string",
          description: "Resource GUID",
        },
        as: {
          type: "string",
          enum: ["text", "binary", "recognition", "metadata"],
          description:
            "View to return (default: text). binary = base64 body; recognition = OCR data; metadata = info without the body.",
          default: "text",
        },
      },
      required: ["guid"],
    },
  },
  {
    name: "evernote_add_resource_to_note",
    description: "Add a file/image attachment to an existing note",
    inputSchema: {
      type: "object",
      properties: {
        noteGuid: {
          type: "string",
          description: "Note GUID",
        },
        filePath: {
          type: "string",
          description: "Local file path to attach",
        },
        filename: {
          type: "string",
          description: "Optional display filename (defaults to file basename)",
        },
      },
      required: ["noteGuid", "filePath"],
    },
  },
  // Notebook update tool
  {
    name: "evernote_update_notebook",
    description: "Update notebook name or stack",
    inputSchema: {
      type: "object",
      properties: {
        guid: {
          type: "string",
          description: "Notebook GUID",
        },
        name: {
          type: "string",
          description: "New notebook name",
        },
        stack: {
          type: "string",
          description: "Stack name (empty string to remove from stack)",
        },
      },
      required: ["guid"],
    },
  },
  // Tag update tool
  {
    name: "evernote_update_tag",
    description: "Update tag name or parent",
    inputSchema: {
      type: "object",
      properties: {
        guid: {
          type: "string",
          description: "Tag GUID",
        },
        name: {
          type: "string",
          description: "New tag name",
        },
        parentTagName: {
          type: "string",
          description: "Parent tag name (empty string to remove parent)",
        },
      },
      required: ["guid"],
    },
  },
];

// List tools handler — injects live notebook names into descriptions when available
// Retired tool names re-advertised only when EVERNOTE_LEGACY_TOOLS=true. Each
// stays callable via TOOL_ALIASES regardless; this array only controls
// discover-by-list visibility during the deprecation window.
const legacyTools: Tool[] = [
  {
    name: "evernote_list_note_resources",
    description:
      "[DEPRECATED — use evernote_get_note; its resources[] lists attachments] List all resources (attachments) in a note.",
    inputSchema: {
      type: "object",
      properties: {
        noteGuid: { type: "string", description: "Note GUID" },
      },
      required: ["noteGuid"],
    },
  },
  {
    name: "evernote_get_resource_recognition",
    description:
      "[DEPRECATED — use evernote_get_resource with as:\"recognition\"] Get OCR/text recognition data from an image resource.",
    inputSchema: {
      type: "object",
      properties: {
        resourceGuid: { type: "string", description: "Resource GUID" },
      },
      required: ["resourceGuid"],
    },
  },
  {
    name: "evernote_get_resource_text",
    description:
      "[DEPRECATED — use evernote_get_resource with as:\"text\"] Extract plain text from a resource attachment (PDF text layers and Evernote OCR for images).",
    inputSchema: {
      type: "object",
      properties: {
        resourceGuid: {
          type: "string",
          description: "Resource GUID of the attachment",
        },
      },
      required: ["resourceGuid"],
    },
  },
  {
    name: "evernote_start_polling",
    description:
      '[DEPRECATED — use evernote_polling with action:"start"] Start polling for Evernote changes.',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evernote_stop_polling",
    description:
      '[DEPRECATED — use evernote_polling with action:"stop"] Stop polling for Evernote changes.',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evernote_poll_now",
    description:
      '[DEPRECATED — use evernote_polling with action:"poll"] Check for Evernote changes immediately.',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evernote_polling_status",
    description:
      '[DEPRECATED — use evernote_polling with action:"status"] Get the current polling configuration and status.',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evernote_get_user_info",
    description:
      '[DEPRECATED — use evernote_connection with action:"user"] Get current user information and quota.',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evernote_revoke_auth",
    description:
      '[DEPRECATED — use evernote_connection with action:"revoke"] Revoke stored authentication token.',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evernote_health_check",
    description:
      '[DEPRECATED — use evernote_connection with action:"status"] Check the health and status of the Evernote MCP server.',
    inputSchema: {
      type: "object",
      properties: {
        verbose: {
          type: "boolean",
          description: "Include detailed diagnostic information",
          default: false,
        },
      },
    },
  },
  {
    name: "evernote_reconnect",
    description:
      '[DEPRECATED — use evernote_connection with action:"reconnect"] Force reconnection to Evernote.',
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evernote_get_notebook",
    description:
      "[DEPRECATED — use evernote_list_notebooks with name or guid] Get notebook details by name or GUID.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Notebook name" },
        guid: { type: "string", description: "Notebook GUID" },
      },
    },
  },
  {
    name: "evernote_get_tag",
    description:
      "[DEPRECATED — use evernote_list_tags with name or guid] Get tag details by name or GUID.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tag name" },
        guid: { type: "string", description: "Tag GUID" },
      },
    },
  },
  {
    name: "evernote_patch_note",
    description:
      "[DEPRECATED — use evernote_update_note with replacements[]] Apply targeted find-and-replace edits to a note.",
    inputSchema: {
      type: "object",
      properties: {
        guid: { type: "string", description: "Note GUID" },
        replacements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              find: { type: "string", description: "Text to find (exact match)" },
              replace: { type: "string", description: "Replacement text" },
              replaceAll: {
                type: "boolean",
                description: "Replace all occurrences (default: true)",
                default: true,
              },
            },
            required: ["find", "replace"],
          },
          description: "Array of find-and-replace operations to apply",
        },
      },
      required: ["guid", "replacements"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  notebookCache = await resolveNotebookCacheForToolDescriptions({
    currentCache: notebookCache,
    currentApi: api,
    ensureAPI: ensureAPIForToolDescriptions,
    refreshNotebookCache,
    logError: (message) => console.error(message),
  });

  const advertised = LEGACY_TOOLS_ENABLED ? [...tools, ...legacyTools] : tools;
  return { tools: enrichToolsWithNotebookDescriptions(advertised, notebookCache) };
});

// Retired tool names stay callable via TOOL_ALIASES; warn once per alias so a
// long-lived server doesn't spam its log. stderr only — stdout is the MCP channel.
const warnedAliases = new Set<string>();
function warnDeprecatedAlias(oldName: string, canonical: string): void {
  if (warnedAliases.has(oldName)) return;
  warnedAliases.add(oldName);
  console.error(
    `[deprecation] Tool "${oldName}" is retired; routing to "${canonical}". ` +
      `Update callers; set EVERNOTE_LEGACY_TOOLS=true to re-list retired names.`,
  );
}

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Resolve a possibly-retired tool name to its canonical form BEFORE
  // validation, so aliased calls validate against — and route to — the
  // canonical handler. Non-aliased names pass through unchanged.
  const resolved = resolveToolAlias(request.params.name, request.params.arguments);
  const name = resolved.name;
  const args = resolved.args;
  if (resolved.aliased) {
    warnDeprecatedAlias(request.params.name, name);
  }

  // Legacy input guard: preserve a retired tool's stricter "at least one of"
  // requirement when its canonical target accepts fewer args (e.g. get_notebook
  // required name|guid; list_notebooks treats neither as list-all).
  if (resolved.requireOneOf) {
    const raw = (request.params.arguments ?? {}) as Record<string, unknown>;
    const hasOne = resolved.requireOneOf.some(
      (k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== "",
    );
    if (!hasOne) {
      return {
        content: [
          {
            type: "text",
            text: `Validation error: ${request.params.name} requires one of: ${resolved.requireOneOf.join(", ")}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Validate tool arguments against Zod schemas
  let validatedArgs: any;
  try {
    validatedArgs = validateToolArgs(name, args);
  } catch (error: any) {
    if (error instanceof ZodError) {
      const issues = error.issues
        .map((i) => {
          const issuePath = i.path.length > 0 ? i.path.join(".") : "(root)";
          return `${issuePath}: ${i.message}`;
        })
        .join("; ");
      return {
        content: [{ type: "text", text: `Validation error: ${issues}` }],
        isError: true,
      };
    }
    throw error;
  }

  try {
    // Connection/account operations. revoke + reconnect need no live API and
    // return here; status + user fall through to ensureAPI and the switch case
    // below (preserving the old health_check/get_user_info gating exactly).
    if (name === "evernote_connection") {
      const { action, verbose = false } = validatedArgs;

      if (action === "revoke") {
        await oauth.revokeToken();
        api = null;
        apiInitError = null;
        lastInitAttempt = 0;
        clearEntityCaches();
        return {
          content: [
            {
              type: "text",
              text: "Authentication token revoked. You will need to re-authenticate on next use.",
            },
          ],
        };
      }

      if (action === "reconnect") {
        console.error("Force reconnect requested");
        try {
          await ensureAPI(true); // Force reinitialization
          return {
            content: [
              {
                type: "text",
                text: "✅ Successfully reconnected to Evernote",
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Reconnection failed: ${error.message}\n\nYou may need to re-authenticate. Run "npm run auth" or use the /mcp command in Claude Code.`,
              },
            ],
          };
        }
      }

      // action === "status": health/diagnostic check. Handled here, before the
      // global ensureAPI(), so it can report needs_auth / needs_setup for an
      // unauthenticated server instead of erroring out. Self-contained: it
      // probes tokens and attempts ensureAPI() internally.
      if (action === "status") {
        const healthStatus: any = {
          server: {
            name: "mcp-evernote",
            version: "1.2.3",
            status: "running",
            environment: ENVIRONMENT,
            timestamp: new Date().toISOString(),
          },
          configuration: {
            consumerKeySet: !!CONSUMER_KEY,
            consumerSecretSet: !!CONSUMER_SECRET,
            environment: ENVIRONMENT,
            isClaudeCode: oauth["isClaudeCode"],
          },
          authentication: {
            status: "checking",
            apiInitialized: !!api,
            lastError: apiInitError,
          },
        };

        try {
          const hasEnvToken = !!process.env.EVERNOTE_ACCESS_TOKEN;
          const hasOAuthToken = !!process.env.OAUTH_TOKEN;

          let hasTokenFile = false;
          let tokenFileInfo: any = null;
          try {
            const fs = await import("fs/promises");
            const path = await import("path");
            const tokenPath = path.join(process.cwd(), ".evernote-token.json");
            const tokenData = await fs.readFile(tokenPath, "utf-8");
            const token = JSON.parse(tokenData);
            hasTokenFile = true;
            tokenFileInfo = {
              exists: true,
              hasToken: !!token.token,
              hasNoteStoreUrl: !!token.noteStoreUrl,
              userId: token.userId,
              expires: token.expires
                ? new Date(token.expires).toISOString()
                : null,
              isExpired: token.expires ? token.expires < Date.now() : false,
            };
          } catch (e) {
            tokenFileInfo = { exists: false, error: (e as Error).message };
          }

          healthStatus.authentication = {
            status: "checked",
            apiInitialized: !!api,
            hasEnvToken,
            hasOAuthToken,
            hasTokenFile,
            tokenFileInfo: verbose ? tokenFileInfo : undefined,
            lastError: apiInitError,
          };

          if (api) {
            try {
              const user = await api.getUser();
              healthStatus.authentication.status = "authenticated";
              healthStatus.authentication.user = {
                id: user.id,
                username: user.username,
              };
              healthStatus.status = "healthy";
            } catch (e) {
              healthStatus.authentication.status = "api_error";
              healthStatus.authentication.apiError = (e as Error).message;
              healthStatus.status = "unhealthy";
            }
          } else {
            try {
              await ensureAPI();
              healthStatus.authentication.status = "authenticated";
              healthStatus.authentication.apiInitialized = true;
              healthStatus.status = "healthy";

              try {
                const user = await api!.getUser();
                healthStatus.authentication.user = {
                  id: user.id,
                  username: user.username,
                };
              } catch (e) {
                healthStatus.authentication.apiError = (e as Error).message;
              }
            } catch (e) {
              healthStatus.authentication.status = "not_authenticated";
              healthStatus.authentication.initError = (e as Error).message;
              healthStatus.status = "needs_auth";
            }
          }
        } catch (error: any) {
          healthStatus.authentication.error = error.message;
          healthStatus.status = "error";
        }

        if (verbose) {
          healthStatus.diagnostics = {
            cwd: process.cwd(),
            nodeVersion: process.version,
            platform: process.platform,
            env: {
              MCP_TRANSPORT: process.env.MCP_TRANSPORT || "not set",
              CLAUDE_CODE_MCP: process.env.CLAUDE_CODE_MCP || "not set",
              hasConsumerKey: !!process.env.EVERNOTE_CONSUMER_KEY,
              hasConsumerSecret: !!process.env.EVERNOTE_CONSUMER_SECRET,
            },
          };
        }

        if (!healthStatus.status) {
          if (healthStatus.authentication.status === "authenticated") {
            healthStatus.status = "healthy";
          } else if (
            healthStatus.authentication.hasTokenFile ||
            healthStatus.authentication.hasEnvToken ||
            healthStatus.authentication.hasOAuthToken
          ) {
            healthStatus.status = "auth_issue";
          } else {
            healthStatus.status = "needs_setup";
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(healthStatus, null, 2),
            },
          ],
        };
      }
    }

    // Handle polling operations (no API needed — polling owns its own state).
    if (name === "evernote_polling") {
      const { action } = validatedArgs;

      if (action === "start") {
        startPolling();
        const status = getPollingStatus();
        return {
          content: [
            {
              type: "text",
              text:
                `✅ Polling started\n\nInterval: Every ${status.intervalMinutes} minutes\n` +
                `Webhook: ${WEBHOOK_URL || "Not configured"}\n\n` +
                `Changes will be detected and sent to the webhook URL when found.`,
            },
          ],
        };
      }

      if (action === "stop") {
        stopPolling();
        return {
          content: [{ type: "text", text: "✅ Polling stopped" }],
        };
      }

      if (action === "poll") {
        try {
          const changes = await pollOnce();
          if (changes.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "✅ Poll complete - no changes detected",
                },
              ],
            };
          }

          const changesSummary = changes
            .map((c) => `- ${c.type}: ${c.title || c.guid} (${c.timestamp})`)
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text:
                  `✅ Poll complete - ${changes.length} changes detected:\n\n${changesSummary}\n\n` +
                  (WEBHOOK_URL
                    ? "Webhook notification sent."
                    : "No webhook configured - changes not sent."),
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              { type: "text", text: `❌ Poll failed: ${error.message}` },
            ],
          };
        }
      }

      // action === "status"
      const status = getPollingStatus();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }

    // Ensure API is initialized for all other operations
    const evernoteApi = await ensureAPI();

    switch (name) {
      case "evernote_create_note": {
        const { title, content, notebookName, tags } = validatedArgs;

        let notebookGuid: string | undefined;
        let notebookWarning: string | undefined;

        if (notebookName) {
          const notebooks = await evernoteApi.listNotebooks();
          notebookCache = notebooks;
          const notebook = notebooks.find((nb) => nb.name === notebookName);
          if (notebook) {
            notebookGuid = notebook.guid;
          } else {
            // Notebook doesn't exist — auto-create it
            try {
              const newNotebook =
                await evernoteApi.createNotebook(notebookName);
              notebookGuid = newNotebook.guid;
              notebookWarning = `Notebook "${notebookName}" did not exist and was automatically created.`;
              clearEntityCaches();
            } catch (createError) {
              // Auto-create failed — fall back to the default notebook
              const defaultNb = notebooks.find((nb) => nb.defaultNotebook);
              notebookGuid = defaultNb?.guid;
              const fallbackName = defaultNb?.name || "the default notebook";
              notebookWarning =
                `Notebook "${notebookName}" does not exist and could not be auto-created ` +
                `(${errorMessage(createError)}). Note was placed in "${fallbackName}" instead.`;
            }
          }
        }

        const note = await evernoteApi.createNote({
          title,
          content,
          notebookGuid,
          tagNames: tags,
        });

        const resultText = `Note created successfully!\nGUID: ${note.guid}\nTitle: ${note.title}`;
        return {
          content: [
            {
              type: "text",
              text: notebookWarning
                ? `${resultText}\n\n⚠️ ${notebookWarning}`
                : resultText,
            },
          ],
        };
      }

      case "evernote_search_notes": {
        const {
          query,
          notebookName,
          maxResults = 20,
          offset = 0,
          includePreview = false,
          includeContent = false,
          format = "markdown",
        } = validatedArgs;

        // Full-body fetches are far heavier than metadata; cap them tighter.
        const effectiveMax = includeContent
          ? Math.min(maxResults, 25)
          : maxResults;

        // Resolve notebook name → GUID via the cache (no per-search API call).
        let notebookGuid: string | undefined;
        if (notebookName) {
          const notebooks = await getCachedNotebooks(evernoteApi);
          const notebook = notebooks.find((nb) => nb.name === notebookName);
          if (notebook) {
            notebookGuid = notebook.guid;
          }
        }

        // Evernote's match-all is expressed by OMITTING words; a bare "*" is
        // not a valid text term. Translate it so the documented export path
        // (query "*" + notebookName) works.
        const words = query.trim() === "*" ? undefined : query;

        const results = await evernoteApi.searchNotes({
          words,
          notebookGuid,
          offset,
          maxNotes: Math.min(effectiveMax, 100),
        });

        // Build tag lookup map (tagGuid -> tagName) from the cache.
        let tagMap: Map<string, string> | undefined;
        const hasAnyTags = results.notes.some(
          (note: any) => note.tagGuids && note.tagGuids.length > 0,
        );
        if (hasAnyTags) {
          const tags = await getCachedTags(evernoteApi);
          tagMap = new Map(tags.map((t: any) => [t.guid!, t.name!]));
        }

        // When full content is requested, fetch bodies once via the batch
        // helper and derive everything from that — no per-note double-fetch.
        let contentByGuid: Map<string, string | undefined> | undefined;
        let batchAborted: BatchFetchResult["aborted"];
        let batchFailed: BatchFetchResult["failed"] = [];
        // We just read each note's current USN from findNotesMetadata; pass it
        // to the cached reads so a body edited externally since it was cached is
        // treated as a miss instead of pairing a fresh title with a stale body.
        const knownUsns = new Map<string, number>(
          results.notes
            .filter((n: any) => typeof n.updateSequenceNum === "number")
            .map((n: any) => [n.guid, n.updateSequenceNum]),
        );
        if (includeContent && results.notes.length > 0) {
          const guids = results.notes.map((n: any) => n.guid);
          const batch = await evernoteApi.getNotesBatch(guids, {
            includeContent: true,
            format,
            knownUsns,
          });
          contentByGuid = new Map(batch.notes.map((n) => [n.guid, n.content]));
          batchAborted = batch.aborted;
          batchFailed = batch.failed;
        }

        // Build enhanced note results
        const notes = await Promise.all(
          results.notes.map(async (note: any) => {
            const enhanced: any = {
              guid: note.guid,
              title: note.title,
              created: new Date(note.created).toISOString(),
              updated: new Date(note.updated).toISOString(),
              contentLength: note.contentLength,
              notebookGuid: note.notebookGuid,
            };

            // Resolve tag names from GUIDs
            if (note.tagGuids && note.tagGuids.length > 0 && tagMap) {
              enhanced.tags = note.tagGuids
                .map((guid: string) => tagMap!.get(guid))
                .filter(Boolean);
            }

            // Include useful attributes if present
            if (note.attributes) {
              if (note.attributes.sourceURL) {
                enhanced.sourceURL = note.attributes.sourceURL;
              }
              if (note.attributes.author) {
                enhanced.author = note.attributes.author;
              }
            }

            if (contentByGuid) {
              // Full content requested — attach it; supersedes the preview.
              const content = contentByGuid.get(note.guid);
              if (content != null) {
                enhanced.content = content;
              }
            } else if (includePreview) {
              // Preview-only: one getNote per note (the minimum to preview a
              // body). Cheaper than fetching content twice.
              try {
                const preview = await evernoteApi.getNotePreview(
                  note.guid,
                  300,
                  knownUsns.get(note.guid),
                );
                if (preview) {
                  enhanced.preview = preview;
                }
              } catch (e) {
                // Skip preview on error, don't fail the whole search
                console.error(
                  `Failed to get preview for note ${note.guid}: ${(e as Error).message}`,
                );
              }
            }

            return enhanced;
          }),
        );

        const { notes: budgetedNotes, truncatedCount } = applyCharBudget(
          notes,
          MAX_RESPONSE_CHARS,
        );

        const returned = budgetedNotes.length;
        // When a content batch aborts mid-page, only advance past the notes
        // whose bodies were actually fetched — otherwise paging would skip the
        // un-fetched notes and the documented export loop would lose them. The
        // fetched count is exactly the size of contentByGuid.
        const progressed =
          batchAborted && contentByGuid ? contentByGuid.size : returned;
        const hasMore = batchAborted
          ? true
          : offset + returned < results.totalNotes;
        const payload: any = {
          totalNotes: results.totalNotes,
          offset,
          returned,
          hasMore,
          notes: budgetedNotes,
        };
        if (hasMore) {
          payload.nextOffset = offset + progressed;
        }
        if (includeContent && effectiveMax !== maxResults) {
          payload.maxResultsApplied = effectiveMax;
        }
        if (truncatedCount > 0) {
          payload.truncatedCount = truncatedCount;
        }
        if (batchFailed.length > 0) {
          payload.failed = batchFailed;
        }
        if (batchAborted) {
          payload.aborted = batchAborted;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      }

      case "evernote_get_note": {
        const {
          guid,
          guids,
          format = "markdown",
          includeContent = true,
          includeAttachmentText = true,
        } = validatedArgs;

        // Batch mode: body-focused fan-out with partial-results/resume on rate
        // limit. Attachment/OCR text is single-note only (use `guid`).
        if (guids && guids.length > 0) {
          const batch = await evernoteApi.getNotesBatch(guids, {
            includeContent,
            format,
          });

          // Best-effort name enrichment from the caches (no extra API calls).
          // getNote returns tags as GUIDs, so resolve them like search does.
          let notebookNames: Map<string, string> | undefined;
          let tagNames: Map<string, string> | undefined;
          const anyTags = batch.notes.some(
            (n) => n.tagGuids && n.tagGuids.length > 0,
          );
          try {
            const notebooks = await getCachedNotebooks(evernoteApi);
            notebookNames = new Map(notebooks.map((n) => [n.guid!, n.name!]));
            if (anyTags) {
              const tags = await getCachedTags(evernoteApi);
              tagNames = new Map(tags.map((t: any) => [t.guid!, t.name!]));
            }
          } catch {
            // enrichment is best-effort; never fail the batch over it.
          }

          const enriched = batch.notes.map((n) => {
            const out: any = {
              guid: n.guid,
              title: n.title,
              created: n.created,
              updated: n.updated,
            };
            if (n.notebookGuid) {
              out.notebookGuid = n.notebookGuid;
              const name = notebookNames?.get(n.notebookGuid);
              if (name) {
                out.notebookName = name;
              }
            }
            if (n.tagGuids && n.tagGuids.length > 0) {
              const names = n.tagGuids
                .map((g) => tagNames?.get(g))
                .filter(Boolean);
              if (names.length > 0) {
                out.tags = names;
              }
            }
            if (n.contentLength != null) {
              out.contentLength = n.contentLength;
            }
            if (n.content != null) {
              out.content = n.content;
            }
            return out;
          });

          const { notes, truncatedCount } = applyCharBudget(
            enriched,
            MAX_RESPONSE_CHARS,
          );

          const payload: any = { notes };
          if (batch.failed.length > 0) {
            payload.failed = batch.failed;
          }
          if (batch.aborted) {
            payload.aborted = batch.aborted;
          }
          if (truncatedCount > 0) {
            payload.truncatedCount = truncatedCount;
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(payload, null, 2),
              },
            ],
          };
        }

        // Fetch resources whenever attachment text/resource metadata is wanted, independent of includeContent.
        // When a body is requested, route through the USN-keyed cache; a
        // metadata-only read (includeContent=false) has no body to cache. On a
        // cache hit resource bodies are stripped, so attachment text below is
        // still extracted live.
        const note = includeContent
          ? await evernoteApi.getNoteCached(guid, {
              withResources: includeAttachmentText,
            })
          : await evernoteApi.getNote(guid, false, includeAttachmentText);

        const result: any = {
          guid: note.guid,
          title: note.title,
          created: new Date(note.created).toISOString(),
          updated: new Date(note.updated).toISOString(),
        };

        // Surface the containing notebook so callers don't need a separate
        // list_notebooks round-trip just to know where a note lives.
        if (note.notebookGuid) {
          result.notebookGuid = note.notebookGuid;
          try {
            const notebooks = await getCachedNotebooks(evernoteApi);
            const nb = notebooks.find((n) => n.guid === note.notebookGuid);
            if (nb) {
              result.notebookName = nb.name;
            }
          } catch {
            // notebookName is best-effort; never fail get_note over it.
          }
        }

        if (includeContent && note.content) {
          result.content = evernoteApi.renderNoteContent(
            note.content,
            note.resources,
            format,
          );
        }

        if (note.tagNames) {
          result.tags = note.tagNames;
        }

        // Include resource metadata; extract text for readable attachments.
        // Processed sequentially so a note with many attachments can't fan out
        // into unbounded concurrent binary downloads (rate-limit / memory pressure).
        if (note.resources && note.resources.length > 0) {
          const resources: any[] = [];
          for (const r of note.resources) {
            const resourceInfo: any = {
              guid: r.guid,
              filename: r.attributes?.fileName,
              mimeType: r.mime,
              size: r.data?.size || 0,
            };

            if (includeAttachmentText && r.guid && canExtractAttachmentText(r)) {
              // Reuse the resource body/recognition already fetched with the note when available.
              try {
                const attachmentText = await evernoteApi.extractResourceText(
                  r.guid,
                  r,
                );
                resourceInfo.attachmentText = attachmentText;
                if (r.mime === "application/pdf") {
                  resourceInfo.pdfText = attachmentText;
                } else {
                  resourceInfo.ocrText = attachmentText;
                }
              } catch (error) {
                const meta = getEvernoteErrorMeta(error);
                if (isAuthFailure(error) || meta.errorCode === 19) {
                  throw error;
                }
                const mimeSuffix = r.mime ? ` (mime: ${r.mime})` : "";
                resourceInfo.attachmentText =
                  `[No OCR text extraction available for resource${mimeSuffix}]`;
              }
            }

            resources.push(resourceInfo);
          }
          result.resources = resources;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "evernote_update_note": {
        const {
          guid,
          title,
          content,
          notebookName,
          tags,
          forceUpdate = false,
          replacements,
        } = validatedArgs;

        // Patch mode: targeted find-and-replace that preserves title, tags,
        // notebook, and existing attachments (absorbs the retired patch_note).
        if (replacements) {
          const result = await evernoteApi.patchNoteContent(guid, replacements);
          const changesSummary = result.changes
            .map(
              (c) =>
                `  • "${c.find}" → found ${c.occurrences}x, replaced ${c.replaced}x`,
            )
            .join("\n");

          if (result.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `✅ Note patched successfully!\nGUID: ${result.noteGuid}\n\nChanges:\n${changesSummary}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `⚠️ Note patch failed\nGUID: ${result.noteGuid}\nReason: ${result.warning}\n\nAttempted changes:\n${changesSummary}`,
              },
            ],
          };
        }

        console.error(`Updating note ${guid}`);

        let forceUpdateNotebookGuid: string | undefined;

        try {
          // Get existing note
          const note = await evernoteApi.getNote(guid, true, true);

          // Update fields
          if (title !== undefined) {
            note.title = title;
          }

          if (content !== undefined) {
            await evernoteApi.applyMarkdownToNote(note, content);
          }

          if (tags !== undefined) {
            note.tagNames = tags;
          }

          let notebookWarning: string | undefined;
          if (notebookName !== undefined) {
            const notebooks = await evernoteApi.listNotebooks();
            notebookCache = notebooks;
            const notebook = notebooks.find((nb) => nb.name === notebookName);
            if (notebook) {
              note.notebookGuid = notebook.guid;
            } else {
              // Auto-create the notebook
              try {
                const newNotebook =
                  await evernoteApi.createNotebook(notebookName);
                note.notebookGuid = newNotebook.guid;
                notebookWarning = `Notebook "${notebookName}" did not exist and was automatically created.`;
                clearEntityCaches();
              } catch (createError) {
                const defaultNb = notebooks.find((nb) => nb.defaultNotebook);
                note.notebookGuid = defaultNb?.guid;
                const fallbackName = defaultNb?.name || "the default notebook";
                notebookWarning =
                  `Notebook "${notebookName}" does not exist and could not be auto-created ` +
                  `(${errorMessage(createError)}). Note was moved to "${fallbackName}" instead.`;
              }
            }
            forceUpdateNotebookGuid = note.notebookGuid;
          }

          const updatedNote = await evernoteApi.updateNote(note);

          const resultText = `✅ Note updated successfully!\nGUID: ${updatedNote.guid}\nTitle: ${updatedNote.title}`;
          return {
            content: [
              {
                type: "text",
                text: notebookWarning
                  ? `${resultText}\n\n⚠️ ${notebookWarning}`
                  : resultText,
              },
            ],
          };
        } catch (stepError: any) {
          console.error(
            `Update failed for ${guid}: code=${stepError.errorCode || "none"}`,
          );

          // Handle RTE room conflict with forceUpdate option (requires confirmation)
          if (stepError.errorCode === 19 && forceUpdate) {
            console.error(
              `DESTRUCTIVE: Force update triggered for ${guid} - will delete original and create replacement`,
            );
            try {
              // Get the original note again for force update
              const originalNote = await evernoteApi.getNote(guid, true, true);

              // Create a new note with updated content
              const newNote = await evernoteApi.createNote({
                title: title || originalNote.title,
                content:
                  content ||
                  evernoteApi.convertENMLToMarkdown(
                    originalNote.content,
                    originalNote.resources,
                  ),
                notebookGuid:
                  forceUpdateNotebookGuid || originalNote.notebookGuid,
                tagNames: tags || originalNote.tagNames,
              });

              // Delete the old note
              await evernoteApi.deleteNote(guid);

              return {
                content: [
                  {
                    type: "text",
                    text:
                      `⚠️ Note update forced by creating new note due to edit lock!\n` +
                      `Original GUID: ${guid}\n` +
                      `New GUID: ${newNote.guid}\n` +
                      `Title: ${newNote.title}\n\n` +
                      `The original note was deleted and replaced with an updated version.`,
                  },
                ],
              };
            } catch (forceError) {
              const forceErrorMessage = errorMessage(forceError);
              console.error(`Force update also failed: ${forceErrorMessage}`);
              stepError.message += `\n\nForce update also failed: ${forceErrorMessage}`;
            }
          }

          throw stepError;
        }
      }

      case "evernote_delete_note": {
        const { guid } = validatedArgs;
        await evernoteApi.deleteNote(guid);

        return {
          content: [
            {
              type: "text",
              text: `Note ${guid} deleted successfully`,
            },
          ],
        };
      }

      case "evernote_list_notebooks": {
        const { name, guid } = validatedArgs;

        // Single-notebook lookup when name/guid is given (absorbs get_notebook).
        if (name || guid) {
          let notebook;
          if (guid) {
            notebook = await evernoteApi.getNotebook(guid);
          } else {
            const notebooks = await evernoteApi.listNotebooks();
            notebook = notebooks.find((nb) => nb.name === name);
            if (!notebook) {
              throw new Error(`Notebook '${name}' not found`);
            }
            notebook = await evernoteApi.getNotebook(notebook.guid);
          }
          return {
            content: [
              { type: "text", text: JSON.stringify(notebook, null, 2) },
            ],
          };
        }

        const notebooks = await getCachedNotebooks(evernoteApi);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(notebooks, null, 2),
            },
          ],
        };
      }

      case "evernote_create_notebook": {
        const { name, stack } = validatedArgs;
        const notebook = await evernoteApi.createNotebook(name, stack);
        clearEntityCaches();

        return {
          content: [
            {
              type: "text",
              text: `Notebook created successfully!\nGUID: ${notebook.guid}\nName: ${notebook.name}`,
            },
          ],
        };
      }

      case "evernote_list_tags": {
        const { name, guid } = validatedArgs;

        // Single-tag lookup when name/guid is given (absorbs get_tag).
        if (name || guid) {
          let tag;
          if (guid) {
            tag = await evernoteApi.getTag(guid);
          } else {
            const tags = await evernoteApi.listTags();
            tag = tags.find((t) => t.name === name);
            if (!tag) {
              throw new Error(`Tag '${name}' not found`);
            }
            tag = await evernoteApi.getTag(tag.guid!);
          }
          return {
            content: [{ type: "text", text: JSON.stringify(tag, null, 2) }],
          };
        }

        const tags = await getCachedTags(evernoteApi);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(tags, null, 2),
            },
          ],
        };
      }

      case "evernote_create_tag": {
        const { name, parentTagName } = validatedArgs;

        // Find parent tag GUID if name provided
        let parentGuid: string | undefined;
        if (parentTagName) {
          const tags = await evernoteApi.listTags();
          const parentTag = tags.find((t) => t.name === parentTagName);
          if (parentTag) {
            parentGuid = parentTag.guid;
          }
        }

        const tag = await evernoteApi.createTag(name, parentGuid);
        clearEntityCaches();

        return {
          content: [
            {
              type: "text",
              text: `Tag created successfully!\nGUID: ${tag.guid}\nName: ${tag.name}`,
            },
          ],
        };
      }

      // Resource tools
      case "evernote_get_resource": {
        const { guid, as } = validatedArgs;

        if (as === "text") {
          const text = await evernoteApi.extractResourceText(guid);
          return { content: [{ type: "text", text }] };
        }

        if (as === "recognition") {
          const recognition = await evernoteApi.getResourceRecognition(guid);
          const allText = evernoteApi.extractTextFromRecognition(recognition);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ...recognition,
                    extractedText: allText || "(no text recognized)",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // as: "binary" | "metadata" — both return resource info (incl. fileName
        // via withAttributes). binary adds the base64 body; metadata adds
        // hasRecognition (fetched without the body).
        const withData = as === "binary";
        const resource = await evernoteApi.getResource(
          guid,
          withData,
          as === "metadata",
          true,
        );

        const result: any = {
          guid: resource.guid,
          filename: resource.attributes?.fileName,
          mimeType: resource.mime,
          size: resource.data?.size || 0,
          hash: resource.data?.bodyHash
            ? Buffer.from(resource.data.bodyHash).toString("hex")
            : "",
        };

        if (as === "metadata") {
          result.hasRecognition = !!resource.recognition;
        }

        if (withData && resource.data?.body) {
          result.data = Buffer.from(resource.data.body).toString("base64");
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "evernote_add_resource_to_note": {
        const { noteGuid, filePath, filename } = validatedArgs;
        const updatedNote = await evernoteApi.addResourceToNote(
          noteGuid,
          filePath,
          filename,
        );

        return {
          content: [
            {
              type: "text",
              text: `✅ Resource added successfully!\nNote GUID: ${updatedNote.guid}\nNote Title: ${updatedNote.title}`,
            },
          ],
        };
      }

      // Retired from the default surface but preserved as a hidden, shape-exact
      // legacy handler: its response is a top-level array (with hash +
      // hasRecognition), which the get_note resources[] projection can't
      // reproduce. New callers should use evernote_get_note.
      case "evernote_list_note_resources": {
        warnDeprecatedAlias(
          "evernote_list_note_resources",
          "evernote_get_note",
        );
        const { noteGuid } = validatedArgs;
        const note = await evernoteApi.getNote(noteGuid, false, true);
        const resources = (note.resources || []).map((r: any) => ({
          guid: r.guid,
          filename: r.attributes?.fileName,
          mimeType: r.mime,
          size: r.data?.size || 0,
          hash: r.data?.bodyHash
            ? Buffer.from(r.data.bodyHash).toString("hex")
            : "",
          hasRecognition: !!r.recognition,
        }));

        return {
          content: [
            { type: "text", text: JSON.stringify(resources, null, 2) },
          ],
        };
      }

      case "evernote_update_notebook": {
        const { guid, name, stack } = validatedArgs;
        const notebook = await evernoteApi.getNotebook(guid);

        if (name !== undefined) {
          notebook.name = name;
        }
        if (stack !== undefined) {
          notebook.stack = stack || null; // Empty string removes stack
        }

        const updatedNotebook = await evernoteApi.updateNotebook(notebook);
        clearEntityCaches();

        return {
          content: [
            {
              type: "text",
              text: `✅ Notebook updated!\nGUID: ${updatedNotebook.guid}\nName: ${updatedNotebook.name}\nStack: ${updatedNotebook.stack || "(none)"}`,
            },
          ],
        };
      }

      case "evernote_update_tag": {
        const { guid, name, parentTagName } = validatedArgs;
        const tag = await evernoteApi.getTag(guid);

        if (name !== undefined) {
          tag.name = name;
        }
        if (parentTagName !== undefined) {
          if (parentTagName === "") {
            tag.parentGuid = null; // Remove parent
          } else {
            const tags = await evernoteApi.listTags();
            const parentTag = tags.find((t) => t.name === parentTagName);
            if (!parentTag) {
              throw new Error(`Parent tag '${parentTagName}' not found`);
            }
            tag.parentGuid = parentTag.guid;
          }
        }

        const updatedTag = await evernoteApi.updateTag(tag);
        clearEntityCaches();

        return {
          content: [
            {
              type: "text",
              text: `✅ Tag updated!\nGUID: ${updatedTag.guid}\nName: ${updatedTag.name}\nParent: ${updatedTag.parentGuid || "(none)"}`,
            },
          ],
        };
      }

      case "evernote_connection": {
        // Only action "user" reaches the switch — status/reconnect/revoke are
        // handled before ensureAPI() above so status can diagnose an
        // unauthenticated state.
        const [user, quota] = await Promise.all([
          evernoteApi.getUser(),
          evernoteApi.getQuotaInfo(),
        ]);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    name: user.name,
                  },
                  quota: quota,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    // Check if it's an authentication error that we can retry
    const isAuthError =
      error.message?.includes("Not connected") ||
      error.message?.includes("Authentication required") ||
      error.message?.includes("token") ||
      error.message?.includes("AUTHENTICATION_EXPIRED") ||
      error.errorCode === 9; // Evernote auth expired error code

    // If auth error and haven't retried yet, try once with forced reinit
    if (
      isAuthError &&
      name !== "evernote_reconnect" &&
      name !== "evernote_health_check"
    ) {
      console.error(
        `Auth error detected, attempting automatic recovery for ${name}...`,
      );
      try {
        // Force reinitialization
        await ensureAPI(true);

        // Verify reconnection succeeded
        console.error(`Verifying reconnection after ${name} failure...`);
        await ensureAPI();

        // Execute the same operation again (simplified - real implementation would need to rerun the switch)
        // For now, just inform user to retry
        return {
          content: [
            {
              type: "text",
              text:
                `⚠️ Connection was lost but has been restored.\n\n` +
                `Original error: ${error.message}\n\n` +
                `Please retry your operation.`,
            },
          ],
        };
      } catch (retryError: any) {
        console.error(`Auto-recovery failed: ${retryError.message}`);
        // Continue with normal error handling below
      }
    }

    const { errorCode, rateLimitDuration } = getEvernoteErrorMeta(error);
    const payload = buildToolErrorPayload(name, error);

    console.error(
      `Tool failed: ${name} at ${payload.timestamp} - ${error.message}` +
        `${errorCode ? ` (code: ${errorCode})` : ""}` +
        `${rateLimitDuration ? ` rateLimitDuration=${rateLimitDuration}s` : ""}`,
    );

    // Return a machine-parseable JSON error (no sensitive data). On rate limits
    // (errorCode 19) `error` is "rate_limited" and `retryAfterSeconds` carries
    // Evernote's exact backoff window so an agent can reschedule precisely.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Handle unhandled rejections - log and exit
process.on("unhandledRejection", (reason: any) => {
  console.error("Fatal: Unhandled rejection - process will exit");
  console.error("Reason:", reason?.message || reason);
  // Allow time for logs to flush before exiting
  setTimeout(() => process.exit(1), 1000);
});

// Handle uncaught exceptions - log and exit
process.on("uncaughtException", (error: Error) => {
  console.error("Fatal: Uncaught exception - process will exit");
  console.error("Error:", error.message);
  // Allow time for logs to flush before exiting
  setTimeout(() => process.exit(1), 1000);
});

// Start server
async function main() {
  console.error("Starting Evernote MCP server...");
  console.error(`Environment: ${ENVIRONMENT}`);
  console.error(
    `Polling: ${POLLING_ENABLED ? "enabled" : "disabled"} (interval: ${POLL_INTERVAL / 60000} min)`,
  );
  if (WEBHOOK_URL) {
    console.error(`Webhook URL: ${WEBHOOK_URL}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Evernote MCP server running on stdio");

  // Auto-start polling if enabled
  if (POLLING_ENABLED) {
    console.error("Auto-starting polling...");
    // Delay polling start to allow server to fully initialize
    setTimeout(() => {
      startPolling();
    }, 5000);
  }
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
