#!/usr/bin/env node
/**
 * Post-install script for Evernote MCP Server
 * Provides setup instructions based on detected environment
 */

import { detectEnvironment, getRecommendedSetup } from './detect-environment.js';

// Only show messages if not in CI/CD environment
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION || process.env.npm_config_global) {
  process.exit(0);
}

// Don't show during dependency installs
if (process.env.npm_lifecycle_event !== 'postinstall') {
  process.exit(0);
}

console.log('\n📦 Evernote MCP Server installed successfully!\n');

const env = detectEnvironment();
const setup = getRecommendedSetup(env);

if (env.isClaudeCode) {
  // Already running in Claude Code
  console.log('✅ Running in Claude Code');
  console.log('Use /mcp command to manage this server');
} else if (env.claudeCodeInstalled || env.isClaudeDesktop) {
  console.log('🚀 Quick Setup:');
  console.log('───────────────');
  console.log('Run: npm run setup');
  console.log('');
  console.log('This will help you configure the MCP server for your environment.');
} else {
  console.log('📋 Next Steps:');
  console.log('──────────────');
  console.log('1. Install Claude Code or Claude Desktop');
  console.log('2. Run: npm run setup');
  console.log('');
  console.log('Learn more: https://github.com/verygoodplugins/mcp-evernote');
}

console.log('');