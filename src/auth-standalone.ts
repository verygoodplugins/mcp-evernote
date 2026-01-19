#!/usr/bin/env node
/**
 * Standalone OAuth authentication script for Evernote MCP Server
 * Run this script to authenticate with Evernote before using the MCP server
 */

import * as Evernote from 'evernote';
import express from 'express';
import open from 'open';
import fs from 'fs/promises';
import path from 'path';
import { config } from 'dotenv';
import * as readline from 'readline/promises';
import { stdin, stdout } from 'process';

// Load environment variables
config();

const tokenFile = path.join(process.cwd(), '.evernote-token.json');
const credentialsFile = path.join(process.cwd(), '.evernote-credentials.json');

interface Credentials {
  consumerKey: string;
  consumerSecret: string;
  environment: string;
  callbackPort: number;
}

async function getCredentials(): Promise<Credentials> {
  // Check environment variables first
  if (process.env.EVERNOTE_CONSUMER_KEY && process.env.EVERNOTE_CONSUMER_SECRET) {
    return {
      consumerKey: process.env.EVERNOTE_CONSUMER_KEY,
      consumerSecret: process.env.EVERNOTE_CONSUMER_SECRET,
      environment: process.env.EVERNOTE_ENVIRONMENT || 'production',
      callbackPort: parseInt(process.env.OAUTH_CALLBACK_PORT || '3000')
    };
  }

  // Check for saved credentials file
  try {
    const data = await fs.readFile(credentialsFile, 'utf-8');
    const saved = JSON.parse(data);
    console.log('✅ Found saved credentials');
    return saved;
  } catch (error) {
    // No saved credentials, need to prompt
  }

  // Prompt for credentials
  console.log('\n🔐 Evernote API Credentials Required');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('To get your API credentials:');
  console.log('1. Visit https://dev.evernote.com/');
  console.log('2. Create a new application');
  console.log('3. Copy your Consumer Key and Consumer Secret\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const consumerKey = await rl.question('Enter your Consumer Key: ');
    if (!consumerKey.trim()) {
      throw new Error('Consumer Key is required');
    }

    // For security, we could hide the secret input, but Node.js readline doesn't support it natively
    // Using a simple prompt for now
    const consumerSecret = await rl.question('Enter your Consumer Secret: ');
    if (!consumerSecret.trim()) {
      throw new Error('Consumer Secret is required');
    }

    const envAnswer = await rl.question('Environment (production/sandbox) [production]: ');
    const environment = envAnswer.trim() || 'production';

    const portAnswer = await rl.question('OAuth callback port [3000]: ');
    const callbackPort = parseInt(portAnswer.trim() || '3000');

    const saveAnswer = await rl.question('\nSave credentials for future use? (y/N): ');
    const shouldSave = saveAnswer.toLowerCase() === 'y';

    const credentials: Credentials = {
      consumerKey: consumerKey.trim(),
      consumerSecret: consumerSecret.trim(),
      environment,
      callbackPort
    };

    if (shouldSave) {
      await fs.writeFile(credentialsFile, JSON.stringify(credentials, null, 2));
      console.log('✅ Credentials saved to .evernote-credentials.json');
      console.log('⚠️  Remember to add .evernote-credentials.json to your .gitignore!');
    }

    return credentials;
  } finally {
    rl.close();
  }
}

async function checkExistingToken(environment: string) {
  try {
    const data = await fs.readFile(tokenFile, 'utf-8');
    const tokens = JSON.parse(data);
    
    if (tokens.expires && tokens.expires < Date.now()) {
      console.log('⚠️  Existing token has expired');
      return null;
    }
    
    console.log('\n✅ Found existing valid token');
    console.log('Token details:');
    console.log('  - User ID:', tokens.userId);
    console.log('  - Expires:', tokens.expires ? new Date(tokens.expires).toLocaleString() : 'Never');
    console.log('  - Environment:', environment);
    
    const rl = readline.createInterface({ input: stdin, output: stdout });
    
    try {
      const answer = await rl.question('\nDo you want to re-authenticate? (y/N): ');
      if (answer.toLowerCase() === 'y') {
        return null;
      } else {
        console.log('✅ Using existing token');
        return tokens;
      }
    } finally {
      rl.close();
    }
  } catch (error) {
    return null;
  }
}

async function performOAuth(credentials: Credentials) {
  const EvernoteModule = (Evernote as any).default || Evernote;
  const client = new EvernoteModule.Client({
    consumerKey: credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
    sandbox: credentials.environment === 'sandbox',
    china: false
  });

  return new Promise((resolve, reject) => {
    const app = express();
    let server: any;
    
    const callbackUrl = `http://localhost:${credentials.callbackPort}/oauth/callback`;
    
    console.log('\n🔐 Starting OAuth authentication flow...');
    console.log(`📡 Callback URL: ${callbackUrl}`);
    
    // Step 1: Get request token
    client.getRequestToken(callbackUrl, async (error: any, oauthToken: string, oauthTokenSecret: string) => {
      if (error) {
        reject(new Error(`Failed to get request token: ${error.message}`));
        return;
      }

      console.log('✅ Obtained request token');
      
      // Step 2: Set up callback server
      app.get('/oauth/callback', async (req, res) => {
        console.log('\n📥 Received OAuth callback');

        // Extract OAuth verifier from URL (standard OAuth1 callback flow)
        // The verifier is a one-time authorization code from Evernote's OAuth server
        const requestUrl = new URL(req.url || '', `http://${req.headers.host}`);
        const oauthVerifier = requestUrl.searchParams.get('oauth_verifier');

        if (!oauthVerifier || oauthVerifier.length === 0) {
          res.send('❌ OAuth verification failed - no verifier received');
          server.close();
          reject(new Error('OAuth verification failed'));
          return;
        }
        
        // Step 3: Get access token
        client.getAccessToken(
          oauthToken,
          oauthTokenSecret,
          oauthVerifier,
          async (error: any, accessToken: string, _accessTokenSecret: string, results: any) => {
            if (error) {
              res.send(`❌ Failed to get access token: ${error.message}`);
              server.close();
              reject(error);
              return;
            }
            
            console.log('✅ Obtained access token');
            
            // Get note store URL
            const authenticatedClient = new EvernoteModule.Client({
              token: accessToken,
              sandbox: credentials.environment === 'sandbox',
              china: false
            });
            
            const noteStoreUrl = authenticatedClient.getNoteStore().url;
            
            // Get user info to verify token
            try {
              const userStore = authenticatedClient.getUserStore();
              const user = await userStore.getUser();
              
              const tokenData = {
                // Keep token file compatible with src/oauth.ts (expects `token`)
                token: accessToken,
                noteStoreUrl,
                webApiUrlPrefix: results.edam_webApiUrlPrefix,
                userId: results.edam_userId,
                expires: typeof results.edam_expires === 'number' ? results.edam_expires : undefined,
                username: user.username,
                environment: credentials.environment
              };
              
              // Save token
              await fs.writeFile(tokenFile, JSON.stringify(tokenData, null, 2));
              
              res.send(`
                <html>
                  <head>
                    <style>
                      body { font-family: -apple-system, system-ui, sans-serif; padding: 40px; text-align: center; }
                      h1 { color: #00a82d; }
                      .success { background: #f0f9f0; padding: 20px; border-radius: 8px; margin: 20px 0; }
                      code { background: #e8e8e8; padding: 4px 8px; border-radius: 4px; }
                    </style>
                  </head>
                  <body>
                    <h1>✅ Authentication Successful!</h1>
                    <div class="success">
                      <p>Authenticated as: <strong>${user.username}</strong></p>
                      <p>Token saved to: <code>.evernote-token.json</code></p>
                      <p>Environment: <strong>${credentials.environment}</strong></p>
                    </div>
                    <p>You can close this window and return to your terminal.</p>
                  </body>
                </html>
              `);
              
              console.log('\n✅ Authentication complete!');
              console.log('  - User:', user.username);
              console.log('  - User ID:', tokenData.userId);
              console.log('  - Token saved to:', tokenFile);
              if (tokenData.expires) {
                console.log('  - Expires:', new Date(tokenData.expires).toLocaleString());
              }
              
              server.close();
              resolve(tokenData);
            } catch (error: any) {
              res.send(`❌ Failed to verify token: ${error.message}`);
              server.close();
              reject(error);
            }
          }
        );
      });
      
      // Start server
      server = app.listen(credentials.callbackPort, async () => {
        console.log(`🌐 OAuth callback server listening on port ${credentials.callbackPort}`);
        
        // Step 3: Get authorization URL and open browser
        const authUrl = client.getAuthorizeUrl(oauthToken);
        console.log('\n🌐 Opening browser for authorization...');
        console.log(`📎 Authorization URL: ${authUrl}\n`);
        console.log('If the browser doesn\'t open automatically, please visit the URL above.\n');
        
        try {
          await open(authUrl);
        } catch (error) {
          console.error('⚠️  Could not open browser automatically');
          console.log(`Please open this URL manually: ${authUrl}`);
        }
      });
      
      // Handle server errors
      server.on('error', (error: any) => {
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`Port ${credentials.callbackPort} is already in use. Please specify a different port in OAUTH_CALLBACK_PORT environment variable.`));
        } else {
          reject(error);
        }
      });
    });
  });
}

async function main() {
  console.log('🚀 Evernote MCP Server - Authentication Setup');
  console.log('═══════════════════════════════════════════════\n');
  
  try {
    // Get credentials
    const credentials = await getCredentials();
    
    // Check for existing token
    const existingToken = await checkExistingToken(credentials.environment);
    
    if (existingToken) {
      console.log('\n✅ Authentication is already set up!');
      console.log('\nYou can now use the Evernote MCP server with Claude Desktop.');
      return;
    }
    
    // Perform OAuth
    await performOAuth(credentials);
    
    console.log('\n✅ Setup complete!');
    console.log('\nNext steps for Claude Desktop:');
    console.log('1. Add the following to your Claude Desktop config:');
    console.log('   Location: ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)');
    console.log('             %APPDATA%\\Claude\\claude_desktop_config.json (Windows)\n');
    // Mask credentials in the example output for security
    // lgtm[js/clear-text-logging] - credentials are intentionally masked before logging
    const maskedKey = credentials.consumerKey.substring(0, 4) + '***';
    const maskedSecret = '***' + credentials.consumerSecret.substring(credentials.consumerSecret.length - 4);
    console.log(JSON.stringify({
      mcpServers: {
        evernote: {
          command: "npx",
          args: ["@verygoodplugins/mcp-evernote"],
          env: {
            EVERNOTE_CONSUMER_KEY: `${maskedKey} (use your actual key)`,
            EVERNOTE_CONSUMER_SECRET: `${maskedSecret} (use your actual secret)`,
            EVERNOTE_ENVIRONMENT: credentials.environment
          }
        }
      }
    }, null, 2));
    console.log('\n2. Restart Claude Desktop');
    console.log('3. Start using Evernote tools in your conversations!');
    
  } catch (error: any) {
    console.error('\n❌ Authentication failed:', error.message);
    process.exit(1);
  }
}

main();
