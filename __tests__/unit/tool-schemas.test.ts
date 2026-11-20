/**
 * Tests for Zod tool parameter validation (M1).
 */
import {
  CreateNoteSchema,
  SearchNotesSchema,
  GetNoteSchema,
  UpdateNoteSchema,
  DeleteNoteSchema,
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

    it('defaults createNotebook to false', () => {
      const result = CreateNoteSchema.parse({ title: 'T', content: 'c', notebookName: 'Work' });
      expect(result.createNotebook).toBe(false);
    });

    it('accepts createNotebook with notebookName', () => {
      const result = CreateNoteSchema.parse({
        title: 'T',
        content: 'c',
        notebookName: 'New',
        createNotebook: true,
      });
      expect(result.createNotebook).toBe(true);
    });

    it('rejects createNotebook without notebookName', () => {
      expect(() =>
        CreateNoteSchema.parse({ title: 'T', content: 'c', createNotebook: true }),
      ).toThrow(/createNotebook requires notebookName/);
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

    it('accepts a full-field update', () => {
      const result = UpdateNoteSchema.parse({
        guid: 'abc',
        title: 'New',
        tags: ['x'],
      });
      expect(result.title).toBe('New');
    });

    describe('patch mode (replacements)', () => {
      it('rejects an empty replacements array', () => {
        expect(() =>
          UpdateNoteSchema.parse({ guid: 'abc', replacements: [] }),
        ).toThrow(/At least one replacement/);
      });

      it('rejects a replacement with an empty find', () => {
        expect(() =>
          UpdateNoteSchema.parse({
            guid: 'abc',
            replacements: [{ find: '', replace: 'new' }],
          }),
        ).toThrow(/Find string must not be empty/);
      });

      it('defaults replaceAll to true', () => {
        const result = UpdateNoteSchema.parse({
          guid: 'abc',
          replacements: [{ find: 'old', replace: 'new' }],
        });
        expect(result.replacements?.[0]?.replaceAll).toBe(true);
      });

      it('rejects combining replacements with full-field inputs', () => {
        expect(() =>
          UpdateNoteSchema.parse({
            guid: 'abc',
            content: 'body',
            replacements: [{ find: 'old', replace: 'new' }],
          }),
        ).toThrow(/cannot be combined/);
      });

      it('rejects combining replacements with forceUpdate', () => {
        expect(() =>
          UpdateNoteSchema.parse({
            guid: 'abc',
            forceUpdate: true,
            forceUpdateConfirmation:
              'I understand this will delete the original note',
            replacements: [{ find: 'old', replace: 'new' }],
          }),
        ).toThrow(/forceUpdate is not supported in patch mode/);
      });
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

    it('rejects an empty-string name (would otherwise list-all)', () => {
      expect(() => ListNotebooksSchema.parse({ name: '' })).toThrow(
        /name must not be empty/,
      );
    });
  });

  describe('ListTagsSchema', () => {
    it('accepts empty args (list all)', () => {
      expect(() => ListTagsSchema.parse({})).not.toThrow();
    });

    it('accepts name only (single lookup)', () => {
      expect(ListTagsSchema.parse({ name: 'important' }).name).toBe('important');
    });

    it('accepts query, limit, and offset', () => {
      expect(ListTagsSchema.parse({ query: 'wp', limit: 50, offset: 100 })).toEqual({
        query: 'wp',
        limit: 50,
        offset: 100,
      });
    });

    it('rejects out-of-range paging and empty queries', () => {
      expect(() => ListTagsSchema.parse({ limit: 0 })).toThrow();
      expect(() => ListTagsSchema.parse({ limit: 1001 })).toThrow();
      expect(() => ListTagsSchema.parse({ offset: -1 })).toThrow();
      expect(() => ListTagsSchema.parse({ limit: 1.5 })).toThrow();
      expect(() => ListTagsSchema.parse({ query: '  ' })).toThrow(/query must not be empty/);
    });

    it('rejects mixing single-tag lookup with paging', () => {
      expect(() => ListTagsSchema.parse({ name: 'x', limit: 5 })).toThrow(
        /cannot be combined with query, limit, or offset/,
      );
    });
  });

  describe('AddResourceToNoteSchema', () => {
    it('rejects missing filePath and content', () => {
      expect(() =>
        AddResourceToNoteSchema.parse({ noteGuid: 'abc' }),
      ).toThrow(/exactly one of filePath or content/);
    });

    it('accepts a filePath upload without filename', () => {
      const result = AddResourceToNoteSchema.parse({
        noteGuid: 'abc',
        filePath: '/tmp/doc.pdf',
      });
      expect(result.filePath).toBe('/tmp/doc.pdf');
    });

    it('accepts a base64 content upload with filename', () => {
      const result = AddResourceToNoteSchema.parse({
        noteGuid: 'abc',
        content: 'aGVsbG8=',
        filename: 'hello.txt',
        mimeType: 'text/plain',
      });
      expect(result.content).toBe('aGVsbG8=');
      expect(result.filename).toBe('hello.txt');
    });

    it('rejects content without filename', () => {
      expect(() =>
        AddResourceToNoteSchema.parse({
          noteGuid: 'abc',
          content: 'aGVsbG8=',
        }),
      ).toThrow(/filename is required/);
    });

    it('rejects filePath and content together', () => {
      expect(() =>
        AddResourceToNoteSchema.parse({
          noteGuid: 'abc',
          filePath: '/tmp/doc.pdf',
          content: 'aGVsbG8=',
          filename: 'doc.pdf',
        }),
      ).toThrow(/exactly one of filePath or content/);
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

    it('passes through saveToPath', () => {
      const result = GetResourceSchema.parse({
        guid: 'r1',
        as: 'binary',
        saveToPath: '/tmp/out.bin',
      });
      expect(result.saveToPath).toBe('/tmp/out.bin');
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

  describe('UpdateNoteSchema createNotebook', () => {
    it('defaults createNotebook to false and allows it on batch moves', () => {
      expect(UpdateNoteSchema.parse({ guid: 'n1', notebookName: 'Work' }).createNotebook).toBe(false);
      expect(
        UpdateNoteSchema.parse({ guids: ['a', 'b'], notebookName: 'New', createNotebook: true })
          .createNotebook,
      ).toBe(true);
    });

    it('rejects createNotebook without notebookName', () => {
      expect(() =>
        UpdateNoteSchema.parse({ guid: 'n1', title: 'x', createNotebook: true }),
      ).toThrow(/createNotebook requires notebookName/);
    });
  });

  describe('UpdateNoteSchema additive tags and batch moves', () => {
    it('accepts addTags and removeTags on a single guid', () => {
      const result = UpdateNoteSchema.parse({
        guid: 'n1',
        addTags: ['urgent'],
        removeTags: ['later'],
      });
      expect(result.addTags).toEqual(['urgent']);
      expect(result.removeTags).toEqual(['later']);
    });

    it('rejects combining tags with addTags', () => {
      expect(() =>
        UpdateNoteSchema.parse({
          guid: 'n1',
          tags: ['a'],
          addTags: ['b'],
        }),
      ).toThrow(/cannot be combined with addTags/);
    });

    it('rejects combining replacements with addTags', () => {
      expect(() =>
        UpdateNoteSchema.parse({
          guid: 'n1',
          replacements: [{ find: 'a', replace: 'b' }],
          addTags: ['x'],
        }),
      ).toThrow(/cannot be combined/);
    });

    it('accepts a batch move with guids and notebookName', () => {
      const result = UpdateNoteSchema.parse({
        guids: ['n1', 'n2'],
        notebookName: 'Archive',
      });
      expect(result.guids).toEqual(['n1', 'n2']);
    });

    it('rejects guid and guids together', () => {
      expect(() =>
        UpdateNoteSchema.parse({
          guid: 'n1',
          guids: ['n2'],
          notebookName: 'Archive',
        }),
      ).toThrow(/exactly one of guid or guids/);
    });

    it('rejects batch updates that include title or content', () => {
      expect(() =>
        UpdateNoteSchema.parse({
          guids: ['n1'],
          notebookName: 'Archive',
          title: 'Nope',
        }),
      ).toThrow(/only supports notebookName/);
    });

    it('rejects a batch update with no move or tag changes', () => {
      expect(() =>
        UpdateNoteSchema.parse({ guids: ['n1'] }),
      ).toThrow(/requires notebookName and\/or addTags/);
    });
  });

  describe('DeleteNoteSchema restore action', () => {
    it('defaults action to trash', () => {
      expect(DeleteNoteSchema.parse({ guid: 'n1' }).action).toBe('trash');
    });

    it('accepts action restore', () => {
      expect(DeleteNoteSchema.parse({ guid: 'n1', action: 'restore' }).action).toBe(
        'restore',
      );
    });

    it('rejects an unknown action', () => {
      expect(() =>
        DeleteNoteSchema.parse({ guid: 'n1', action: 'expunge' }),
      ).toThrow();
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

    it('coerces omitted args to {} for zero-arg list calls', () => {
      // MCP clients may omit `arguments` for the list-all form.
      expect(() => validateToolArgs('evernote_list_notebooks', undefined)).not.toThrow();
      expect(validateToolArgs('evernote_list_tags', undefined)).toEqual({});
    });

    it('still rejects omitted args when a field is required', () => {
      expect(() => validateToolArgs('evernote_polling', undefined)).toThrow();
    });

    it('throws ZodError for invalid args', () => {
      expect(() =>
        validateToolArgs('evernote_delete_note', {}),
      ).toThrow();
    });
  });
});
