/**
 * Tests for process error handlers (M5).
 *
 * We cannot directly test process.on('uncaughtException') without risking
 * the test runner itself. Instead we verify the handler behaviour indirectly
 * by reading the source and confirming the handlers call process.exit.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const indexSource = readFileSync(
  resolve(__dirname, '../../src/index.ts'),
  'utf-8',
);

describe('process error handlers (M5)', () => {
  it('uncaughtException handler calls process.exit', () => {
    // The handler should contain process.exit(1)
    const uncaughtBlock = indexSource.match(
      /process\.on\('uncaughtException'[\s\S]*?\}\);/,
    );
    expect(uncaughtBlock).not.toBeNull();
    expect(uncaughtBlock![0]).toContain('process.exit(1)');
  });

  it('uncaughtException handler does not attempt recovery', () => {
    const uncaughtBlock = indexSource.match(
      /process\.on\('uncaughtException'[\s\S]*?\}\);/,
    );
    expect(uncaughtBlock).not.toBeNull();
    // Should NOT contain state reset logic
    expect(uncaughtBlock![0]).not.toContain('api = null');
    expect(uncaughtBlock![0]).not.toContain('apiInitError = null');
  });

  it('unhandledRejection handler calls process.exit', () => {
    const rejectionBlock = indexSource.match(
      /process\.on\('unhandledRejection'[\s\S]*?\}\);/,
    );
    expect(rejectionBlock).not.toBeNull();
    expect(rejectionBlock![0]).toContain('process.exit(1)');
  });

  it('unhandledRejection handler does not attempt recovery', () => {
    const rejectionBlock = indexSource.match(
      /process\.on\('unhandledRejection'[\s\S]*?\}\);/,
    );
    expect(rejectionBlock).not.toBeNull();
    expect(rejectionBlock![0]).not.toContain('api = null');
  });

  it('handlers do not log full stack traces', () => {
    const uncaughtBlock = indexSource.match(
      /process\.on\('uncaughtException'[\s\S]*?\}\);/,
    );
    expect(uncaughtBlock).not.toBeNull();
    expect(uncaughtBlock![0]).not.toContain('error.stack');
  });
});
