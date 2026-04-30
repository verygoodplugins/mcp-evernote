/**
 * Tests for Zod tool parameter validation (M1).
 */
import {
  CreateNoteSchema,
  SearchNotesSchema,
  DeleteNoteSchema,
  PatchNoteSchema,
  GetNotebookSchema,
  GetTagSchema,
  AddResourceToNoteSchema,
  HealthCheckSchema,
  validateToolArgs,
} from '../../src/tool-schemas';

describe('tool schemas (M1)', () => {
  describe('CreateNoteSchema', () => {
    it('accepts valid input', () => {
      const result = CreateNoteSchema.parse({
        title: 'Test Note',
        content: 'Hello world',
      });
      expect(result.title).toBe('Test Note');
    });

    it('rejects missing title', () => {
      expect(() => CreateNoteSchema.parse({ content: 'text' })).toThrow();
    });

    it('rejects empty title', () => {
      expect(() =>
        CreateNoteSchema.parse({ title: '', content: 'text' }),
      ).toThrow(/Title is required/);
    });

    it('accepts optional tags', () => {
      const result = CreateNoteSchema.parse({
        title: 'Test',
        content: 'text',
        tags: ['a', 'b'],
      });
      expect(result.tags).toEqual(['a', 'b']);
    });
  });

  describe('SearchNotesSchema', () => {
    it('defaults maxResults to 20', () => {
      const result = SearchNotesSchema.parse({ query: 'test' });
      expect(result.maxResults).toBe(20);
    });

    it('rejects maxResults over 100', () => {
      expect(() =>
        SearchNotesSchema.parse({ query: 'test', maxResults: 200 }),
      ).toThrow();
    });

    it('defaults includePreview to false', () => {
      const result = SearchNotesSchema.parse({ query: 'test' });
      expect(result.includePreview).toBe(false);
    });
  });

  describe('DeleteNoteSchema', () => {
    it('rejects missing guid', () => {
      expect(() => DeleteNoteSchema.parse({})).toThrow();
    });

    it('rejects empty guid', () => {
      expect(() => DeleteNoteSchema.parse({ guid: '' })).toThrow();
    });

    it('accepts valid guid', () => {
      const result = DeleteNoteSchema.parse({ guid: 'abc-123' });
      expect(result.guid).toBe('abc-123');
    });
  });

  describe('PatchNoteSchema', () => {
    it('rejects empty replacements array', () => {
      expect(() =>
        PatchNoteSchema.parse({ guid: 'abc', replacements: [] }),
      ).toThrow(/At least one replacement/);
    });

    it('rejects replacement with empty find', () => {
      expect(() =>
        PatchNoteSchema.parse({
          guid: 'abc',
          replacements: [{ find: '', replace: 'new' }],
        }),
      ).toThrow(/Find string must not be empty/);
    });

    it('accepts valid replacements', () => {
      const result = PatchNoteSchema.parse({
        guid: 'abc',
        replacements: [{ find: 'old', replace: 'new' }],
      });
      expect(result.replacements[0].replaceAll).toBe(true);
    });
  });

  describe('GetNotebookSchema', () => {
    it('rejects when neither name nor guid provided', () => {
      expect(() => GetNotebookSchema.parse({})).toThrow(
        /Either name or guid/,
      );
    });

    it('accepts name only', () => {
      const result = GetNotebookSchema.parse({ name: 'My Notebook' });
      expect(result.name).toBe('My Notebook');
    });

    it('accepts guid only', () => {
      const result = GetNotebookSchema.parse({ guid: 'abc' });
      expect(result.guid).toBe('abc');
    });
  });

  describe('GetTagSchema', () => {
    it('rejects when neither name nor guid provided', () => {
      expect(() => GetTagSchema.parse({})).toThrow(/Either name or guid/);
    });
  });

  describe('AddResourceToNoteSchema', () => {
    it('rejects missing filePath', () => {
      expect(() =>
        AddResourceToNoteSchema.parse({ noteGuid: 'abc' }),
      ).toThrow();
    });
  });

  describe('HealthCheckSchema', () => {
    it('defaults verbose to false', () => {
      const result = HealthCheckSchema.parse({});
      expect(result.verbose).toBe(false);
    });
  });

  describe('validateToolArgs', () => {
    it('returns parsed args for known tools', () => {
      const result = validateToolArgs('evernote_create_note', {
        title: 'Test',
        content: 'text',
      });
      expect(result.title).toBe('Test');
    });

    it('passes through for unknown tools', () => {
      const args = { foo: 'bar' };
      const result = validateToolArgs('evernote_list_notebooks', args);
      expect(result).toBe(args);
    });

    it('throws ZodError for invalid args', () => {
      expect(() =>
        validateToolArgs('evernote_delete_note', {}),
      ).toThrow();
    });
  });
});
