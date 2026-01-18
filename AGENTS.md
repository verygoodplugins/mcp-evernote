# Repository Guidelines (mcp-evernote)

Model Context Protocol (MCP) server that integrates with Evernote for note, notebook, tag, search, and sync/polling operations. Designed to work with both Claude Code and Claude Desktop.

## Project Structure

- `src/index.ts` — MCP server entry (stdio transport) and tool handlers
- `src/evernote-api.ts` — Evernote SDK wrapper (CRUD, search, resources, sync)
- `src/oauth.ts` — token resolution + environment detection (Claude Code vs standalone)
- `src/auth-standalone.ts` — standalone OAuth flow (Express `/oauth/callback`)
- `src/markdown.ts` — Markdown ↔ ENML conversion (GFM + local attachments)
- `dist/` — build output (do not edit directly)
- `__tests__/` — Jest unit/integration/e2e tests (see `TEST_DOCUMENTATION.md`)

## Build, Test & Development

- Install: `npm install`
- Dev (watch): `npm run dev`
- Build: `npm run build`
- Run server (built): `npm start`
- Auth (standalone OAuth): `npm run auth` (or `npm run auth:prod` from `dist/`)
- Setup wizard: `npm run setup` (or `npm run setup:claude`)
- Lint: `npm run lint`
- Format: `npm run format`
- Tests: `npm test` (or `npm run test:unit|test:integration|test:e2e`)

## Coding Conventions (Important)

- TypeScript + ES modules (`"type": "module"`). Keep imports using `.js` extensions in TS (e.g., `import { x } from './foo.js'`).
- Prefer changing code in `src/` and rebuilding; avoid editing `dist/` directly.
- Keep tool schemas and handlers aligned (input validation + clear error messages).

## Authentication & Secrets

- Token resolution (roughly): env (`EVERNOTE_ACCESS_TOKEN`) → Claude Code OAuth env (`OAUTH_TOKEN`) → `.evernote-token.json` (standalone).
- Never commit secrets/tokens. Be careful with local config files like `.env`, `.evernote-token.json`, `.evernote-credentials.json`, and `.cursor/mcp.json`.
- Redact credentials from logs/output and never store secrets in memory tools.

## Polling / Webhook Notes

- Polling config: `EVERNOTE_POLLING_ENABLED`, `EVERNOTE_POLL_INTERVAL` (min 15m), `EVERNOTE_WEBHOOK_URL`.
- If you change webhook/polling behavior, validate with a real endpoint (e.g., `curl` against your webhook receiver) and update/extend relevant Jest tests.

## Testing Expectations

- After making behavioral changes, run `npm test` and fix failures before stopping.
- Prefer narrower test runs while iterating (`npm run test:unit`, etc.), but ensure the full suite (`npm test`) is green before declaring success.

## Branching & Releases (Railway Deploys From `main`)

- Treat `main` as **stable** (Railway template users auto-deploy from it).
- Do day-to-day work via PRs into `develop`.
- When ready to ship to users: open a PR from `develop` → `main` and merge it.
- Release Please runs on `main`; merge the Release Please PR when you’re ready to tag/publish.

<!-- BEGIN AUTOMEM RULES -->
## Memory-First Development (AutoMem)

Use the AutoMem memory MCP to keep persistent context across sessions for this repo.

### Conversation Start (Recall)
Recall for project context, architecture/decisions, debugging, refactors, integrations, and “why/how should this work?” questions. Skip for trivial edits.

Example:
```javascript
mcp_memory_recall_memory({
  query: "<current task>",
  tags: ["mcp-evernote"],
  limit: 5
})
```

### During Work (Store)
Store only high-signal items (decisions, root causes, reusable patterns, preferences). Avoid noise and never store secrets.

```javascript
mcp_memory_store_memory({
  content: "Brief title. Context and details. Impact/outcome.",
  type: "Insight", // Decision | Pattern | Preference | Style | Habit | Context
  confidence: 0.95,
  tags: ["mcp-evernote", "<component>", "<platform>", "YYYY-MM"],
  importance: 0.8,
  metadata: { files_modified: ["src/index.ts"] }
})
```

### Conversation End (Summarize)
If multiple files changed or the work was substantial, store a short “what changed + impact” memory.

### Tagging Convention
Include: `mcp-evernote` + platform tag (e.g., `cursor`/`codex`) + component + current month (`YYYY-MM`).

### Failure Handling
If memory tools fail or return nothing, continue without mentioning it; memory is an enhancement, not a blocker.
<!-- END AUTOMEM RULES -->
