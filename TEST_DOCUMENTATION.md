# Testing Documentation

## Overview

This project implements a comprehensive automated testing strategy for the MCP Evernote server, covering unit tests, integration tests, end-to-end tests, and error scenarios.

## Test Structure

```
__tests__/
├── setup.ts                 # Global test setup
├── mocks/                   # Mock implementations
│   ├── evernote.mock.ts     # Evernote SDK mocks
│   ├── oauth.mock.ts        # OAuth flow mocks
│   └── mcp-server.mock.ts   # MCP Server mocks
├── unit/                    # Unit tests
│   ├── evernote-api.test.ts # EvernoteAPI class tests
│   ├── oauth.test.ts        # OAuth authentication tests
│   └── error-scenarios.test.ts # Error handling tests
├── integration/             # Integration tests
│   └── mcp-tools.test.ts    # MCP tool handler tests
└── e2e/                     # End-to-end tests
    └── mcp-protocol.test.ts # MCP protocol compliance tests
```

## Test Categories

### Unit Tests
- **EvernoteAPI Class**: Tests all CRUD operations, markdown conversion, and API interactions
- **OAuth Authentication**: Tests token management, environment detection, and authentication flows
- **Error Scenarios**: Comprehensive error handling for network, authentication, and API failures

### Integration Tests
- **MCP Tools**: Tests all 11 MCP tools with realistic scenarios
- **Tool Parameters**: Validates input schemas and parameter handling
- **Response Formats**: Ensures proper MCP response structure

### End-to-End Tests
- **Protocol Compliance**: Tests MCP server initialization and protocol adherence
- **Tool Discovery**: Validates tool listing and schema correctness
- **Request Handling**: Tests full request/response cycles

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

## Coverage Goals

- **Unit Tests**: ≥90% code coverage
- **Integration Tests**: All 11 MCP tools covered
- **Error Scenarios**: All major error paths tested
- **Protocol Compliance**: Full MCP specification adherence

## Mocking Strategy

### External Dependencies
- **Evernote SDK**: Comprehensive mocks for all API calls
- **File System**: Mock fs/promises for token file operations
- **MCP SDK**: Mock server and transport layers
- **Environment**: Controlled environment variable testing

### Test Data
- Realistic sample data for notes, notebooks, tags, and users
- Various error conditions and edge cases
- Authentication tokens in different states

## CI/CD Integration

### GitHub Actions Workflow
- **Multi-Node Testing**: Tests across Node.js 18.x, 20.x, 22.x
- **Cross-Platform**: Ubuntu, Windows, macOS compatibility
- **Security Auditing**: Automated vulnerability scanning
- **Build Validation**: Ensures artifacts are properly generated

### Quality Gates
- All tests must pass
- Type checking with TypeScript
- Linting with ESLint
- Security audit with audit-ci
- Coverage reporting with Codecov

## Best Practices

### Test Organization
- Each test file focuses on a specific component
- Tests are grouped by functionality using `describe` blocks
- Clear, descriptive test names that explain expected behavior

### Mock Management
- Centralized mock definitions in `/mocks/` directory
- Consistent mock reset patterns between tests
- Realistic mock data that reflects actual API responses

### Error Testing
- Comprehensive error scenario coverage
- Network failures, authentication issues, API errors
- Graceful degradation and proper error messages

### Maintenance
- Tests are updated alongside feature changes
- Mock data reflects current API specifications
- Regular review of test coverage and effectiveness

## Development Workflow

1. **Write Tests First**: Follow TDD principles for new features
2. **Run Tests Locally**: Use watch mode during development
3. **Check Coverage**: Ensure new code is properly tested
4. **Update Mocks**: Keep mocks in sync with API changes
5. **CI Validation**: All tests must pass before merging

## Troubleshooting

### Common Issues
- **Module Import Errors**: Check Jest ESM configuration
- **Mock Type Errors**: Ensure proper TypeScript mock typing
- **Timeout Issues**: Increase test timeout for slow operations
- **Coverage Gaps**: Add tests for uncovered code paths

### Debug Mode
```bash
# Run specific test with debug output
npm test -- __tests__/unit/evernote-api.test.ts --verbose

# Run with Node.js debugger
node --inspect-brk node_modules/.bin/jest --runInBand
```

This comprehensive testing strategy ensures the MCP Evernote server is reliable, maintainable, and follows best practices for production-ready code.
