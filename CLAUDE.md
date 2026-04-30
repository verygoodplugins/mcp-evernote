# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Development
```bash
npm run build          # Compile TypeScript to dist/
npm run dev           # Watch mode with tsx for development
npm start             # Run compiled server from dist/
```

### Authentication
```bash
npm run auth          # Standalone OAuth flow for Claude Desktop
npm run auth:prod     # Run auth from compiled dist/
npm run setup         # Interactive setup wizard with environment detection
npm run setup:claude  # Install to Claude Code specifically
```

### Code Quality
```bash
npm run lint          # ESLint on src/**/*.ts
npm run format        # Prettier formatting on src/**/*.ts
npm test              # Run Jest tests
```

## Architecture

### MCP Server Pattern
This is a Model Context Protocol (MCP) server implementing the standard request/response pattern:
- Main server entry point at `src/index.ts` sets up StdioServerTransport
- Tools are defined with JSON schemas and registered via `setRequestHandler`
- Each tool maps to an Evernote API operation with parameter validation
- Error handling wraps all tool operations with contextual messages

### OAuth Authentication Flow
The authentication system detects the runtime environment and adapts accordingly:

1. **Environment Detection** (`src/oauth.ts`):
   - Checks for `MCP_TRANSPORT` or `CLAUDE_CODE_MCP` env vars to detect Claude Code
   - Claude Code: Expects OAuth through `/mcp` command with tokens in env vars
   - Claude Desktop: Uses standalone auth flow with token persistence to `.evernote-token.json`

2. **Token Resolution Order**:
   - Environment variables (`EVERNOTE_ACCESS_TOKEN`)
   - Claude Code OAuth tokens (`OAUTH_TOKEN`)
   - Persisted token file (`.evernote-token.json`) for compatibility
   - If none are found, emits clear instructions to stderr for Claude to relay to user

3. **Standalone Auth** (`src/auth-standalone.ts`):
   - Launches Express server on configurable port
   - Handles OAuth callback and token exchange
   - Saves `.evernote-token.json` and displays token for env-var migration

### Evernote API Integration
The `EvernoteAPI` class (`src/evernote-api.ts`) wraps the Evernote SDK:

1. **ENML Content Handling**:
   - `convertToENML()`: Transforms plain text/markdown to Evernote's XML format
   - `convertFromENML()`: Extracts readable text from ENML
   - All notes require proper ENML DOCTYPE and en-note wrapper

2. **Resource Pattern**:
   - Notes can have attached resources (files/images)
   - Resources require MIME type and binary data
   - Referenced in ENML via hash-based identifiers

3. **Search Architecture**:
   - Uses `NoteFilter` for query parameters
   - `NotesMetadataResultSpec` controls returned fields
   - Supports Evernote's advanced search syntax

### TypeScript Configuration
- ES2022 modules with strict mode enabled
- Compiles to ES modules (not CommonJS)
- Source maps and declarations generated
- All imports require `.js` extensions (even for `.ts` files)

## Key Implementation Patterns

### Tool Parameter Resolution
Many tools accept user-friendly names but require GUIDs internally:
- Notebook names → notebook GUIDs via `listNotebooks()` lookup
- Tag names → tag GUIDs via `listTags()` lookup
- Parent tag names resolved similarly for hierarchical tags

### Error Handling Strategy
- OAuth errors provide environment-specific guidance
- API errors wrapped with tool name context
- Missing notebooks/tags throw descriptive errors
- Token expiration triggers re-authentication flow

### Environment Variables
Required:
- `EVERNOTE_CONSUMER_KEY`: OAuth consumer key
- `EVERNOTE_CONSUMER_SECRET`: OAuth consumer secret

Optional:
- `EVERNOTE_ENVIRONMENT`: 'production' (default) or 'sandbox'
- `OAUTH_CALLBACK_PORT`: OAuth server port (default 3000)
- `EVERNOTE_ACCESS_TOKEN`: Access token (primary auth method)
- `EVERNOTE_WEBHOOK_SECRET`: HMAC secret for signing webhook payloads
- `EVERNOTE_ALLOWED_FILE_ROOTS`: path-delimited list of allowed local attachment roots

## Testing Considerations

### OAuth Testing
- Sandbox environment available for testing (`EVERNOTE_ENVIRONMENT=sandbox`)
- Requires separate sandbox account at sandbox.evernote.com
- Set `EVERNOTE_ACCESS_TOKEN` env var for CI/CD environments; `.evernote-token.json` remains a local fallback

### Tool Testing
- Each tool can be tested independently via MCP protocol
- Use `evernote_get_user_info` to verify authentication
- `evernote_list_notebooks` confirms API connectivity

## Deployment Notes

### Package Structure
- Main binary: `dist/index.js` (MCP server)
- Auth binary: `dist/auth-standalone.js` (OAuth flow)
- Both configured in `package.json` bin field
- Post-install script runs setup automatically

### Claude Code Integration
- Supports automatic OAuth via `/mcp` command
- Tokens managed by Claude Code infrastructure
- No local token storage needed

### Claude Desktop Integration
- Requires manual OAuth via `npm run auth`
- Token is saved to `.evernote-token.json` for compatibility and displayed for env-var configuration
- Prefer `EVERNOTE_ACCESS_TOKEN` in `claude_desktop_config.json` for new setups
