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
      const tokens = {
        token: process.env.EVERNOTE_ACCESS_TOKEN,
        noteStoreUrl: process.env.EVERNOTE_NOTESTORE_URL,
        webApiUrlPrefix: process.env.EVERNOTE_WEBAPI_URL,
        userId: process.env.EVERNOTE_USER_ID ? parseInt(process.env.EVERNOTE_USER_ID) : undefined
      };
      
      // Validate token is still usable
      if (!await this.validateToken(tokens)) {
        throw new Error('Environment token is invalid or expired');
      }
      
      return tokens;
    }
    
    // Check if Claude Code is providing OAuth tokens
    // Claude Code may pass tokens after /mcp authentication
    if (this.isClaudeCode && process.env.OAUTH_TOKEN) {
      console.error('Using OAuth token from Claude Code');
      const tokens = {
        token: process.env.OAUTH_TOKEN,
        noteStoreUrl: process.env.OAUTH_NOTESTORE_URL,
        webApiUrlPrefix: process.env.OAUTH_WEBAPI_URL,
        userId: process.env.OAUTH_USER_ID ? parseInt(process.env.OAUTH_USER_ID) : undefined
      };
      
      // Validate token is still usable
      if (!await this.validateToken(tokens)) {
        throw new Error('Claude Code OAuth token is invalid or expired. Please re-authenticate.');
      }
      
      return tokens;
    }
    
    // Try to load existing token from file
    const existingToken = await this.loadToken();
    if (existingToken) {
      console.error('Using existing Evernote access token from file');
      
      // Validate token is still usable
      if (!await this.validateToken(existingToken)) {
        console.error('Stored token is invalid or expired, removing it');
        await this.revokeToken(); // Clean up invalid token
        throw new Error('Stored token is invalid or expired. Please re-authenticate.');
      }
      
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

  private async validateToken(tokens: OAuthTokens): Promise<boolean> {
    // Check token structure
    if (!tokens.token) {
      console.error('Invalid token: missing token field');
      return false;
    }
    
    // Check if token is expired (if expiration is set)
    if (tokens.expires) {
      const now = Date.now();
      const timeUntilExpiry = tokens.expires - now;
      
      // If expired, return false
      if (timeUntilExpiry <= 0) {
        console.error('Token expired');
        return false;
      }
      
      // If expiring within 1 hour, warn but still valid
      if (timeUntilExpiry < 3600000) {
        console.error(`Token expiring soon (in ${Math.floor(timeUntilExpiry / 60000)} minutes)`);
      }
    }
    
    // Token structure is valid
    return true;
  }

  private async loadToken(): Promise<OAuthTokens | null> {
    try {
      const data = await fs.readFile(this.tokenFile, 'utf-8');
      const raw = JSON.parse(data) as any;
      const token = raw.token ?? raw.accessToken;
      const tokens: OAuthTokens = {
        ...raw,
        token,
      };
      
      // Validate token structure
      if (!tokens.token) {
        console.error('Invalid token file: missing token field');
        return null;
      }
      
      // Check if token is expired (if expiration is set)
      if (tokens.expires && tokens.expires < Date.now()) {
        console.error('Token expired, need to re-authenticate');
        return null;
      }
      
      // Log if noteStoreUrl is missing (will be fetched later)
      if (!tokens.noteStoreUrl) {
        console.error('Token file missing noteStoreUrl, will fetch from API');
      }
      
      return tokens;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, that's expected on first run
        return null;
      }
      console.error('Failed to load token file:', error.message);
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

    // If noteStoreUrl is missing, we need to get it from the UserStore
    if (!tokens.noteStoreUrl) {
      try {
        const userStore = authenticatedClient.getUserStore();
        const noteStoreUrl = await userStore.getNoteStoreUrl();
        tokens.noteStoreUrl = noteStoreUrl;
        
        // Save the updated token with noteStoreUrl
        if (!this.isClaudeCode && !process.env.EVERNOTE_ACCESS_TOKEN) {
          try {
            await fs.writeFile(this.tokenFile, JSON.stringify(tokens, null, 2));
          } catch (error) {
            console.error('Failed to update token file with noteStoreUrl:', error);
          }
        }
      } catch (error) {
        console.error('Failed to get noteStoreUrl:', error);
        throw new Error('Failed to get noteStoreUrl from Evernote. Token may be invalid.');
      }
    }

    return {
      client: authenticatedClient,
      tokens: tokens
    };
  }
}
