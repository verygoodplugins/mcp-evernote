#!/usr/bin/env node
/**
 * Universal setup script for Evernote MCP Server
 * Automatically detects the environment and provides the appropriate setup flow
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import readline from 'readline';
import { detectEnvironment, getRecommendedSetup } from './detect-environment.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log('🚀 Evernote MCP Server - Setup Assistant');
  console.log('=' .repeat(50));
  
  // Detect environment
  console.log('\n🔍 Detecting environment...\n');
  const env = detectEnvironment();
  const setup = getRecommendedSetup(env);
  
  // Display detection results
  console.log('Environment Detection Results:');
  console.log('------------------------------');
  console.log(`Claude Code CLI: ${env.claudeCodeInstalled ? '✅ Installed' : '❌ Not found'}`);
  console.log(`Claude Desktop: ${env.isClaudeDesktop ? '✅ Detected' : '❌ Not found'}`);
  console.log(`Running in Claude Code: ${env.isClaudeCode ? '✅ Yes' : '❌ No'}`);
  
  console.log('\n📋 Recommended Setup Method:');
  console.log(`→ ${setup.description}`);
  console.log('');
  
  // Handle different scenarios
  if (env.isClaudeCode) {
    // Already running in Claude Code
    console.log('🎉 You\'re already running in Claude Code!');
    console.log('');
    console.log('To authenticate with Evernote:');
    console.log('1. Type: /mcp');
    console.log('2. Select "Evernote"');
    console.log('3. Choose "Authenticate" or "Configure"');
    console.log('');
    console.log('The authentication will be handled automatically by Claude Code.');
    
  } else if (env.claudeCodeInstalled && env.isClaudeDesktop) {
    // Both are available - let user choose
    console.log('🎯 Multiple options available:\n');
    console.log('1. Install to Claude Code (recommended - automatic OAuth)');
    console.log('2. Setup for Claude Desktop (manual authentication)');
    console.log('3. Setup for both');
    console.log('4. Exit');
    
    const choice = await question('\nChoose an option (1-4) [1]: ') || '1';
    
    switch (choice) {
      case '1':
        console.log('\n→ Installing to Claude Code...\n');
        execSync('node scripts/install-to-claude.js', { stdio: 'inherit' });
        break;
        
      case '2':
        console.log('\n→ Setting up for Claude Desktop...\n');
        execSync('node dist/auth-standalone.js', { stdio: 'inherit' });
        console.log('\n✅ Authentication complete!');
        console.log('The MCP server is already configured in your Claude Desktop.');
        break;
        
      case '3':
        console.log('\n→ Setting up for both environments...\n');
        console.log('Step 1: Claude Desktop authentication');
        execSync('node dist/auth-standalone.js', { stdio: 'inherit' });
        console.log('\nStep 2: Claude Code installation');
        execSync('node scripts/install-to-claude.js', { stdio: 'inherit' });
        break;
        
      case '4':
        console.log('👋 Setup cancelled');
        break;
        
      default:
        console.log('Invalid choice');
    }
    
  } else if (env.claudeCodeInstalled) {
    // Only Claude Code is available
    console.log('→ Claude Code detected. Starting installation...\n');
    execSync('node scripts/install-to-claude.js', { stdio: 'inherit' });
    
  } else if (env.isClaudeDesktop) {
    // Only Claude Desktop is available
    console.log('→ Claude Desktop detected. Starting authentication...\n');
    
    // Check if already authenticated
    const tokenFile = join(process.cwd(), '.evernote-token.json');
    if (existsSync(tokenFile)) {
      console.log('✅ Authentication token found!');
      console.log('');
      const reauth = await question('Re-authenticate? (y/N): ');
      if (reauth.toLowerCase() !== 'y') {
        console.log('\nYour Evernote MCP server is ready to use in Claude Desktop!');
        process.exit(0);
      }
    }
    
    execSync('node dist/auth-standalone.js', { stdio: 'inherit' });
    console.log('\n✅ Setup complete!');
    console.log('The Evernote MCP server is configured in your Claude Desktop.');
    
  } else {
    // Neither is installed
    console.log('⚠️  No Claude application detected\n');
    console.log('Please install one of the following:');
    console.log('');
    console.log('🖥️  Claude Code (Recommended):');
    console.log('   https://claude.ai/code');
    console.log('   - Built-in OAuth support');
    console.log('   - Automatic token refresh');
    console.log('   - Easy MCP server management');
    console.log('');
    console.log('💻 Claude Desktop:');
    console.log('   https://claude.ai/download');
    console.log('   - Desktop application');
    console.log('   - Manual authentication required');
    console.log('');
    console.log('After installation, run this setup again:');
    console.log('  npm run setup');
  }
  
  rl.close();
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('\n❌ Setup failed:', error.message);
  process.exit(1);
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n👋 Setup cancelled');
  process.exit(0);
});

main().catch(error => {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
});