#!/usr/bin/env node
/**
 * Automatic installation helper for Claude Code
 * Helps users install the Evernote MCP server to Claude Code with proper configuration
 */

import { execFileSync, spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import readline from 'readline';
import { detectEnvironment, getRecommendedSetup } from './detect-environment.js';
import { config } from 'dotenv';

// Load environment variables
config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function getCredentials() {
  // Try to get from environment
  let consumerKey = process.env.EVERNOTE_CONSUMER_KEY;
  let consumerSecret = process.env.EVERNOTE_CONSUMER_SECRET;
  
  // Try to get from .env file
  if (!consumerKey || !consumerSecret) {
    const envPath = join(process.cwd(), '.env');
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, 'utf-8');
      const keyMatch = envContent.match(/EVERNOTE_CONSUMER_KEY=(.+)/);
      const secretMatch = envContent.match(/EVERNOTE_CONSUMER_SECRET=(.+)/);
      
      if (keyMatch) consumerKey = keyMatch[1].trim();
      if (secretMatch) consumerSecret = secretMatch[1].trim();
    }
  }
  
  return { consumerKey, consumerSecret };
}

async function installToClaudeCode() {
  console.log('🚀 Evernote MCP Server - Claude Code Installation');
  console.log('=' .repeat(50));
  
  const env = detectEnvironment();
  
  if (!env.claudeCodeInstalled) {
    console.log('❌ Claude Code CLI not found');
    console.log('');
    console.log('Please install Claude Code first:');
    console.log('https://claude.ai/code');
    process.exit(1);
  }
  
  console.log('✅ Claude Code detected:', env.claudeCodeCommand);
  console.log('');
  
  // Get credentials
  const { consumerKey, consumerSecret } = getCredentials();
  
  if (!consumerKey || !consumerSecret) {
    console.log('⚠️  Evernote API credentials not found');
    console.log('');
    console.log('Please provide your Evernote API credentials:');
    console.log('(Get them from https://dev.evernote.com/)\n');
    
    const key = await question('Consumer Key: ');
    const secret = await question('Consumer Secret: ');
    
    if (!key || !secret) {
      console.log('❌ Credentials are required');
      process.exit(1);
    }
    
    consumerKey = key;
    consumerSecret = secret;
  }
  
  // Ask for installation scope
  console.log('\n📍 Installation Scope:');
  console.log('1. user - Available in all projects (recommended)');
  console.log('2. project - Only in current project');
  console.log('3. local - Only in current directory');
  
  const scopeChoice = await question('\nChoose scope (1-3) [1]: ') || '1';
  const scopes = { '1': 'user', '2': 'project', '3': 'local' };
  const scope = scopes[scopeChoice] || 'user';
  
  // Ask for environment
  console.log('\n🌍 Evernote Environment:');
  console.log('1. production - Live Evernote (recommended)');
  console.log('2. sandbox - Test environment');
  
  const envChoice = await question('\nChoose environment (1-2) [1]: ') || '1';
  const environment = envChoice === '2' ? 'sandbox' : 'production';
  
  // Build the command arguments (separate from the executable for security)
  const serverCommand = env.isLocal
    ? `node ${join(process.cwd(), 'dist', 'index.js')}`
    : 'npx @verygoodplugins/mcp-evernote';

  // Validate the Claude Code command path to prevent command injection
  const claudeCommand = env.claudeCodeCommand;
  if (!claudeCommand || typeof claudeCommand !== 'string') {
    throw new Error('Invalid Claude Code command detected');
  }

  const addCommandArgs = [
    'mcp',
    'add',
    'evernote',
    serverCommand,
    '--scope', scope,
    '--env', `EVERNOTE_CONSUMER_KEY=${consumerKey}`,
    '--env', `EVERNOTE_CONSUMER_SECRET=${consumerSecret}`,
    '--env', `EVERNOTE_ENVIRONMENT=${environment}`
  ];

  console.log('\n📝 Installing MCP server to Claude Code...');
  // Log command template without any env-derived data
  console.log('Command: claude mcp add evernote <server> --scope', scope, '--env EVERNOTE_CONSUMER_KEY=*** --env EVERNOTE_CONSUMER_SECRET=*** --env EVERNOTE_ENVIRONMENT=' + environment);

  try {
    // Execute using execFileSync with separate arguments to prevent shell injection
    // lgtm[js/shell-command-injection-from-environment] - claudeCommand is validated above and comes from trusted detectEnvironment()
    const result = execFileSync(claudeCommand, addCommandArgs, {
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    
    console.log('\n✅ Successfully installed Evernote MCP server to Claude Code!');
    console.log(result);
    
    // Check if we should authenticate now
    const authNow = await question('\n🔐 Would you like to authenticate with Evernote now? (y/N): ');
    
    if (authNow.toLowerCase() === 'y') {
      console.log('\n📱 Opening Claude Code for authentication...');
      console.log('Please use the /mcp command in Claude Code to authenticate.');
      
      // Try to open Claude Code
      try {
        execFileSync(claudeCommand, ['open'], { stdio: 'ignore' });
      } catch {
        console.log('Please open Claude Code manually');
      }
    } else {
      console.log('\n📌 To authenticate later:');
      console.log('1. Open Claude Code');
      console.log('2. Type: /mcp');
      console.log('3. Select "Evernote" and follow the authentication flow');
    }
    
  } catch (error) {
    console.error('\n❌ Installation failed:', error.message);
    console.log('\nYou can try installing manually:');
    console.log('claude mcp add evernote <command> --scope <scope> --env EVERNOTE_CONSUMER_KEY=<key> --env EVERNOTE_CONSUMER_SECRET=<secret> --env EVERNOTE_ENVIRONMENT=<env>');
    process.exit(1);
  }
  
  rl.close();
}

async function main() {
  const env = detectEnvironment();
  const setup = getRecommendedSetup(env);
  
  if (env.isClaudeCode) {
    console.log('🎉 Already running in Claude Code!');
    console.log('Use /mcp command to manage this server');
    process.exit(0);
  }
  
  if (setup.method === 'claude-desktop') {
    console.log('📱 Claude Desktop detected');
    console.log('');
    console.log('For Claude Desktop, use the authentication script:');
    console.log('  npm run auth');
    console.log('');
    const proceed = await question('Install to Claude Code instead? (y/N): ');
    if (proceed.toLowerCase() !== 'y') {
      console.log('\nTo authenticate for Claude Desktop:');
      console.log('  npm run auth');
      process.exit(0);
    }
  }
  
  await installToClaudeCode();
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\n👋 Installation cancelled');
  process.exit(0);
});

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});