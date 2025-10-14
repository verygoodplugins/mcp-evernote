import { describe, it, expect } from '@jest/globals';

describe('Basic Functionality Tests', () => {
  it('should validate that core modules can be imported', () => {
    // Test that our TypeScript configuration works
    expect(() => {
      require('../../src/types');
    }).not.toThrow();
  });

  it('should verify package configuration', () => {
    const packageJson = require('../../package.json');
    
    expect(packageJson.name).toBe('@verygoodplugins/mcp-evernote');
    expect(packageJson.main).toBe('dist/index.js');
    expect(packageJson.scripts.test).toBe('jest');
    expect(packageJson.devDependencies.jest).toBeDefined();
  });

  it('should validate build outputs exist after compilation', () => {
    const fs = require('fs');
    const path = require('path');
    
    // These files should exist after npm run build
    const distPath = path.join(process.cwd(), 'dist');
    
    if (fs.existsSync(distPath)) {
      expect(fs.existsSync(path.join(distPath, 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(distPath, 'auth-standalone.js'))).toBe(true);
    }
  });

  it('should have proper TypeScript configuration', () => {
    const tsConfig = require('../../tsconfig.json');
    
    expect(tsConfig.compilerOptions).toBeDefined();
    expect(tsConfig.compilerOptions.target).toBeDefined();
    expect(tsConfig.compilerOptions.module).toBeDefined();
  });
});
