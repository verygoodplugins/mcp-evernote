import * as Evernote from 'evernote';
import express from 'express';
import open from 'open';
import fs from 'fs/promises';
import path from 'path';
import { EvernoteConfig, OAuthTokens } from './types.js';

export class EvernoteOAuth {
  private client: any;
  private config: EvernoteConfig;
  private tokenFile: string;
  private callbackPort: number;

  constructor(config: EvernoteConfig, callbackPort: number = 3000) {
    this.config = config;
    this.callbackPort = callbackPort;
    this.tokenFile = path.join(process.cwd(), '.evernote-token.json');
    
    this.client = new Evernote.Client({
      consumerKey: config.consumerKey,
      consumerSecret: config.consumerSecret,
      sandbox: config.sandbox,
      china: config.china || false
    });
  }

  async getAccessToken(): Promise<OAuthTokens> {
    // Try to load existing token
    const existingToken = await this.loadToken();
    if (existingToken) {
      console.error('Using existing Evernote access token');
      return existingToken;
    }

    console.error('No existing token found. Starting OAuth flow...');
    return await this.performOAuthFlow();
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

  private async saveToken(tokens: OAuthTokens): Promise<void> {
    await fs.writeFile(this.tokenFile, JSON.stringify(tokens, null, 2));
    console.error('Access token saved to', this.tokenFile);
  }

  private async performOAuthFlow(): Promise<OAuthTokens> {
    return new Promise((resolve, reject) => {
      const app = express();
      let server: any;
      
      const callbackUrl = `http://localhost:${this.callbackPort}/oauth/callback`;
      
      // Step 1: Get request token
      this.client.getRequestToken(callbackUrl, async (error: any, oauthToken: string, oauthTokenSecret: string) => {
        if (error) {
          reject(new Error(`Failed to get request token: ${error.message}`));
          return;
        }

        // Step 2: Set up callback server
        app.get('/oauth/callback', async (req, res) => {
          const { oauth_verifier } = req.query;
          
          if (!oauth_verifier) {
            res.send('Authorization cancelled');
            server.close();
            reject(new Error('Authorization cancelled by user'));
            return;
          }

          // Step 3: Exchange for access token
          this.client.getAccessToken(
            oauthToken,
            oauthTokenSecret,
            oauth_verifier as string,
            async (error: any, accessToken: string, accessTokenSecret: string, results: any) => {
              if (error) {
                res.send('Failed to get access token');
                server.close();
                reject(new Error(`Failed to get access token: ${error.message}`));
                return;
              }

              const tokens: OAuthTokens = {
                token: accessToken,
                tokenSecret: accessTokenSecret,
                noteStoreUrl: results.edam_noteStoreUrl,
                webApiUrlPrefix: results.edam_webApiUrlPrefix,
                userId: results.edam_userId,
                expires: results.edam_expires || 0
              };

              await this.saveToken(tokens);
              
              res.send(`
                <html>
                  <body>
                    <h1>Authorization Successful!</h1>
                    <p>You can now close this window and return to your terminal.</p>
                    <script>setTimeout(() => window.close(), 2000);</script>
                  </body>
                </html>
              `);
              
              server.close();
              resolve(tokens);
            }
          );
        });

        // Start the callback server
        server = app.listen(this.callbackPort, () => {
          console.error(`OAuth callback server listening on port ${this.callbackPort}`);
          
          // Open authorization URL in browser
          const authorizeUrl = this.client.getAuthorizeUrl(oauthToken);
          console.error(`Opening browser for authorization: ${authorizeUrl}`);
          open(authorizeUrl);
        });
      });
    });
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