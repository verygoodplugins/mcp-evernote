/**
 * Tests for forceUpdate guard rails (M6).
 */
import { UpdateNoteSchema } from '../../src/tool-schemas';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('forceUpdate guard rails (M6)', () => {
  describe('Zod schema validation', () => {
    it('allows normal update without forceUpdate', () => {
      const result = UpdateNoteSchema.parse({
        guid: 'abc-123',
        title: 'New Title',
      });
      expect(result.forceUpdate).toBe(false);
    });

    it('rejects forceUpdate=true without confirmation string', () => {
      expect(() =>
        UpdateNoteSchema.parse({
          guid: 'abc-123',
          forceUpdate: true,
        }),
      ).toThrow(/forceUpdateConfirmation/);
    });

    it('rejects forceUpdate=true with wrong confirmation string', () => {
      expect(() =>
        UpdateNoteSchema.parse({
          guid: 'abc-123',
          forceUpdate: true,
          forceUpdateConfirmation: 'yes please',
        }),
      ).toThrow(/forceUpdateConfirmation/);
    });

    it('accepts forceUpdate=true with exact confirmation string', () => {
      const result = UpdateNoteSchema.parse({
        guid: 'abc-123',
        forceUpdate: true,
        forceUpdateConfirmation:
          'I understand this will delete the original note',
      });
      expect(result.forceUpdate).toBe(true);
    });

    it('allows forceUpdateConfirmation without forceUpdate (no-op)', () => {
      const result = UpdateNoteSchema.parse({
        guid: 'abc-123',
        forceUpdateConfirmation:
          'I understand this will delete the original note',
      });
      expect(result.forceUpdate).toBe(false);
    });
  });

  describe('tool schema description', () => {
    const indexSource = readFileSync(
      resolve(__dirname, '../../src/index.ts'),
      'utf-8',
    );

    it('forceUpdate description warns about destructive behaviour', () => {
      expect(indexSource).toContain('DESTRUCTIVE');
      expect(indexSource).toContain('DELETES the original note');
    });

    it('forceUpdateConfirmation is documented in the schema', () => {
      expect(indexSource).toContain('forceUpdateConfirmation');
      expect(indexSource).toContain(
        'I understand this will delete the original note',
      );
    });
  });
});
