import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('auth and security documentation', () => {
  const readme = readFileSync(resolve(__dirname, '../../README.md'), 'utf-8');
  // CLAUDE.md is now the bare `@AGENTS.md` import; AGENTS.md holds the canonical
  // agent-direction content, so assert the documentation guarantees against it.
  const agents = readFileSync(resolve(__dirname, '../../AGENTS.md'), 'utf-8');

  it('documents token-file fallback without claiming env-only auth', () => {
    expect(readme).toContain('EVERNOTE_ACCESS_TOKEN');
    expect(readme).toContain('.evernote-token.json');
    expect(agents).toContain('.evernote-token.json');
    expect(agents).toContain('local fallback only');
    expect(agents).not.toContain('env vars only');
    expect(agents).not.toContain('does NOT save to disk');
  });

  it('documents configurable local attachment roots', () => {
    expect(readme).toContain('EVERNOTE_ALLOWED_FILE_ROOTS');
    expect(agents).toContain('EVERNOTE_ALLOWED_FILE_ROOTS');
  });
});
