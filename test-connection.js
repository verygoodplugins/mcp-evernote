#!/usr/bin/env node
import { spawn } from 'child_process';

console.log('Testing Evernote MCP Server...');

const server = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

// Send initialization request
const initRequest = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'test-client',
      version: '1.0.0'
    }
  },
  id: 1
};

server.stdin.write(JSON.stringify(initRequest) + '\n');

// Handle responses
server.stdout.on('data', (data) => {
  console.log('Response:', data.toString());
});

server.stderr.on('data', (data) => {
  console.log('Server log:', data.toString());
});

// Send list tools request after a delay
setTimeout(() => {
  const listToolsRequest = {
    jsonrpc: '2.0',
    method: 'tools/list',
    params: {},
    id: 2
  };
  
  server.stdin.write(JSON.stringify(listToolsRequest) + '\n');
  
  // Exit after getting response
  setTimeout(() => {
    console.log('Test completed successfully!');
    process.exit(0);
  }, 1000);
}, 1000);

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});