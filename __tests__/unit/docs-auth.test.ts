import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('auth and security documentation', () => {
  const readme = readFileSync(resolve(__dirname, '../../README.md'), 'utf-8');
  const claude = readFileSync(resolve(__dirname, '../../CLAUDE.md'), 'utf-8');

  it('documents token-file fallback without claiming env-only auth', () => {
    expect(readme).toContain('EVERNOTE_ACCESS_TOKEN');
    expect(readme).toContain('.evernote-token.json');
    expect(claude).toContain('Persisted token file (`.evernote-token.json`)');
    expect(claude).not.toContain('env vars only');
    expect(claude).not.toContain('does NOT save to disk');
  });

  it('documents configurable local attachment roots', () => {
    expect(readme).toContain('EVERNOTE_ALLOWED_FILE_ROOTS');
    expect(claude).toContain('EVERNOTE_ALLOWED_FILE_ROOTS');
  });
});
