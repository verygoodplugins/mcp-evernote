# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1](https://github.com/verygoodplugins/mcp-evernote/compare/mcp-evernote-v1.2.0...mcp-evernote-v1.2.1) (2026-01-21)


### Bug Fixes

* **ci:** use NPM_TOKEN for npm publish instead of OIDC ([0b92266](https://github.com/verygoodplugins/mcp-evernote/commit/0b92266e4fe1944a4b548422ea6790dce216e9e6))

## [1.2.0](https://github.com/verygoodplugins/mcp-evernote/compare/mcp-evernote-v1.1.0...mcp-evernote-v1.2.0) (2026-01-21)


### Features

* add CI/CD, MCP Registry, and standardization ([b27df0c](https://github.com/verygoodplugins/mcp-evernote/commit/b27df0c7abf710c8ddf0ad4363ff0b34ae61cd32))
* Add Claude Code support with automatic setup and OAuth integration ([42410db](https://github.com/verygoodplugins/mcp-evernote/commit/42410dbb12a5db21bdc7d5742709bc2c6ff16414))
* Add interactive auth prompts and fix executable permissions ([5552395](https://github.com/verygoodplugins/mcp-evernote/commit/5552395c2565af5cd6b8d2b4792c1e7d49326ee5))
* Add polling for Evernote changes with webhook notifications ([eea03b1](https://github.com/verygoodplugins/mcp-evernote/commit/eea03b12e4e7cdabc6fe937a57082cfcdac4c506))
* Initial implementation of Evernote MCP server ([2b3463a](https://github.com/verygoodplugins/mcp-evernote/commit/2b3463ac0493b72fcc63110c9ce3f66701f9d53b))
* **search:** add metadata and content preview to search results ([07ecf6c](https://github.com/verygoodplugins/mcp-evernote/commit/07ecf6cb0228d5d9d2147b66253e14f1a7b1fca6))
* **tools:** add evernote_patch_note for targeted find-and-replace edits ([f186076](https://github.com/verygoodplugins/mcp-evernote/commit/f186076ceb33c1f10cf7e8e0e5c8a97d55f5659b))


### Bug Fixes

* Add health check tool and improve error handling for MCP server stability ([0ed4c2b](https://github.com/verygoodplugins/mcp-evernote/commit/0ed4c2b6bd1a595b4ef505ae5ef8078572695fd3))
* **auth:** token file compatibility + release hardening ([ecc9771](https://github.com/verygoodplugins/mcp-evernote/commit/ecc9771093063e15fbbe957ca4451c865b7a1f72))
* **auth:** write token field; support legacy accessToken tokens ([6295537](https://github.com/verygoodplugins/mcp-evernote/commit/6295537b3a9d8274b18d6d27d8e4bd6e3ee4aac2))
* Fix ES module compatibility for Evernote SDK types ([5f0d3e5](https://github.com/verygoodplugins/mcp-evernote/commit/5f0d3e52bd130dbc4cda312db6b1b9e34f923217))
* Separate OAuth flow for Claude Desktop compatibility ([cc9ae07](https://github.com/verygoodplugins/mcp-evernote/commit/cc9ae070b597ada38008303fbc70d67b03c73cb0))
* **tests:** address CodeRabbit review comments ([9f4a089](https://github.com/verygoodplugins/mcp-evernote/commit/9f4a08987ec6c8ac854766c5972cabc81f17b171))
* upgrade CodeQL Action to v4 ([4317881](https://github.com/verygoodplugins/mcp-evernote/commit/4317881f4aaebeda1f3b6429f95a7bd5f632e22e))

## [Unreleased]

> Note: `v1.1.0` is the latest tagged release. The changes below are queued for the next release (expected `v1.2.0`) and will be finalized by Release Please when the release PR is merged.

### Added
- **Connection Resilience**: Automatic recovery from "Not connected" errors
  - Automatic retry mechanism with configurable delay (30s default)
  - Force reconnection capability with `evernote_reconnect` tool
  - Token expiry validation before operations
  - Graceful degradation on authentication failures
- **Change Polling**: Monitor Evernote for changes and send webhook notifications
  - Poll for new/updated/deleted notes on configurable interval (default: 1 hour, min: 15 min)
  - Webhook notifications to external endpoints (e.g., AutoJack memory system)
  - Auto-start polling via `EVERNOTE_POLLING_ENABLED=true`
  - Manual control: `evernote_start_polling`, `evernote_stop_polling`, `evernote_poll_now`, `evernote_polling_status`
- **Enhanced Token Management**: 
  - Proactive token expiry checking
  - Automatic cleanup of invalid/expired tokens
  - Warning when tokens are expiring soon (< 1 hour)
- **Robust Error Handling**:
  - Global unhandled rejection handler to prevent server crashes
  - Automatic API state reset on authentication errors
  - Clear error messages with actionable recovery steps

### Enhanced
- **Authentication Flow**: Better error messages distinguishing between different auth failure scenarios
- **Server Stability**: Process-level error handlers prevent complete server crashes
- **Health Check**: Improved diagnostics for connection state and token validity

### Fixed
- **Intermittent "Not connected" errors**: Server now automatically retries failed connections instead of staying in failed state
- **Persistent failure state**: API state is now properly reset after authentication errors
- **Token expiration handling**: Expired tokens are now detected and cleaned up proactively

### Technical Improvements
- Added `lastInitAttempt` tracking to prevent rapid retry loops
- Implemented configurable `INIT_RETRY_DELAY` for connection retry throttling
- Enhanced error detection for authentication-related failures (error code 9, token messages)
- Process-level exception handlers with automatic state recovery

## [1.1.0] - 2025-10-14

### Added
- **Enhanced Error Handling**: Comprehensive error debugging with detailed JSON output including tool name, arguments, timestamps, error details, and environment state
- **Retry Logic**: Automatic retry mechanism with exponential backoff for Evernote API Error Code 19 (RTE room conflicts)
- **Force Update Feature**: New `forceUpdate` parameter for `evernote_update_note` tool that creates a new note and deletes the original when encountering edit locks
- **Comprehensive Testing Framework**: 
  - Unit tests for core functionality (OAuth, markdown processing, error scenarios)
  - Integration tests for basic functionality and module imports
  - End-to-end tests for MCP protocol compliance
  - Jest configuration with TypeScript support
- **Continuous Integration**: GitHub Actions workflow for automated testing across multiple Node.js versions and operating systems
- **Test Scripts**: Added `test:watch`, `test:coverage`, `test:unit`, `test:integration`, and `test:e2e` npm scripts

### Enhanced
- **Note Update Process**: Step-by-step debugging logs for note update operations
- **Error Reporting**: Evernote-specific error codes and parameters now included in error responses
- **Development Workflow**: Improved development experience with comprehensive testing and CI/CD pipeline

### Fixed
- **RTE Room Conflicts**: Resolved persistent "RTE room has already been open" errors with intelligent retry and force update strategies
- **Module Resolution**: Fixed Jest configuration for ESM and TypeScript compatibility
- **Type Safety**: Improved TypeScript types and mock configurations for better development experience

### Technical Improvements
- Enhanced error logging with structured JSON output for easier debugging
- Robust handling of concurrent editing scenarios in Evernote
- Improved test coverage for critical functionality
- Better separation of concerns between unit, integration, and e2e tests

## [1.0.2] - 2025-10-13

### Added
- Initial release with core Evernote MCP server functionality
- OAuth authentication flow
- Note creation, reading, updating, and deletion
- Notebook and tag management
- Markdown to ENML conversion
- Search capabilities

### Features
- Complete Evernote API integration
- MCP protocol compliance
- Cross-platform support
- Environment detection (Claude Code vs standalone)
- Secure token management
