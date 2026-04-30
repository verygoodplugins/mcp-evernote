import { describe, beforeEach, it, expect } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Simple OAuth tests focusing on basic functionality
describe('OAuth Basic Tests', () => {
  beforeEach(() => {
    // Clear environment variables
    delete process.env.EVERNOTE_ACCESS_TOKEN;
    delete process.env.EVERNOTE_NOTESTORE_URL;
    delete process.env.EVERNOTE_WEBAPI_URL;
    delete process.env.EVERNOTE_USER_ID;
    delete process.env.OAUTH_TOKEN;
    delete process.env.OAUTH_NOTESTORE_URL;
    delete process.env.OAUTH_WEBAPI_URL;
    delete process.env.OAUTH_USER_ID;
    delete process.env.MCP_TRANSPORT;
    delete process.env.CLAUDE_CODE_MCP;
  });

  it('should detect Claude Code environment correctly', () => {
    process.env.MCP_TRANSPORT = 'stdio';

    const { EvernoteOAuth } = require('../../src/oauth');
    const config = {
      consumerKey: 'test-key',
      consumerSecret: 'test-secret',
      sandbox: true,
      china: false,
    };

    const oauth = new EvernoteOAuth(config);
    expect((oauth as any).isClaudeCode).toBe(true);
  });

  it('should handle environment variables for tokens', async () => {
    process.env.EVERNOTE_ACCESS_TOKEN = 'test-token';
    process.env.EVERNOTE_NOTESTORE_URL = 'https://test.evernote.com';

    const { EvernoteOAuth } = require('../../src/oauth');
    const config = {
      consumerKey: 'test-key',
      consumerSecret: 'test-secret',
      sandbox: true,
      china: false,
    };

    const oauth = new EvernoteOAuth(config);
    const tokens = await oauth.getAccessToken();

    expect(tokens.token).toBe('test-token');
    expect(tokens.noteStoreUrl).toBe('https://test.evernote.com');
  });

  it('should throw authentication error when no tokens available', async () => {
    const { EvernoteOAuth } = require('../../src/oauth');
    const config = {
      consumerKey: 'test-key',
      consumerSecret: 'test-secret',
      sandbox: true,
      china: false,
    };

    const oauth = new EvernoteOAuth(config);
    await expect(oauth.getAccessToken()).rejects.toThrow('Authentication required');
  });

  it('should use OAUTH_TOKEN when in Claude Code environment', async () => {
    process.env.MCP_TRANSPORT = 'stdio';
    process.env.OAUTH_TOKEN = 'claude-code-token';
    process.env.OAUTH_NOTESTORE_URL = 'https://test.evernote.com/notestore';

    const { EvernoteOAuth } = require('../../src/oauth');
    const config = {
      consumerKey: 'test-key',
      consumerSecret: 'test-secret',
      sandbox: true,
      china: false,
    };

    const oauth = new EvernoteOAuth(config);
    const tokens = await oauth.getAccessToken();

    expect(tokens.token).toBe('claude-code-token');
    expect(tokens.noteStoreUrl).toBe('https://test.evernote.com/notestore');
  });

  it('should read compatible token files as a fallback', async () => {
    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-evernote-oauth-'));
    process.chdir(tempDir);

    try {
      await fs.writeFile(
        path.join(tempDir, '.evernote-token.json'),
        JSON.stringify({
          accessToken: 'legacy-file-token',
          noteStoreUrl: 'https://test.evernote.com/notestore',
          userId: 123,
        }),
      );

      const { EvernoteOAuth } = require('../../src/oauth');
      const config = {
        consumerKey: 'test-key',
        consumerSecret: 'test-secret',
        sandbox: true,
        china: false,
      };

      const oauth = new EvernoteOAuth(config);
      const tokens = await oauth.getAccessToken();

      expect(tokens.token).toBe('legacy-file-token');
      expect(tokens.noteStoreUrl).toBe('https://test.evernote.com/notestore');
      expect(tokens.userId).toBe(123);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should prefer env tokens over token files', async () => {
    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-evernote-oauth-'));
    process.chdir(tempDir);
    process.env.EVERNOTE_ACCESS_TOKEN = 'env-token';
    process.env.EVERNOTE_NOTESTORE_URL = 'https://env.evernote.com/notestore';

    try {
      await fs.writeFile(
        path.join(tempDir, '.evernote-token.json'),
        JSON.stringify({
          token: 'file-token',
          noteStoreUrl: 'https://file.evernote.com/notestore',
        }),
      );

      const { EvernoteOAuth } = require('../../src/oauth');
      const config = {
        consumerKey: 'test-key',
        consumerSecret: 'test-secret',
        sandbox: true,
        china: false,
      };

      const oauth = new EvernoteOAuth(config);
      const tokens = await oauth.getAccessToken();

      expect(tokens.token).toBe('env-token');
      expect(tokens.noteStoreUrl).toBe('https://env.evernote.com/notestore');
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('revokeToken should remove compatible token files when present', async () => {
    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-evernote-oauth-'));
    process.chdir(tempDir);
    const tokenPath = path.join(tempDir, '.evernote-token.json');

    try {
      await fs.writeFile(tokenPath, JSON.stringify({ token: 'file-token' }));

      const { EvernoteOAuth } = require('../../src/oauth');
      const config = {
        consumerKey: 'test-key',
        consumerSecret: 'test-secret',
        sandbox: true,
        china: false,
      };

      const oauth = new EvernoteOAuth(config);
      await expect(oauth.revokeToken()).resolves.not.toThrow();
      await expect(fs.access(tokenPath)).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should keep token-file internals private to callers', () => {
    const { EvernoteOAuth } = require('../../src/oauth');
    const config = {
      consumerKey: 'test-key',
      consumerSecret: 'test-secret',
      sandbox: true,
      china: false,
    };

    const oauth = new EvernoteOAuth(config);
    expect(typeof (oauth as any).tokenFile).toBe('string');
    expect(typeof (oauth as any).loadToken).toBe('function');
  });
});
