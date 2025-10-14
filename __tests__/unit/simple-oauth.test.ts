import { describe, beforeEach, it, expect } from '@jest/globals';

// Simple OAuth tests focusing on basic functionality
describe('OAuth Basic Tests', () => {
  beforeEach(() => {
    // Clear environment variables
    delete process.env.EVERNOTE_ACCESS_TOKEN;
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
});
