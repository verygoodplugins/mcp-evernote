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

// Load environment variables
config();

const CONSUMER_KEY = process.env.EVERNOTE_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.EVERNOTE_CONSUMER_SECRET;
const ENVIRONMENT = process.env.EVERNOTE_ENVIRONMENT || 'production';
const CALLBACK_PORT = parseInt(process.env.OAUTH_CALLBACK_PORT || '3000');

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error('❌ Missing required environment variables: EVERNOTE_CONSUMER_KEY and EVERNOTE_CONSUMER_SECRET');
  console.error('Please create a .env file with your Evernote API credentials');
  process.exit(1);
}

const tokenFile = path.join(process.cwd(), '.evernote-token.json');

async function checkExistingToken() {
  try {
    const data = await fs.readFile(tokenFile, 'utf-8');
    const tokens = JSON.parse(data);
    
    if (tokens.expires && tokens.expires < Date.now()) {
      console.log('⚠️  Existing token has expired');
      return null;
    }
    
    console.log('✅ Found existing valid token');
    console.log('Token details:');
    console.log('  - User ID:', tokens.userId);
    console.log('  - Expires:', tokens.expires ? new Date(tokens.expires).toLocaleString() : 'Never');
    console.log('  - Environment:', ENVIRONMENT);
    
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      rl.question('\nDo you want to re-authenticate? (y/N): ', (answer) => {
        rl.close();
        if (answer.toLowerCase() === 'y') {
          resolve(null);
        } else {
          console.log('✅ Using existing token');
          resolve(tokens);
        }
      });
    });
  } catch (error) {
    return null;
  }
}

async function performOAuth() {
  const client = new Evernote.Client({
    consumerKey: CONSUMER_KEY,
    consumerSecret: CONSUMER_SECRET,
    sandbox: ENVIRONMENT === 'sandbox',
    china: false
  });

  return new Promise((resolve, reject) => {
    const app = express();
    let server: any;
    
    const callbackUrl = `http://localhost:${CALLBACK_PORT}/oauth/callback`;
    
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
        const { oauth_verifier } = req.query;
        
        console.log('\n📥 Received OAuth callback');
        
        if (!oauth_verifier) {
          res.send(`
            <html>
              <head><title>Authorization Cancelled</title></head>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>❌ Authorization Cancelled</h1>
                <p>You cancelled the authorization. Please run the script again if you want to authenticate.</p>
              </body>
            </html>
          `);
          server.close();
          reject(new Error('Authorization cancelled by user'));
          return;
        }

        console.log('🔄 Exchanging for access token...');
        
        // Step 3: Exchange for access token
        client.getAccessToken(
          oauthToken,
          oauthTokenSecret,
          oauth_verifier as string,
          async (error: any, accessToken: string, accessTokenSecret: string, results: any) => {
            if (error) {
              res.send(`
                <html>
                  <head><title>Authentication Failed</title></head>
                  <body style="font-family: system-ui; padding: 40px; text-align: center;">
                    <h1>❌ Authentication Failed</h1>
                    <p>Failed to get access token: ${error.message}</p>
                  </body>
                </html>
              `);
              server.close();
              reject(new Error(`Failed to get access token: ${error.message}`));
              return;
            }

            const tokens = {
              token: accessToken,
              tokenSecret: accessTokenSecret,
              noteStoreUrl: results.edam_noteStoreUrl,
              webApiUrlPrefix: results.edam_webApiUrlPrefix,
              userId: results.edam_userId,
              expires: results.edam_expires || 0
            };

            // Save token to file
            await fs.writeFile(tokenFile, JSON.stringify(tokens, null, 2));
            
            console.log('✅ Access token obtained and saved!');
            
            res.send(`
              <html>
                <head>
                  <title>Authentication Successful</title>
                  <style>
                    body {
                      font-family: system-ui, -apple-system, sans-serif;
                      padding: 40px;
                      max-width: 600px;
                      margin: 0 auto;
                      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                      min-height: 100vh;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                    }
                    .container {
                      background: white;
                      border-radius: 16px;
                      padding: 40px;
                      box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                      text-align: center;
                    }
                    h1 { color: #2d3748; margin-bottom: 16px; }
                    .success-icon {
                      font-size: 64px;
                      margin-bottom: 20px;
                    }
                    p { color: #4a5568; line-height: 1.6; margin: 16px 0; }
                    .token-info {
                      background: #f7fafc;
                      border: 1px solid #e2e8f0;
                      border-radius: 8px;
                      padding: 16px;
                      margin: 20px 0;
                      text-align: left;
                    }
                    .token-info strong { color: #2d3748; }
                    .close-hint {
                      color: #718096;
                      font-size: 14px;
                      margin-top: 24px;
                    }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <div class="success-icon">✅</div>
                    <h1>Authentication Successful!</h1>
                    <p>Your Evernote account has been successfully connected to the MCP server.</p>
                    
                    <div class="token-info">
                      <p><strong>User ID:</strong> ${tokens.userId}</p>
                      <p><strong>Environment:</strong> ${ENVIRONMENT}</p>
                      <p><strong>Token Expires:</strong> ${tokens.expires ? new Date(tokens.expires).toLocaleString() : 'Never'}</p>
                      <p><strong>Token Saved To:</strong> ${tokenFile}</p>
                    </div>
                    
                    <p>You can now use the Evernote MCP server in Claude Desktop!</p>
                    <p class="close-hint">This window will close automatically in 5 seconds...</p>
                  </div>
                  <script>
                    setTimeout(() => {
                      window.close();
                      // Fallback if window.close() doesn't work
                      document.body.innerHTML = '<div class="container"><h2>You can close this window now</h2></div>';
                    }, 5000);
                  </script>
                </body>
              </html>
            `);
            
            setTimeout(() => {
              server.close();
              resolve(tokens);
            }, 1000);
          }
        );
      });

      // Start the callback server
      server = app.listen(CALLBACK_PORT, () => {
        console.log(`🌐 OAuth callback server listening on port ${CALLBACK_PORT}`);
        
        // Open authorization URL in browser
        const authorizeUrl = client.getAuthorizeUrl(oauthToken);
        console.log(`🌐 Opening browser for authorization...`);
        console.log(`📎 Authorization URL: ${authorizeUrl}\n`);
        
        open(authorizeUrl).catch(() => {
          console.log('⚠️  Could not open browser automatically.');
          console.log('Please open this URL manually in your browser:');
          console.log(authorizeUrl);
        });
      });

      // Add error handling for server
      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`❌ Port ${CALLBACK_PORT} is already in use. Please close any other processes using this port or set a different OAUTH_CALLBACK_PORT in your .env file.`);
        } else {
          console.error('❌ Server error:', err);
        }
        reject(err);
      });
    });
  });
}

async function main() {
  console.log('🚀 Evernote MCP Server - Authentication Setup');
  console.log('=' .repeat(50));
  console.log(`Environment: ${ENVIRONMENT}`);
  console.log(`Consumer Key: ${CONSUMER_KEY}`);
  console.log('=' .repeat(50));
  
  try {
    // Check for existing token
    const existingToken = await checkExistingToken();
    if (existingToken) {
      process.exit(0);
    }
    
    // Perform OAuth
    await performOAuth();
    
    console.log('\n' + '=' .repeat(50));
    console.log('✅ Authentication Complete!');
    console.log('=' .repeat(50));
    console.log('\nYour Evernote MCP server is now ready to use with Claude Desktop.');
    console.log(`Token saved to: ${tokenFile}`);
    console.log('\nTo use with Claude Desktop, make sure your config includes:');
    console.log(`
{
  "mcpServers": {
    "evernote": {
      "command": "node",
      "args": ["${path.join(process.cwd(), 'dist', 'index.js')}"]
    }
  }
}
    `);
    
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Authentication failed:', error.message);
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n👋 Authentication cancelled by user');
  process.exit(0);
});

main();