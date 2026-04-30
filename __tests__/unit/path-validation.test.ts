import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import {
  getAllowedFileRoots,
  validateLocalFilePath,
  validateLocalFilePathSync,
} from '../../src/path-security';

describe('safe local file path validation', () => {
  let tempDir: string;
  let safeRoot: string;
  let outsideRoot: string;
  let safeFile: string;
  let outsideFile: string;
  const originalAllowedRoots = process.env.EVERNOTE_ALLOWED_FILE_ROOTS;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-evernote-paths-'));
    safeRoot = path.join(tempDir, 'safe');
    outsideRoot = path.join(tempDir, 'outside');
    mkdirSync(safeRoot);
    mkdirSync(outsideRoot);
    safeFile = path.join(safeRoot, 'document.txt');
    outsideFile = path.join(outsideRoot, 'secret.txt');
    writeFileSync(safeFile, 'safe');
    writeFileSync(outsideFile, 'secret');
    process.env.EVERNOTE_ALLOWED_FILE_ROOTS = safeRoot;
  });

  afterEach(() => {
    if (originalAllowedRoots === undefined) {
      delete process.env.EVERNOTE_ALLOWED_FILE_ROOTS;
    } else {
      process.env.EVERNOTE_ALLOWED_FILE_ROOTS = originalAllowedRoots;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts files inside configured roots', async () => {
    const realSafeFile = realpathSync.native(safeFile);
    await expect(validateLocalFilePath(safeFile)).resolves.toBe(realSafeFile);
    expect(validateLocalFilePathSync(safeFile)).toBe(realSafeFile);
  });

  it('rejects files outside configured roots', async () => {
    await expect(validateLocalFilePath(outsideFile)).rejects.toThrow(
      /outside allowed roots/i,
    );
    expect(validateLocalFilePathSync(outsideFile)).toBeNull();
  });

  it('rejects symlinks that resolve outside configured roots', async () => {
    const linkPath = path.join(safeRoot, 'linked-secret.txt');
    symlinkSync(outsideFile, linkPath);

    await expect(validateLocalFilePath(linkPath)).rejects.toThrow(
      /outside allowed roots/i,
    );
    expect(validateLocalFilePathSync(linkPath)).toBeNull();
  });

  it('defaults to macOS-style home paths without /home assumptions', () => {
    delete process.env.EVERNOTE_ALLOWED_FILE_ROOTS;
    const homeFile = path.join(os.homedir(), `.mcp-evernote-${Date.now()}.txt`);
    writeFileSync(homeFile, 'home');

    try {
      expect(validateLocalFilePathSync(homeFile)).toBe(realpathSync.native(homeFile));
      expect(getAllowedFileRoots()).toContain(realpathSync.native(os.homedir()));
    } finally {
      rmSync(homeFile, { force: true });
    }
  });
});

describe('safe path validation is used in evernote-api.ts', () => {
  it('addResourceToNote validates before readFile', () => {
    const { readFileSync } = require('fs');
    const source = readFileSync(
      require('path').resolve(__dirname, '../../src/evernote-api.ts'),
      'utf-8',
    );

    const addResourceBlock = source.match(
      /async addResourceToNote[\s\S]*?return await this\.updateNote/,
    );
    expect(addResourceBlock).not.toBeNull();
    expect(addResourceBlock![0]).toContain('validateLocalFilePath(filePath)');

    const validateIdx = addResourceBlock![0].indexOf('validateLocalFilePath');
    const readFileIdx = addResourceBlock![0].indexOf('readFile(');
    expect(validateIdx).toBeLessThan(readFileIdx);
  });
});
