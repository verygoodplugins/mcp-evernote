// Copyright (c) 2026 raffishquartan. All rights reserved.
// Licensed for personal use only.

/**
 * Tests for file path validation (C1).
 *
 * Tests the validateFilePath logic directly without importing from
 * evernote-api.ts (which has ESM import chain issues under ts-jest).
 */
import { resolve } from 'path';

// Replicate the validation logic for direct testing.
// The canonical implementation lives in src/evernote-api.ts.
function validateFilePath(filePath: string): string {
  const resolved = resolve(filePath);
  if (!resolved.startsWith('/home/')) {
    throw new Error(
      `File path rejected: ${resolved} is outside the /home directory tree`,
    );
  }
  return resolved;
}

describe('validateFilePath (C1)', () => {
  it('rejects /etc/passwd', () => {
    expect(() => validateFilePath('/etc/passwd')).toThrow(/outside.*\/home/i);
  });

  it('accepts a path within /home', () => {
    expect(() => validateFilePath('/home/user/document.pdf')).not.toThrow();
  });

  it('rejects traversal that resolves outside /home', () => {
    expect(() => validateFilePath('/home/user/../../etc/passwd')).toThrow(
      /outside.*\/home/i,
    );
  });

  it('rejects /tmp paths', () => {
    expect(() => validateFilePath('/tmp/secret.txt')).toThrow(
      /outside.*\/home/i,
    );
  });

  it('rejects /root paths', () => {
    expect(() => validateFilePath('/root/.ssh/id_rsa')).toThrow(
      /outside.*\/home/i,
    );
  });

  it('accepts /home with nested directories', () => {
    expect(() =>
      validateFilePath('/home/chris/repos/file.txt'),
    ).not.toThrow();
  });

  it('returns the resolved path', () => {
    const result = validateFilePath('/home/user/docs/../file.txt');
    expect(result).toBe('/home/user/file.txt');
  });

  it('provides a descriptive error message', () => {
    expect(() => validateFilePath('/etc/shadow')).toThrow(
      'File path rejected: /etc/shadow is outside the /home directory tree',
    );
  });
});

describe('validateFilePath is used in evernote-api.ts (C1)', () => {
  it('addResourceToNote calls validateFilePath before readFile', () => {
    const { readFileSync } = require('fs');
    const source = readFileSync(
      require('path').resolve(__dirname, '../../src/evernote-api.ts'),
      'utf-8',
    );

    // The validateFilePath call should appear before readFile in addResourceToNote
    const addResourceBlock = source.match(
      /async addResourceToNote[\s\S]*?return await this\.updateNote/,
    );
    expect(addResourceBlock).not.toBeNull();
    expect(addResourceBlock![0]).toContain('validateFilePath(filePath)');

    // Ensure validateFilePath comes before readFile
    const validateIdx = addResourceBlock![0].indexOf('validateFilePath');
    const readFileIdx = addResourceBlock![0].indexOf('readFile(');
    expect(validateIdx).toBeLessThan(readFileIdx);
  });
});
