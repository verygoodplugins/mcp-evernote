import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  hasConfiguredTokenSource,
  needsSetupNotice,
  TOKEN_FILE_NAME,
} from '../../src/auth-preflight.js';

/**
 * The server authenticates with an access token alone — consumer key/secret
 * belong to the standalone OAuth flow. These pin that a token-only setup (the
 * documented cookie-token path) is a valid configuration, which an earlier
 * unconditional consumer-key check made impossible by exiting at startup.
 */
describe('auth preflight', () => {
  const CWD = '/srv/app';
  const noFile = () => false;
  const tokenFileAt = (expected: string) => (filePath: string) =>
    filePath === expected;

  describe('hasConfiguredTokenSource', () => {
    it('accepts EVERNOTE_ACCESS_TOKEN on its own', () => {
      expect(
        hasConfiguredTokenSource(
          { EVERNOTE_ACCESS_TOKEN: 'S=s1:U=abc' },
          CWD,
          noFile,
        ),
      ).toBe(true);
    });

    it('accepts the Claude Code OAUTH_TOKEN only when that env is detected', () => {
      expect(
        hasConfiguredTokenSource(
          { OAUTH_TOKEN: 'tok', MCP_TRANSPORT: 'stdio' },
          CWD,
          noFile,
        ),
      ).toBe(true);
      expect(
        hasConfiguredTokenSource(
          { OAUTH_TOKEN: 'tok', CLAUDE_CODE_MCP: '1' },
          CWD,
          noFile,
        ),
      ).toBe(true);
      // Same ordering rule as oauth.ts: no detection flag, no OAuth token.
      expect(hasConfiguredTokenSource({ OAUTH_TOKEN: 'tok' }, CWD, noFile)).toBe(
        false,
      );
    });

    it('falls back to the token file in the working directory', () => {
      expect(
        hasConfiguredTokenSource(
          {},
          CWD,
          tokenFileAt(`${CWD}/${TOKEN_FILE_NAME}`),
        ),
      ).toBe(true);
      // A token file somewhere else does not count.
      expect(
        hasConfiguredTokenSource(
          {},
          CWD,
          tokenFileAt(`/elsewhere/${TOKEN_FILE_NAME}`),
        ),
      ).toBe(false);
    });

    it('reports nothing configured on an empty environment', () => {
      expect(hasConfiguredTokenSource({}, CWD, noFile)).toBe(false);
    });
  });

  describe('needsSetupNotice', () => {
    it('stays quiet for a token-only setup (the cookie-token path)', () => {
      expect(
        needsSetupNotice({ EVERNOTE_ACCESS_TOKEN: 'S=s1:U=abc' }, CWD, noFile),
      ).toBe(false);
    });

    it('stays quiet when consumer credentials can complete OAuth', () => {
      expect(
        needsSetupNotice(
          {
            EVERNOTE_CONSUMER_KEY: 'key',
            EVERNOTE_CONSUMER_SECRET: 'secret',
          },
          CWD,
          noFile,
        ),
      ).toBe(false);
    });

    it('warns when neither a token nor a complete consumer pair is present', () => {
      expect(needsSetupNotice({}, CWD, noFile)).toBe(true);
      // A half-configured consumer pair cannot complete OAuth either.
      expect(
        needsSetupNotice({ EVERNOTE_CONSUMER_KEY: 'key' }, CWD, noFile),
      ).toBe(true);
      expect(
        needsSetupNotice({ EVERNOTE_CONSUMER_SECRET: 'secret' }, CWD, noFile),
      ).toBe(true);
    });

    it('stays quiet for a token file even with no consumer credentials', () => {
      expect(
        needsSetupNotice({}, CWD, tokenFileAt(`${CWD}/${TOKEN_FILE_NAME}`)),
      ).toBe(false);
    });
  });

  describe('startup wiring', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../src/index.ts'),
      'utf-8',
    );

    it('gates the notice on the preflight rather than the consumer key alone', () => {
      expect(source).toContain('needsSetupNotice()');
    });

    it('does not exit when consumer credentials are missing', () => {
      // The old check printed this banner and then called process.exit(1),
      // which made a token-only (cookie) setup impossible to start.
      expect(source).not.toContain('EVERNOTE MCP SERVER - CONFIGURATION ERROR');
    });
  });
});
