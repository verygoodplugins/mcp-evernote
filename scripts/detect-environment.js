#!/usr/bin/env node
/**
 * Environment detection utility for Evernote MCP Server
 * Detects whether running in Claude Code, Claude Desktop, or other environments
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

export function detectEnvironment() {
  const env = {
    isClaudeCode: false,
    isClaudeDesktop: false,
    isNpx: false,
    isGlobal: false,
    isLocal: false,
    claudeCodeInstalled: false,
    claudeDesktopConfigPath: null,
    claudeCodeCommand: null
  };

  // Check if running under Claude Code MCP
  // Claude Code sets specific environment variables when running MCP servers
  if (process.env.MCP_TRANSPORT || process.env.CLAUDE_CODE_MCP) {
    env.isClaudeCode = true;
  }

  // Check if Claude Code CLI is installed
  try {
    execSync('claude --version', { stdio: 'ignore' });
    env.claudeCodeInstalled = true;
    env.claudeCodeCommand = 'claude';
  } catch {
    // Try alternate command names
    try {
      execSync('claude-code --version', { stdio: 'ignore' });
      env.claudeCodeInstalled = true;
      env.claudeCodeCommand = 'claude-code';
    } catch {
      // Claude Code CLI not found
    }
  }

  // Check for Claude Desktop config
  const claudeDesktopPaths = [
    join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), // macOS
    join(homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'), // Windows
    join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'), // Linux
  ];

  for (const path of claudeDesktopPaths) {
    if (existsSync(path)) {
      env.isClaudeDesktop = true;
      env.claudeDesktopConfigPath = path;
      break;
    }
  }

  // Check if running via npx
  if (process.env.npm_execpath && process.env.npm_execpath.includes('npx')) {
    env.isNpx = true;
  }

  // Check if installed globally
  if (process.argv[1] && process.argv[1].includes('npm/node_modules')) {
    env.isGlobal = true;
  }

  // Check if running locally
  if (process.cwd().includes('mcp-evernote')) {
    env.isLocal = true;
  }

  return env;
}

export function getRecommendedSetup(env) {
  if (env.isClaudeCode) {
    return {
      method: 'claude-code-active',
      description: 'Already running in Claude Code',
      instructions: 'Use /mcp command to manage authentication'
    };
  }

  if (env.claudeCodeInstalled) {
    return {
      method: 'claude-code',
      description: 'Claude Code is installed',
      instructions: `Run: ${env.claudeCodeCommand} mcp add evernote "npx @verygoodplugins/mcp-evernote"`
    };
  }

  if (env.isClaudeDesktop) {
    return {
      method: 'claude-desktop',
      description: 'Claude Desktop detected',
      instructions: 'Run: npm run auth (or npx mcp-evernote-auth)'
    };
  }

  return {
    method: 'manual',
    description: 'Manual setup required',
    instructions: 'Please install Claude Code or Claude Desktop first'
  };
}

// If run directly, print environment info
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = detectEnvironment();
  const setup = getRecommendedSetup(env);
  
  console.log('🔍 Environment Detection Results:');
  console.log('================================');
  console.log('Claude Code installed:', env.claudeCodeInstalled ? '✅' : '❌');
  console.log('Claude Desktop detected:', env.isClaudeDesktop ? '✅' : '❌');
  console.log('Running in Claude Code:', env.isClaudeCode ? '✅' : '❌');
  console.log('Running via npx:', env.isNpx ? '✅' : '❌');
  console.log('');
  console.log('📋 Recommended Setup:');
  console.log('Method:', setup.method);
  console.log('Description:', setup.description);
  console.log('Instructions:', setup.instructions);
}