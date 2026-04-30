/**
 * Tests for logging sanitization (H4).
 *
 * Verifies that sensitive data (note titles, content, tags, full args)
 * is not logged or returned in error responses.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const indexSource = readFileSync(
  resolve(__dirname, '../../src/index.ts'),
  'utf-8',
);

const evernoteApiSource = readFileSync(
  resolve(__dirname, '../../src/evernote-api.ts'),
  'utf-8',
);

describe('logging sanitization (H4)', () => {
  describe('evernote-api.ts updateNote logging', () => {
    // Extract the updateNote method source
    const updateNoteBlock = evernoteApiSource.match(
      /async updateNote\([\s\S]*?(?=\n  async |\n  \/\/ (?:Helper|Sync|User))/,
    );

    it('does not log note titles', () => {
      expect(updateNoteBlock).not.toBeNull();
      expect(updateNoteBlock![0]).not.toContain('note.title');
      expect(updateNoteBlock![0]).not.toContain('Note Title');
    });

    it('does not log note content length', () => {
      expect(updateNoteBlock).not.toBeNull();
      expect(updateNoteBlock![0]).not.toContain('content.length');
      expect(updateNoteBlock![0]).not.toContain('Note content length');
    });

    it('does not log tag values', () => {
      expect(updateNoteBlock).not.toBeNull();
      expect(updateNoteBlock![0]).not.toContain('note.tagNames');
      expect(updateNoteBlock![0]).not.toContain('Note tags');
    });

    it('still logs note GUID for traceability', () => {
      expect(updateNoteBlock).not.toBeNull();
      expect(updateNoteBlock![0]).toContain('note.guid');
    });
  });

  describe('index.ts error handler logging', () => {
    // Extract the error handler block (the catch in CallToolRequestSchema)
    const errorHandlerBlock = indexSource.match(
      /\/\/ Enhanced error|const timestamp = new Date[\s\S]*?isError: true,\s*\};/,
    );

    it('does not log full tool arguments', () => {
      expect(errorHandlerBlock).not.toBeNull();
      expect(errorHandlerBlock![0]).not.toContain('arguments: args');
      expect(errorHandlerBlock![0]).not.toContain('JSON.stringify(args');
    });

    it('does not log stack traces', () => {
      expect(errorHandlerBlock).not.toBeNull();
      expect(errorHandlerBlock![0]).not.toContain('error.stack');
    });

    it('does not include debug dump in user-facing response', () => {
      expect(errorHandlerBlock).not.toBeNull();
      expect(errorHandlerBlock![0]).not.toContain('Debug Info');
    });
  });

  describe('index.ts update note handler logging', () => {
    // Find the evernote_update_note case block
    const updateCaseBlock = indexSource.match(
      /case 'evernote_update_note'[\s\S]*?(?=case 'evernote_delete_note')/,
    );

    it('does not log note title during update', () => {
      expect(updateCaseBlock).not.toBeNull();
      // Should not contain verbose title/content/tag logging
      expect(updateCaseBlock![0]).not.toContain('Update Note Debug');
      expect(updateCaseBlock![0]).not.toContain('Step 1:');
      expect(updateCaseBlock![0]).not.toContain('Step 2:');
      expect(updateCaseBlock![0]).not.toContain('Step 3:');
    });

    it('does not log step-level stack traces', () => {
      expect(updateCaseBlock).not.toBeNull();
      expect(updateCaseBlock![0]).not.toContain('stepError.stack');
      expect(updateCaseBlock![0]).not.toContain('Step Stack');
    });
  });
});
