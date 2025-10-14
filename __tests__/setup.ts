import { jest } from '@jest/globals';

// Mock environment variables
process.env.EVERNOTE_CONSUMER_KEY = 'test-consumer-key';
process.env.EVERNOTE_CONSUMER_SECRET = 'test-consumer-secret';
process.env.EVERNOTE_ENVIRONMENT = 'sandbox';

// Global test timeout
jest.setTimeout(10000);

// Mock console.error to reduce noise in test output
const originalConsoleError = console.error;
console.error = jest.fn();

// Restore after tests
afterAll(() => {
  console.error = originalConsoleError;
});
