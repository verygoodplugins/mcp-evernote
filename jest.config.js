// Jest runs in native ESM mode (package.json "type": "module"). The test
// scripts start Jest under `node --experimental-vm-modules`, and ts-jest emits
// ESM, so ESM-only dependencies (e.g. sanitize-html 2.17.6+ -> htmlparser2 12)
// load without being transpiled. Module mocks must therefore use
// `jest.unstable_mockModule` + dynamic `import()`; `jest.mock` hoisting and
// `require`/`__dirname` are CJS-only and unavailable in test files.
//
// On Node < 24.9 Jest cannot require() ESM from a CommonJS dependency, which
// sanitize-html (CJS) does for htmlparser2 12 (ESM-only). There we map
// sanitize-html to a CJS bundle of the installed version; see
// __tests__/support/sanitize-html-shim.js.
import { needsSanitizeHtmlShim, shimPath } from './__tests__/support/sanitize-html-shim.js';

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true }],
  },
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  testPathIgnorePatterns: [
    '__tests__/e2e/mcp-protocol.test.ts',
    // Integration tests disabled due to ESM module compatibility issues with @modelcontextprotocol/sdk
    // The resource/OCR functionality is covered by unit tests in recognition.test.ts
    '__tests__/integration/mcp-tools.test.ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/auth-standalone.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    ...(needsSanitizeHtmlShim && { '^sanitize-html$': shimPath('<rootDir>') }),
  },
  ...(needsSanitizeHtmlShim && { globalSetup: '<rootDir>/__tests__/support/sanitize-html-shim.js' }),
  testTimeout: 10000,
  verbose: true,
};
