# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
