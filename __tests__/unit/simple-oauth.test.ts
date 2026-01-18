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
    
    // Import after setting env var
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

  it('should read legacy token files that use accessToken', async () => {
    const originalCwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-evernote-oauth-'));

    try {
      process.chdir(tempDir);
      await fs.writeFile(
        path.join(tempDir, '.evernote-token.json'),
        JSON.stringify(
          {
            accessToken: 'legacy-token',
            noteStoreUrl: 'https://test.evernote.com/notestore',
            userId: 123,
          },
          null,
          2
        )
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

      expect(tokens.token).toBe('legacy-token');
      expect(tokens.noteStoreUrl).toBe('https://test.evernote.com/notestore');
      expect(tokens.userId).toBe(123);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
