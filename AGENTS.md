# AGENTS.md

This file provides guidance to coding agents (Claude Code, Cursor, Codex, etc.) when working with this repository. It is the single source of truth; `CLAUDE.md` imports it via `@AGENTS.md`.

## Project Overview

**MCP Evernote** is an MCP (Model Context Protocol) server that integrates Evernote with AI assistants. It exposes note, notebook, tag, search, resource, and sync/polling operations as MCP tools over stdio, translating each call into an Evernote SDK operation. It is designed to work with both Claude Code (OAuth provided via env vars) and Claude Desktop (standalone OAuth flow).

**Core purpose:**
- Translate MCP tool calls into Evernote API operations over stdio
- Manage notes/notebooks/tags with Markdown ↔ ENML conversion and local-file attachments
- Detect the runtime environment and resolve Evernote auth tokens accordingly
- Optionally poll Evernote for changes and notify a webhook

## Build & Development

```bash
# Install dependencies
npm install

# Development with hot-reload (tsx watch on src/index.ts)
npm run dev

# Build TypeScript to dist/ (tsc, then chmod +x the bin entrypoints)
npm run build

# Start the built server (stdio mode)
npm start

# Standalone OAuth flow (Claude Desktop) — from source / from dist
npm run auth
npm run auth:prod

# Interactive setup wizard / install into Claude Code
npm run setup
npm run setup:claude

# Lint and format
npm run lint
npm run format

# Tests
npm test                  # full Jest suite
npm run test:unit         # __tests__/unit
npm run test:integration  # __tests__/integration
npm run test:e2e          # __tests__/e2e
npm run test:coverage     # with coverage
```

All scripts are defined in `package.json` `"scripts"`. The build emits to `dist/` and exposes two bins: `mcp-evernote` → `dist/index.js` and `mcp-evernote-auth` → `dist/auth-standalone.js` (`package.json` `bin`). Node `>=18.18.0` is required (`package.json` `engines`).

## Architecture

```
┌──────────────────────────────────────────────┐
│  MCP Client (Claude Code / Claude Desktop)    │
│  - Calls MCP tools over stdio                 │
└─────────────┬────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────┐
│  MCP Evernote Server (this TypeScript app)    │
│  - src/index.ts: Server + stdio transport,    │
│    ListTools/CallTool handlers                │
│  - src/oauth.ts: env detection + token order  │
│  - src/evernote-api.ts: Evernote SDK wrapper  │
│  - src/markdown.ts: Markdown ↔ ENML           │
└─────────────┬────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────┐
│  Evernote service (SDK / Thrift API + OAuth)  │
│  - NoteStore / UserStore, sync chunks         │
└──────────────────────────────────────────────┘
```

The server uses the classic MCP SDK pattern: a `Server` instance with
`setRequestHandler(ListToolsRequestSchema, …)` and
`setRequestHandler(CallToolRequestSchema, …)` over `StdioServerTransport`
(`src/index.ts:301`, `src/index.ts:752`, `src/index.ts:759`,
`src/index.ts:1705`). Tool arguments are validated with Zod via
`validateToolArgs` from `src/tool-schemas.ts` (`src/index.ts:14`).

### Code Organization

```
src/
├── index.ts            # MCP server entry: Server setup, tool definitions + CallTool handlers, polling wiring
├── evernote-api.ts     # EvernoteAPI class — SDK wrapper (CRUD, search, resources, sync); thin ENML conversion wrappers
├── markdown.ts         # Markdown ↔ ENML conversion (markdownToENML / enmlToMarkdown), GFM + local attachments
├── oauth.ts            # EvernoteOAuth — environment detection + token resolution order
├── auth-standalone.ts  # Standalone OAuth flow (Express /oauth/callback), persists .evernote-token.json
├── polling.ts          # Sync-state polling: detects note/notebook/tag changes via sync chunks
├── webhook.ts          # HMAC-SHA256 webhook signature compute/verify
├── path-security.ts    # Allow-listed local file path validation for attachments
├── tool-schemas.ts     # Zod schemas + validateToolArgs
├── types.ts            # Shared TypeScript interfaces (EvernoteConfig, OAuthTokens, …)
└── evernote.d.ts       # Ambient typings for the evernote SDK

__tests__/  unit/ · integration/ · e2e/ · mocks/  (Jest; see TEST_DOCUMENTATION.md)
dist/       build output — do not edit directly
scripts/    setup.js, install-to-claude.js, detect-environment.js, post-install.js
```

**Markdown ↔ ENML lives in `src/markdown.ts`.** `markdownToENML` and
`enmlToMarkdown` are defined and exported there (`src/markdown.ts:59`,
`src/markdown.ts:119`). `EvernoteAPI` only provides thin instance-method
wrappers — `convertMarkdownToENML` (`src/evernote-api.ts:538`) and
`convertENMLToMarkdown` (`src/evernote-api.ts:543`) — that delegate to those
functions (imported at `src/evernote-api.ts:4`). Do not add conversion logic
directly in `evernote-api.ts`.

## MCP Tools

The server defines **26 tools**, all prefixed `evernote_` (defined in the
tools array starting at `src/index.ts:316`). They cover notes
(`create_note`, `get_note`, `update_note`, `patch_note`, `delete_note`,
`search_notes`), notebooks (`list_notebooks`, `get_notebook`,
`create_notebook`, `update_notebook`), tags (`list_tags`, `get_tag`,
`create_tag`, `update_tag`), resources/attachments (`get_resource`,
`list_note_resources`, `add_resource_to_note`, `get_resource_recognition`),
auth/health (`get_user_info`, `revoke_auth`, `health_check`, `reconnect`),
and polling (`start_polling`, `stop_polling`, `poll_now`, `polling_status`).

Many tools accept user-friendly names but resolve to Evernote GUIDs
internally (notebook names → GUIDs via `listNotebooks()`, tag names → GUIDs
via `listTags()`, including hierarchical parent-tag resolution).

## Authentication

Token resolution is handled by `EvernoteOAuth.getAccessToken()` in
`src/oauth.ts`, in this order:

1. `EVERNOTE_ACCESS_TOKEN` env var (primary) — `src/oauth.ts:21`.
2. Claude Code OAuth token: only when env detection flags Claude Code **and**
   `OAUTH_TOKEN` is set — `src/oauth.ts:38`.
3. `.evernote-token.json` in the current working directory (standalone
   fallback) — `src/oauth.ts:13`, loaded at `src/oauth.ts:54`.
4. If none resolve, the server emits relay-to-user instructions to stderr.

Claude Code is detected when `MCP_TRANSPORT` or `CLAUDE_CODE_MCP` is set
(`src/oauth.ts:16`). The standalone flow (`src/auth-standalone.ts`) launches
an Express server, handles `/oauth/callback` (`src/auth-standalone.ts:149`),
and writes `.evernote-token.json` (`src/auth-standalone.ts:19`) while also
printing the token for env-var migration.

### Secrets

- Never commit secrets/tokens. The following are gitignored — treat them as
  sensitive and never paste their contents into logs, output, or memory
  tools: `.env*`, `.evernote-token.json`, `.evernote-credentials.json`,
  `.cursor/mcp.json` (`.gitignore:5-13`).
- Redact credentials from any output you produce.

## Environment Variables

Values are loaded from `.env` into `process.env` via `dotenv` (`config()` is
called at `src/index.ts:23`, and again in `src/auth-standalone.ts:12`), then
read with direct `process.env` lookups. Defaults shown are the literal
fallbacks in code.

| Variable | Default | Read at | Purpose |
|---|---|---|---|
| `EVERNOTE_CONSUMER_KEY` | — (required) | `src/index.ts:26` | OAuth consumer key; server exits if missing (`src/index.ts:29`,`44`) |
| `EVERNOTE_CONSUMER_SECRET` | — (required) | `src/index.ts:27` | OAuth consumer secret; server exits if missing (`src/index.ts:29`,`44`) |
| `EVERNOTE_ENVIRONMENT` | `production` | `src/index.ts:28` | `production` or `sandbox` (`sandbox` ⇒ `sandbox: true`, `src/index.ts:68`) |
| `EVERNOTE_ACCESS_TOKEN` | — | `src/oauth.ts:21` | Primary access token |
| `EVERNOTE_NOTESTORE_URL` | — | `src/oauth.ts:25` | NoteStore URL (fetched automatically if omitted) |
| `EVERNOTE_WEBAPI_URL` | — | `src/oauth.ts:26` | Web API URL prefix |
| `EVERNOTE_USER_ID` | — | `src/oauth.ts:27` | Evernote user ID (parsed int) |
| `OAUTH_TOKEN` | — | `src/oauth.ts:38` | Claude Code-provided token (only when Claude Code detected) |
| `OAUTH_NOTESTORE_URL` | — | `src/oauth.ts:42` | NoteStore URL for the Claude Code token |
| `OAUTH_WEBAPI_URL` | — | `src/oauth.ts:43` | Web API prefix for the Claude Code token |
| `OAUTH_USER_ID` | — | `src/oauth.ts:44` | User ID for the Claude Code token |
| `MCP_TRANSPORT` | — | `src/oauth.ts:16` | Presence flags Claude Code environment |
| `CLAUDE_CODE_MCP` | — | `src/oauth.ts:16` | Presence flags Claude Code environment |
| `OAUTH_CALLBACK_PORT` | `3000` | `src/auth-standalone.ts:35` | Standalone OAuth callback server port |
| `EVERNOTE_POLLING_ENABLED` | `false` (disabled) | `src/index.ts:56` | Polling on only when value is exactly `"true"` |
| `EVERNOTE_POLL_INTERVAL` | `3600000` (1 hour) | `src/index.ts:52` | Poll interval in ms; floored to 15-min minimum (`src/index.ts:48`,`50`) |
| `EVERNOTE_WEBHOOK_URL` | — | `src/index.ts:54` | URL notified on detected changes |
| `EVERNOTE_WEBHOOK_SECRET` | — | `src/index.ts:55` | HMAC-SHA256 signing secret for webhook payloads |
| `EVERNOTE_ALLOWED_FILE_ROOTS` | `[os.homedir(), process.cwd()]` | `src/path-security.ts:9` | `path.delimiter`-separated allow-list of roots for local attachments (default at `src/path-security.ts:6`) |

Notes:
- `EVERNOTE_POLL_INTERVAL` is clamped: the effective interval is
  `max(15min, EVERNOTE_POLL_INTERVAL)` — the 15-minute floor is an Evernote
  requirement (`src/index.ts:48`).
- `EVERNOTE_POLLING_ENABLED` is a strict equality check against `'true'`
  (`src/index.ts:56`), so any other value (including unset) leaves polling
  off.
- When changing webhook/polling behavior, validate against a real receiver
  (e.g. `curl`) and update/extend the relevant Jest tests.

## Coding Conventions

- TypeScript with ES modules (`"type": "module"`). **Keep `.js` extensions
  on relative imports in TS source** (e.g. `import { x } from './foo.js'`) —
  the build targets ES modules.
- Prefer changing code in `src/` and rebuilding; never edit `dist/` directly.
- Keep tool schemas (`src/tool-schemas.ts`) and their `CallTool` handlers
  (`src/index.ts`) aligned: validate input and return clear error messages.
- Run `npm run lint`, `npm run build`, and `npm test` before pushing.

## Branching & Releases

- **`main` is the integration branch and the PR target for day-to-day
  work.** Open PRs against `main`. (Historical docs that routed work through
  a `develop` branch are stale — recent merged PRs target `main` directly.)
- `main` is treated as **stable**; keep it green.
- **Release Please runs on `main`** (`.github/workflows/release-please.yml`,
  `on: push: branches: [main]`). Every push to `main` updates a Release PR;
  merging it bumps `package.json`, updates `CHANGELOG.md`, tags a GitHub
  Release, and publishes to npm via OIDC trusted publishing (no token).
- **Do not** hand-edit `CHANGELOG.md`, the version in `package.json`, or
  `.release-please-manifest.json` — Release Please owns these.
- CI (`.github/workflows/ci.yml`, `test.yml`) runs lint + build + test on
  pushes and PRs to both `main` and `develop`.

## Commit & PR Standards

This repo uses **Conventional Commits** so Release Please can generate
releases reliably.

- PR titles **must** be Conventional Commit format (the repo squash-merges,
  so the PR title becomes the merge commit and feeds Release Please).
- Prefixes: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`,
  `build`, `ci`, `revert`. Use `!` (`feat!:`) for breaking changes → major
  bump; `feat:` → minor; `fix:` → patch; `chore`/`docs` → no bump.
- Subjects are imperative mood.

```text
fix: resolve notebook GUID lookup for nested tags
feat: add evernote_patch_note tool
docs: clarify standalone OAuth callback port
chore: bump @modelcontextprotocol/sdk
```

## Testing

- After behavioral changes, run `npm test` and fix failures before stopping.
- Iterate with narrower runs (`npm run test:unit`, `npm run test:integration`,
  `npm run test:e2e`) but ensure the full suite is green before declaring success.
- Sandbox testing: set `EVERNOTE_ENVIRONMENT=sandbox` (requires a separate
  account at sandbox.evernote.com). For CI, prefer `EVERNOTE_ACCESS_TOKEN`;
  `.evernote-token.json` is a local fallback only.
- Quick connectivity checks: `evernote_get_user_info` verifies auth;
  `evernote_list_notebooks` confirms API connectivity.

<!-- BEGIN AUTOMEM RULES -->
## Memory-First Development (AutoMem)

Use the AutoMem memory MCP to keep persistent context across sessions for this repo.

### Conversation Start (Recall)
Recall for project context, architecture/decisions, debugging, refactors, integrations, and "why/how should this work?" questions. Skip for trivial edits.

Example:
```javascript
mcp__memory__recall_memory({
  query: "<current task>",
  tags: ["mcp-evernote"],
  limit: 5
})
```

### During Work (Store)
Store only high-signal items (decisions, root causes, reusable patterns, preferences). Avoid noise and never store secrets.

```javascript
mcp__memory__store_memory({
  content: "Brief title. Context and details. Impact/outcome.",
  tags: ["mcp-evernote", "<platform>", "<component>", "YYYY-MM"],
  importance: 0.8,
  metadata: {
    type: "Insight", // Decision | Pattern | Preference | Style | Habit | Context
    confidence: 0.95,
    files_modified: ["src/index.ts"]
  }
})
```

### Conversation End (Summarize)
If multiple files changed or the work was substantial, store a short "what changed + impact" memory.

### Tagging Convention
Include: `mcp-evernote` + platform tag (e.g., `cursor`/`codex`) + component + current month (`YYYY-MM`).

### Failure Handling
If memory tools fail or return nothing, continue without mentioning it; memory is an enhancement, not a blocker.
<!-- END AUTOMEM RULES -->
