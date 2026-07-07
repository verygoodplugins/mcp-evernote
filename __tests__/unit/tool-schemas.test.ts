/**
 * Tests for Zod tool parameter validation (M1).
 */
import {
  CreateNoteSchema,
  SearchNotesSchema,
  GetNoteSchema,
  UpdateNoteSchema,
  DeleteNoteSchema,
  PatchNoteSchema,
  ListNotebooksSchema,
  ListTagsSchema,
  AddResourceToNoteSchema,
  GetResourceSchema,
  ConnectionSchema,
  PollingSchema,
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

    it('defaults offset, includeContent, and format', () => {
      const result = SearchNotesSchema.parse({ query: 'test' });
      expect(result.offset).toBe(0);
      expect(result.includeContent).toBe(false);
      expect(result.format).toBe('markdown');
    });

    it('rejects a negative offset', () => {
      expect(() =>
        SearchNotesSchema.parse({ query: 'test', offset: -1 }),
      ).toThrow();
    });

    it('rejects an invalid format', () => {
      expect(() =>
        SearchNotesSchema.parse({ query: 'test', format: 'html' }),
      ).toThrow();
    });
  });

  describe('GetNoteSchema', () => {
    it('defaults attachment text extraction to true in single mode', () => {
      const result = GetNoteSchema.parse({ guid: 'abc-123' });
      expect(result.includeAttachmentText).toBe(true);
      expect(result.format).toBe('markdown');
    });

    it('accepts the legacy includePdfContent flag', () => {
      const result = GetNoteSchema.parse({ guid: 'abc-123', includePdfContent: false });
      expect(result.includePdfContent).toBe(false);
      expect(result.includeAttachmentText).toBe(false);
    });

    it('accepts the generic includeAttachmentText flag', () => {
      const result = GetNoteSchema.parse({ guid: 'abc-123', includeAttachmentText: false });
      expect(result.includeAttachmentText).toBe(false);
    });

    it('accepts a guids batch and defaults includeAttachmentText to false', () => {
      const result = GetNoteSchema.parse({ guids: ['a', 'b'] });
      expect(result.includeAttachmentText).toBe(false);
      expect(result.format).toBe('markdown');
    });

    it('rejects when neither guid nor guids is provided', () => {
      expect(() => GetNoteSchema.parse({})).toThrow(/exactly one of guid or guids/);
    });

    it('rejects when both guid and guids are provided', () => {
      expect(() =>
        GetNoteSchema.parse({ guid: 'a', guids: ['b'] }),
      ).toThrow(/exactly one of guid or guids/);
    });

    it('rejects more than 25 guids', () => {
      const many = Array.from({ length: 26 }, (_, i) => `g${i}`);
      expect(() => GetNoteSchema.parse({ guids: many })).toThrow();
    });

    it('accepts a valid format and rejects an invalid one', () => {
      expect(GetNoteSchema.parse({ guid: 'a', format: 'text' }).format).toBe('text');
      expect(() => GetNoteSchema.parse({ guid: 'a', format: 'pdf' })).toThrow();
    });
  });

  describe('UpdateNoteSchema', () => {
    it('rejects empty notebookName', () => {
      expect(() =>
        UpdateNoteSchema.parse({ guid: 'abc-123', notebookName: '' }),
      ).toThrow(/Notebook name cannot be empty/);
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

  describe('ListNotebooksSchema', () => {
    it('accepts empty args (list all)', () => {
      expect(() => ListNotebooksSchema.parse({})).not.toThrow();
    });

    it('accepts name only (single lookup)', () => {
      const result = ListNotebooksSchema.parse({ name: 'My Notebook' });
      expect(result.name).toBe('My Notebook');
    });

    it('accepts guid only (single lookup)', () => {
      const result = ListNotebooksSchema.parse({ guid: 'abc' });
      expect(result.guid).toBe('abc');
    });
  });

  describe('ListTagsSchema', () => {
    it('accepts empty args (list all)', () => {
      expect(() => ListTagsSchema.parse({})).not.toThrow();
    });

    it('accepts name only (single lookup)', () => {
      expect(ListTagsSchema.parse({ name: 'important' }).name).toBe('important');
    });
  });

  describe('AddResourceToNoteSchema', () => {
    it('rejects missing filePath', () => {
      expect(() =>
        AddResourceToNoteSchema.parse({ noteGuid: 'abc' }),
      ).toThrow();
    });
  });

  describe('GetResourceSchema', () => {
    it('defaults as to "text" when neither as nor includeData is given', () => {
      const result = GetResourceSchema.parse({ guid: 'r1' });
      expect(result.as).toBe('text');
    });

    it('honors an explicit as view', () => {
      expect(GetResourceSchema.parse({ guid: 'r1', as: 'recognition' }).as).toBe(
        'recognition',
      );
    });

    it('maps deprecated includeData:true to binary', () => {
      const result = GetResourceSchema.parse({ guid: 'r1', includeData: true });
      expect(result.as).toBe('binary');
    });

    it('maps deprecated includeData:false to metadata', () => {
      const result = GetResourceSchema.parse({ guid: 'r1', includeData: false });
      expect(result.as).toBe('metadata');
    });

    it('lets an explicit as win over includeData', () => {
      const result = GetResourceSchema.parse({
        guid: 'r1',
        as: 'text',
        includeData: true,
      });
      expect(result.as).toBe('text');
    });

    it('rejects an unknown as view', () => {
      expect(() => GetResourceSchema.parse({ guid: 'r1', as: 'thumbnail' })).toThrow();
    });
  });

  describe('ConnectionSchema', () => {
    it('defaults verbose to false', () => {
      const result = ConnectionSchema.parse({ action: 'status' });
      expect(result.verbose).toBe(false);
    });

    it('accepts each action', () => {
      for (const action of ['status', 'user', 'reconnect', 'revoke'] as const) {
        expect(ConnectionSchema.parse({ action }).action).toBe(action);
      }
    });

    it('rejects an unknown action', () => {
      expect(() => ConnectionSchema.parse({ action: 'login' })).toThrow();
    });
  });

  describe('PollingSchema', () => {
    it('accepts each action', () => {
      for (const action of ['start', 'stop', 'poll', 'status'] as const) {
        expect(PollingSchema.parse({ action }).action).toBe(action);
      }
    });

    it('rejects a missing action', () => {
      expect(() => PollingSchema.parse({})).toThrow();
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

    it('passes through for tools without a schema', () => {
      const args = { foo: 'bar' };
      const result = validateToolArgs('evernote_unregistered_tool', args);
      expect(result).toBe(args);
    });

    it('throws ZodError for invalid args', () => {
      expect(() =>
        validateToolArgs('evernote_delete_note', {}),
      ).toThrow();
    });
  });
});
