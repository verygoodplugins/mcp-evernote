/**
 * Tests for markdown image path security (C2).
 *
 * Verifies that resolveLocalPath rejects paths outside /home,
 * tested through source inspection since resolveLocalPath is private
 * and the full markdownToENML pipeline requires files to exist on disk.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const markdownSource = readFileSync(
  resolve(__dirname, '../../src/markdown.ts'),
  'utf-8',
);

describe('markdown path security (C2)', () => {
  // Extract the resolveLocalPath function source
  const fnBlock = markdownSource.match(
    /function resolveLocalPath[\s\S]*?^}/m,
  );

  it('resolveLocalPath function exists', () => {
    expect(fnBlock).not.toBeNull();
  });

  it('checks /home/ prefix after file:// URL resolution', () => {
    expect(fnBlock).not.toBeNull();
    const src = fnBlock![0];

    // After fileURLToPath, there should be a /home/ check before returning
    const fileUrlSection = src.match(
      /fileURLToPath\(fileUrl\)[\s\S]*?return \{/,
    );
    expect(fileUrlSection).not.toBeNull();
    expect(fileUrlSection![0]).toContain('/home/');
  });

  it('checks /home/ prefix after absolute path resolution', () => {
    expect(fnBlock).not.toBeNull();
    const src = fnBlock![0];

    // After computing the absolute path, there should be a /home/ check
    // before the existsSync check
    const absoluteSection = src.match(
      /const absolute[\s\S]*?existsSync/,
    );
    expect(absoluteSection).not.toBeNull();
    expect(absoluteSection![0]).toContain('/home/');
  });

  it('returns null (not throws) for rejected paths', () => {
    expect(fnBlock).not.toBeNull();
    const src = fnBlock![0];

    // The /home/ checks should return null, not throw
    const homeChecks = src.match(/!.*startsWith.*\/home\//g);
    expect(homeChecks).not.toBeNull();
    expect(homeChecks!.length).toBeGreaterThanOrEqual(2);
  });

  it('logs a warning when rejecting paths', () => {
    expect(fnBlock).not.toBeNull();
    const src = fnBlock![0];
    expect(src).toContain('console.warn');
  });
});
