import { describe, beforeEach, it, expect } from '@jest/globals';

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

  it('should not have file-based token loading', () => {
    const { EvernoteOAuth } = require('../../src/oauth');
    const config = {
      consumerKey: 'test-key',
      consumerSecret: 'test-secret',
      sandbox: true,
      china: false,
    };

    const oauth = new EvernoteOAuth(config);
    // loadToken method should no longer exist
    expect((oauth as any).loadToken).toBeUndefined();
    // tokenFile property should no longer exist
    expect((oauth as any).tokenFile).toBeUndefined();
  });

  it('revokeToken should not attempt file deletion', async () => {
    const { EvernoteOAuth } = require('../../src/oauth');
    const config = {
      consumerKey: 'test-key',
      consumerSecret: 'test-secret',
      sandbox: true,
      china: false,
    };

    const oauth = new EvernoteOAuth(config);
    // Should not throw - just logs instructions
    await expect(oauth.revokeToken()).resolves.not.toThrow();
  });
});
