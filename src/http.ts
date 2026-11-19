#!/usr/bin/env node
/**
 * `mcp-evernote-http` entry point: the same server as `mcp-evernote`, served
 * over Streamable HTTP (see src/http-server.ts) instead of stdio.
 * Equivalent to `mcp-evernote --http`.
 */
if (!process.argv.includes("--http")) {
  process.argv.push("--http");
}
await import("./index.js");

export {};
