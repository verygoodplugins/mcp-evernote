import { readFileSync } from 'fs';
import { resolve } from 'path';

const runtimeEntrypoints = [
  ['MCP stdio server', '../../src/index.ts'],
  ['standalone auth CLI', '../../src/auth-standalone.ts'],
  ['Claude install helper', '../../scripts/install-to-claude.js'],
] as const;

describe('dotenv runtime logging', () => {
  it.each(runtimeEntrypoints)('%s loads dotenv quietly', (_name, relativePath) => {
    const source = readFileSync(resolve(__dirname, relativePath), 'utf-8');

    expect(source).toContain('config({ quiet: true })');
    expect(source).not.toMatch(/\bconfig\(\s*\)/);
  });
});
