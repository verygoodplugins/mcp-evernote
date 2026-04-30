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
import { pathToFileURL } from 'url';
import { markdownToENML } from '../../src/markdown';

describe('markdown local attachment path security (C2)', () => {
  let tempDir: string;
  let safeRoot: string;
  let outsideRoot: string;
  let safeFile: string;
  let outsideFile: string;
  const originalAllowedRoots = process.env.EVERNOTE_ALLOWED_FILE_ROOTS;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-evernote-md-paths-'));
    safeRoot = path.join(tempDir, 'safe');
    outsideRoot = path.join(tempDir, 'outside');
    mkdirSync(safeRoot);
    mkdirSync(outsideRoot);
    safeFile = path.join(safeRoot, 'image.png');
    outsideFile = path.join(outsideRoot, 'secret.png');
    writeFileSync(safeFile, Buffer.from('safe-image'));
    writeFileSync(outsideFile, Buffer.from('outside-image'));
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

  it('embeds local files inside configured roots', () => {
    const result = markdownToENML(`![safe](${safeFile})`);

    expect(result.enml).toContain('<en-media');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].sourcePath).toBe(realpathSync(safeFile));
  });

  it('embeds file URLs inside configured roots', () => {
    const result = markdownToENML(`![safe](${pathToFileURL(safeFile).toString()})`);

    expect(result.enml).toContain('<en-media');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].sourcePath).toBe(realpathSync(safeFile));
  });

  it('rejects local files outside configured roots without throwing', () => {
    const result = markdownToENML(`![secret](${outsideFile})`);

    expect(result.enml).not.toContain('<en-media');
    expect(result.enml).toContain('<a href=');
    expect(result.attachments).toHaveLength(0);
  });

  it('rejects symlinks that resolve outside configured roots', () => {
    const linkPath = path.join(safeRoot, 'linked-secret.png');
    symlinkSync(outsideFile, linkPath);

    const result = markdownToENML(`![secret](${linkPath})`);

    expect(result.enml).not.toContain('<en-media');
    expect(result.attachments).toHaveLength(0);
  });
});
