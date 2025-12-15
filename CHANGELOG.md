# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2025-12-15

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
