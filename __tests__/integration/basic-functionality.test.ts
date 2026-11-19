import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const readJson = (relativePath: string) =>
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, relativePath), 'utf-8'));

describe('Basic Functionality Tests', () => {
  it('should validate that core modules can be imported', async () => {
    // Test that our TypeScript configuration works
    await expect(import('../../src/types.js')).resolves.toBeDefined();
  });

  it('should verify package configuration', () => {
    const packageJson = readJson('../../package.json');

    expect(packageJson.name).toBe('@verygoodplugins/mcp-evernote');
    expect(packageJson.main).toBe('dist/index.js');
    // Jest runs in native ESM mode, which needs --experimental-vm-modules.
    expect(packageJson.scripts.test).toBe('node --experimental-vm-modules --disable-warning=ExperimentalWarning node_modules/jest/bin/jest.js');
    expect(packageJson.devDependencies.jest).toBeDefined();
  });

  it('should validate build outputs exist after compilation', () => {
    // These files should exist after npm run build
    const distPath = path.join(process.cwd(), 'dist');

    if (fs.existsSync(distPath)) {
      expect(fs.existsSync(path.join(distPath, 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(distPath, 'auth-standalone.js'))).toBe(true);
    }
  });

  it('should have proper TypeScript configuration', () => {
    const tsConfig = readJson('../../tsconfig.json');

    expect(tsConfig.compilerOptions).toBeDefined();
    expect(tsConfig.compilerOptions.target).toBeDefined();
    expect(tsConfig.compilerOptions.module).toBeDefined();
  });
});
