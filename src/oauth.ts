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
    // Check for token in environment variable (primary method)
    if (process.env.EVERNOTE_ACCESS_TOKEN) {
      console.error('Using Evernote access token from environment variable');
      const tokens: OAuthTokens = {
        token: process.env.EVERNOTE_ACCESS_TOKEN,
        noteStoreUrl: process.env.EVERNOTE_NOTESTORE_URL,
        webApiUrlPrefix: process.env.EVERNOTE_WEBAPI_URL,
        userId: process.env.EVERNOTE_USER_ID ? parseInt(process.env.EVERNOTE_USER_ID) : undefined
      };

      if (!this.validateToken(tokens)) {
        throw new Error('Environment token is invalid or expired');
      }

      return tokens;
    }

    // Check if Claude Code is providing OAuth tokens
    if (this.isClaudeCode && process.env.OAUTH_TOKEN) {
      console.error('Using OAuth token from Claude Code');
      const tokens: OAuthTokens = {
        token: process.env.OAUTH_TOKEN,
        noteStoreUrl: process.env.OAUTH_NOTESTORE_URL,
        webApiUrlPrefix: process.env.OAUTH_WEBAPI_URL,
        userId: process.env.OAUTH_USER_ID ? parseInt(process.env.OAUTH_USER_ID) : undefined
      };

      if (!this.validateToken(tokens)) {
        throw new Error('Claude Code OAuth token is invalid or expired. Please re-authenticate.');
      }

      return tokens;
    }

    const fileTokens = await this.loadToken();
    if (fileTokens) {
      console.error('Using Evernote access token from .evernote-token.json');
      return fileTokens;
    }

    // No token found - emit clear instructions that Claude must relay to the user
    this.emitMissingTokenInstructions();
    throw new Error('Authentication required. Set EVERNOTE_ACCESS_TOKEN or run npm run auth.');
  }

  /**
   * Emit clear, structured instructions to stderr so Claude relays them to the user.
   * MCP servers communicate via stderr - these messages appear in the host's logs.
   */
  private emitMissingTokenInstructions(): void {
    console.error('');
    console.error('=== IMPORTANT: RELAY THIS MESSAGE TO THE USER IMMEDIATELY ===');
    console.error('');
    console.error('EVERNOTE MCP SERVER - AUTHENTICATION REQUIRED');
    console.error('');
    console.error('No Evernote access token found. Prefer environment variables');
    console.error('for authentication, or run the standalone auth flow.');
    console.error('');
    console.error('Recommended environment variable:');
    console.error('  EVERNOTE_ACCESS_TOKEN - Your Evernote OAuth access token');
    console.error('');
    console.error('Optional environment variables:');
    console.error('  EVERNOTE_NOTESTORE_URL - NoteStore URL (fetched automatically if omitted)');
    console.error('  EVERNOTE_USER_ID - Your Evernote user ID');
    console.error('');

    if (this.isClaudeCode) {
      console.error('To authenticate in Claude Code:');
      console.error('  1. Run: claude mcp remove evernote');
      console.error('  2. Run: claude mcp add evernote <command> --env EVERNOTE_ACCESS_TOKEN=<token> \\');
      console.error('       --env EVERNOTE_CONSUMER_KEY=<key> --env EVERNOTE_CONSUMER_SECRET=<secret>');
      console.error('');
      console.error('  Or use /mcp in Claude Code to manage authentication.');
    } else {
      console.error('To authenticate:');
      console.error('  1. Run: npm run auth');
      console.error('     This will complete OAuth, save .evernote-token.json, and display your token.');
      console.error('  2. Prefer setting the token as an environment variable in your MCP config.');
      console.error('');
      console.error('  For Claude Desktop, add to claude_desktop_config.json:');
      console.error('    "env": { "EVERNOTE_ACCESS_TOKEN": "<your-token>" }');
    }

    console.error('');
    console.error('=== END OF MESSAGE TO RELAY ===');
    console.error('');
  }

  private validateToken(tokens: OAuthTokens): boolean {
    if (!tokens.token) {
      console.error('Invalid token: missing token field');
      return false;
    }

    if (tokens.expires) {
      const now = Date.now();
      const timeUntilExpiry = tokens.expires - now;

      if (timeUntilExpiry <= 0) {
        console.error('Token expired');
        return false;
      }

      if (timeUntilExpiry < 3600000) {
        console.error('Warning: Token expiring soon (in ' + Math.floor(timeUntilExpiry / 60000) + ' minutes)');
      }
    }

    return true;
  }

  private async loadToken(): Promise<OAuthTokens | null> {
    try {
      const data = await fs.readFile(this.tokenFile, 'utf-8');
      const raw = JSON.parse(data) as Partial<OAuthTokens> & { accessToken?: string };
      const tokens: OAuthTokens = {
        ...raw,
        token: raw.token || raw.accessToken || '',
      };

      if (!this.validateToken(tokens)) {
        return null;
      }

      return tokens;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.error(`Failed to load token file: ${error.message}`);
      }
      return null;
    }
  }

  async revokeToken(): Promise<void> {
    try {
      await fs.unlink(this.tokenFile);
      console.error('Removed .evernote-token.json');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.error(`Failed to remove token file: ${error.message}`);
      }
    }
    console.error('If you use EVERNOTE_ACCESS_TOKEN, remove or update it in your MCP configuration.');
  }

  async getAuthenticatedClient(): Promise<any> {
    const tokens = await this.getAccessToken();

    const authenticatedClient = new Evernote.Client({
      token: tokens.token,
      sandbox: this.config.sandbox,
      china: this.config.china || false
    });

    // If noteStoreUrl is missing, fetch from UserStore
    if (!tokens.noteStoreUrl) {
      try {
        const userStore = authenticatedClient.getUserStore();
        const noteStoreUrl = await userStore.getNoteStoreUrl();
        tokens.noteStoreUrl = noteStoreUrl;
        if (!process.env.EVERNOTE_ACCESS_TOKEN && !(this.isClaudeCode && process.env.OAUTH_TOKEN)) {
          await fs.writeFile(this.tokenFile, JSON.stringify(tokens, null, 2));
        }
      } catch (error) {
        console.error('Failed to get noteStoreUrl from Evernote');
        throw new Error('Failed to get noteStoreUrl from Evernote. Token may be invalid.');
      }
    }

    return {
      client: authenticatedClient,
      tokens: tokens
    };
  }
}
