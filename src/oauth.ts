import * as Evernote from 'evernote';
import fs from 'fs/promises';
import path from 'path';
import { EvernoteConfig, OAuthTokens } from './types.js';

export class EvernoteOAuth {
  private config: EvernoteConfig;
  private tokenFile: string;
  private isClaudeCode: boolean;

  constructor(config: EvernoteConfig) {
    this.config = config;
    this.tokenFile = path.join(process.cwd(), '.evernote-token.json');
    
    // Detect if running in Claude Code
    this.isClaudeCode = !!(process.env.MCP_TRANSPORT || process.env.CLAUDE_CODE_MCP);
  }

  async getAccessToken(): Promise<OAuthTokens> {
    // Check for token in environment variable first (for CI/CD or secure deployments)
    if (process.env.EVERNOTE_ACCESS_TOKEN) {
      console.error('Using Evernote access token from environment variable');
      return {
        token: process.env.EVERNOTE_ACCESS_TOKEN,
        noteStoreUrl: process.env.EVERNOTE_NOTESTORE_URL,
        webApiUrlPrefix: process.env.EVERNOTE_WEBAPI_URL,
        userId: process.env.EVERNOTE_USER_ID ? parseInt(process.env.EVERNOTE_USER_ID) : undefined
      };
    }
    
    // Check if Claude Code is providing OAuth tokens
    // Claude Code may pass tokens after /mcp authentication
    if (this.isClaudeCode && process.env.OAUTH_TOKEN) {
      console.error('Using OAuth token from Claude Code');
      return {
        token: process.env.OAUTH_TOKEN,
        noteStoreUrl: process.env.OAUTH_NOTESTORE_URL,
        webApiUrlPrefix: process.env.OAUTH_WEBAPI_URL,
        userId: process.env.OAUTH_USER_ID ? parseInt(process.env.OAUTH_USER_ID) : undefined
      };
    }
    
    // Try to load existing token from file
    const existingToken = await this.loadToken();
    if (existingToken) {
      console.error('Using existing Evernote access token from file');
      return existingToken;
    }

    // Different messages for Claude Code vs Claude Desktop
    if (this.isClaudeCode) {
      // In Claude Code, suggest using /mcp command
      console.error('═══════════════════════════════════════════════════════════');
      console.error('🔐 AUTHENTICATION REQUIRED');
      console.error('═══════════════════════════════════════════════════════════');
      console.error('');
      console.error('No Evernote authentication token found.');
      console.error('');
      console.error('To authenticate in Claude Code:');
      console.error('1. Type: /mcp');
      console.error('2. Select "Evernote"');
      console.error('3. Choose "Authenticate"');
      console.error('');
      console.error('Claude Code will handle the OAuth flow automatically.');
      console.error('═══════════════════════════════════════════════════════════');
      
      throw new Error('Authentication required. Use /mcp command in Claude Code to authenticate.');
    } else {
      // In Claude Desktop or other environments
      console.error('═══════════════════════════════════════════════════════════');
      console.error('🔐 AUTHENTICATION REQUIRED');
      console.error('═══════════════════════════════════════════════════════════');
      console.error('');
      console.error('No Evernote authentication token found.');
      console.error('');
      console.error('Please run the authentication setup first:');
      console.error('');
      console.error('  npm run auth');
      console.error('');
      console.error('Or if running from source:');
      console.error('');
      console.error('  npx tsx src/auth-standalone.ts');
      console.error('');
      console.error('This will open your browser to authenticate with Evernote');
      console.error('and save the token for future use.');
      console.error('═══════════════════════════════════════════════════════════');
      
      throw new Error('Authentication required. Please run "npm run auth" first.');
    }
  }

  private async loadToken(): Promise<OAuthTokens | null> {
    try {
      const data = await fs.readFile(this.tokenFile, 'utf-8');
      const tokens = JSON.parse(data) as OAuthTokens;
      
      // Check if token is expired (if expiration is set)
      if (tokens.expires && tokens.expires < Date.now()) {
        console.error('Token expired, need to re-authenticate');
        return null;
      }
      
      return tokens;
    } catch (error) {
      return null;
    }
  }



  async revokeToken(): Promise<void> {
    try {
      await fs.unlink(this.tokenFile);
      console.error('Access token revoked');
    } catch (error) {
      // Token file doesn't exist, that's okay
    }
  }

  async getAuthenticatedClient(): Promise<any> {
    const tokens = await this.getAccessToken();
    
    const authenticatedClient = new Evernote.Client({
      token: tokens.token,
      sandbox: this.config.sandbox,
      china: this.config.china || false
    });

    return {
      client: authenticatedClient,
      tokens: tokens
    };
  }
}