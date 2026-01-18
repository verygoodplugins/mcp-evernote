# Testing Documentation

## Overview

This repository has a small Jest test suite focused on fast, offline verification (module import sanity checks, Markdown/ENML conversion, and OAuth/token handling). It also contains mocked integration/e2e tests that currently need updating to match the latest server/tooling behavior.

## Test Structure

```
__tests__/
├── setup.ts                      # Global test setup
├── mocks/                        # Mock implementations
│   ├── evernote.mock.ts          # Evernote SDK mocks
│   ├── oauth.mock.ts             # OAuth flow mocks
│   └── mcp-server.mock.ts        # MCP Server mocks
├── unit/                         # Unit tests
│   ├── markdown.test.ts          # Markdown ↔ ENML conversion
│   ├── simple-oauth.test.ts      # OAuth/token resolution basics
│   └── error-scenarios.test.ts   # Minimal error scenario coverage
├── integration/                  # Integration tests
│   ├── basic-functionality.test.ts # Import/build/package sanity checks
│   └── mcp-tools.test.ts         # Mocked MCP tool handler tests (currently skipped by default)
└── e2e/                          # End-to-end tests
    └── mcp-protocol.test.ts      # Mocked MCP protocol compliance tests (currently skipped by default)
```

## Test Categories

### Unit Tests
- **Markdown conversion**: Basic Markdown → ENML and ENML → Markdown behavior
- **OAuth/token resolution**: Environment variable behavior and local token file compatibility
- **Error scenarios**: Minimal sanity checks for error handling paths

### Integration Tests
- **Basic functionality**: Ensures the project can be imported and has expected build/package wiring
- **Mocked MCP tools**: A mocked MCP tools suite exists, but it is currently skipped by default via `jest.config.js` (see below)

### End-to-End Tests
- **Mocked protocol compliance**: A mocked MCP protocol suite exists, but it is currently skipped by default via `jest.config.js` (see below)

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test categories
npm run test:unit
npm run test:integration
npm run test:e2e

# Watch mode for development
npm run test:watch
```

### Skipped-by-default suites

`jest.config.js` currently excludes:

- `__tests__/integration/mcp-tools.test.ts`
- `__tests__/e2e/mcp-protocol.test.ts`

This means `npm test`, `npm run test:integration`, and `npm run test:e2e` will not execute those files until:
1) the ignore list is removed/updated, and
2) those test suites are brought back in sync with the current server version/tool list.

## Coverage Notes

- Coverage is collected from `src/**/*.ts`, but `src/index.ts` and `src/auth-standalone.ts` are excluded in `jest.config.js`.
- If increasing coverage is a release goal, re-enable and update the mocked integration/e2e tests first, then add targeted unit tests around the highest-risk code paths (OAuth/token persistence, tool handlers, polling/webhooks).

## Mocking Strategy

- **Evernote SDK**: Mocks for NoteStore/UserStore methods used by the server
- **File system**: `fs/promises` is mocked for token and credential file flows
- **MCP SDK**: Server and transport layers are mocked to capture request handlers
- **Environment**: Tests explicitly set/clear env vars to validate resolution order

## CI/CD Integration

GitHub Actions runs:
- Node matrix tests (18.x/20.x/22.x) and cross-platform smoke (`test.yml`)
- Lint + build + tests (`ci.yml`)
- Security checks (`npm audit`, `audit-ci`) depending on workflow configuration

## Troubleshooting

```bash
# Run a specific test file
npm test -- __tests__/unit/simple-oauth.test.ts --verbose

# Run Jest in-band (helpful for debugging flakiness)
npm test -- --runInBand

# Run with Node.js debugger
node --inspect-brk node_modules/.bin/jest --runInBand
```

Keeping this doc at repo root is fine here since the project already uses root-level docs like `CONNECTION_TROUBLESHOOTING.md` and `CHANGELOG.md`. If you prefer a more standard OSS layout, move it to `docs/testing.md` or merge it into `CONTRIBUTING.md` and link from `README.md`.
