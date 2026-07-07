import { z } from 'zod';

export const CreateNoteSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  content: z.string(),
  notebookName: z.string().trim().min(1, 'Notebook name cannot be empty').optional(),
  tags: z.array(z.string()).optional(),
});

const NoteFormatSchema = z.enum(['markdown', 'text', 'enml']);

export const SearchNotesSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  notebookName: z.string().trim().min(1, 'Notebook name cannot be empty').optional(),
  maxResults: z.number().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  includePreview: z.boolean().optional().default(false),
  includeContent: z.boolean().optional().default(false),
  format: NoteFormatSchema.optional().default('markdown'),
});

// get_note accepts either a single `guid` or a batch `guids` (max 25), never
// both. Attachment-text extraction defaults on for a single note but off in
// batch mode (a wide fan-out of binary downloads is the wrong default).
export const GetNoteSchema = z.object({
  guid: z.string().min(1).optional(),
  guids: z.array(z.string().min(1)).min(1).max(25).optional(),
  format: NoteFormatSchema.optional().default('markdown'),
  includeContent: z.boolean().optional().default(true),
  includePdfContent: z.boolean().optional(),
  includeAttachmentText: z.boolean().optional(),
}).refine(data => !!data.guid !== !!data.guids, {
  message: 'Provide exactly one of guid or guids (max 25)',
  path: ['guid'],
}).transform(data => ({
  ...data,
  includeAttachmentText:
    data.includeAttachmentText ??
    data.includePdfContent ??
    (data.guids ? false : true),
}));

const NoteReplacementSchema = z.object({
  find: z.string().min(1, 'Find string must not be empty'),
  replace: z.string(),
  replaceAll: z.boolean().optional().default(true),
});

// update_note has two modes: a full-field update (title/content/tags/notebook)
// or, when `replacements` is present, a targeted find-and-replace patch that
// leaves title/tags/notebook/attachments untouched. The two are mutually
// exclusive.
export const UpdateNoteSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  title: z.string().optional(),
  content: z.string().optional(),
  notebookName: z.string().trim().min(1, 'Notebook name cannot be empty').optional(),
  tags: z.array(z.string()).optional(),
  forceUpdate: z.boolean().optional().default(false),
  forceUpdateConfirmation: z.string().optional(),
  replacements: z.array(NoteReplacementSchema).min(1, 'At least one replacement is required').optional(),
}).superRefine((data, ctx) => {
  if (
    data.forceUpdate &&
    data.forceUpdateConfirmation !== 'I understand this will delete the original note'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['forceUpdateConfirmation'],
      message:
        'forceUpdate requires forceUpdateConfirmation set to exactly: "I understand this will delete the original note"',
    });
  }
  if (
    data.replacements &&
    (data.title !== undefined ||
      data.content !== undefined ||
      data.tags !== undefined ||
      data.notebookName !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replacements'],
      message:
        'replacements (patch mode) cannot be combined with title, content, tags, or notebookName',
    });
  }
  // Patch mode routes through patchNoteContent and never reaches the
  // forceUpdate edit-lock fallback, so reject the combination rather than
  // silently ignoring the destructive-retry request.
  if (data.replacements && data.forceUpdate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['forceUpdate'],
      message:
        'forceUpdate is not supported in patch mode (replacements); omit it or use a full-field update',
    });
  }
});

export const DeleteNoteSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
});

export const CreateNotebookSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  stack: z.string().optional(),
});

export const CreateTagSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  parentTagName: z.string().optional(),
});

// get_resource projects one attachment through one of four views. Default
// `text` is the agent-usual case; base64 `binary` must be requested explicitly.
// `includeData` is a deprecated alias: true -> binary, false -> metadata.
export const GetResourceSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  as: z.enum(['text', 'binary', 'recognition', 'metadata']).optional(),
  includeData: z.boolean().optional(),
}).transform(data => ({
  guid: data.guid,
  as:
    data.as ??
    (data.includeData === undefined
      ? 'text'
      : data.includeData
        ? 'binary'
        : 'metadata'),
}));

export const AddResourceToNoteSchema = z.object({
  noteGuid: z.string().min(1, 'Note GUID is required'),
  filePath: z.string().min(1, 'File path is required'),
  filename: z.string().optional(),
});

// Retired but kept as a hidden, shape-exact legacy handler (see tool-aliases.ts).
export const ListNoteResourcesSchema = z.object({
  noteGuid: z.string().min(1, 'Note GUID is required'),
});

// list_notebooks lists all notebooks, or returns one (fresh, full detail) when
// name or guid is given — absorbing the retired get_notebook. name/guid must be
// non-empty when present so an empty-string lookup errors instead of silently
// listing all.
export const ListNotebooksSchema = z.object({
  name: z.string().min(1, 'name must not be empty').optional(),
  guid: z.string().min(1, 'guid must not be empty').optional(),
});

export const UpdateNotebookSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  name: z.string().optional(),
  stack: z.string().optional(),
});

// list_tags lists all tags, or returns one (fresh, full detail) when name or
// guid is given — absorbing the retired get_tag. name/guid must be non-empty
// when present so an empty-string lookup errors instead of silently listing all.
export const ListTagsSchema = z.object({
  name: z.string().min(1, 'name must not be empty').optional(),
  guid: z.string().min(1, 'guid must not be empty').optional(),
});

export const UpdateTagSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  name: z.string().optional(),
  parentTagName: z.string().optional(),
});

export const PollingSchema = z.object({
  action: z.enum(['start', 'stop', 'poll', 'status']),
});

export const ConnectionSchema = z.object({
  action: z.enum(['status', 'user', 'reconnect', 'revoke']),
  verbose: z.boolean().optional().default(false),
});

// Map tool names to their schemas
export const toolSchemas: Record<string, z.ZodType<any>> = {
  evernote_create_note: CreateNoteSchema,
  evernote_search_notes: SearchNotesSchema,
  evernote_get_note: GetNoteSchema,
  evernote_update_note: UpdateNoteSchema,
  evernote_delete_note: DeleteNoteSchema,
  evernote_create_notebook: CreateNotebookSchema,
  evernote_create_tag: CreateTagSchema,
  evernote_get_resource: GetResourceSchema,
  evernote_add_resource_to_note: AddResourceToNoteSchema,
  evernote_list_note_resources: ListNoteResourcesSchema,
  evernote_list_notebooks: ListNotebooksSchema,
  evernote_update_notebook: UpdateNotebookSchema,
  evernote_list_tags: ListTagsSchema,
  evernote_update_tag: UpdateTagSchema,
  evernote_polling: PollingSchema,
  evernote_connection: ConnectionSchema,
};

/**
 * Validate tool arguments against the schema for the given tool name.
 * Returns the parsed (and defaulted) arguments.
 * Throws a descriptive error on validation failure.
 */
export function validateToolArgs(toolName: string, args: unknown): any {
  const schema = toolSchemas[toolName];
  if (!schema) {
    // No schema for this tool (e.g. list tools with no args) - pass through
    return args;
  }
  // MCP clients may omit `arguments` entirely for a zero-arg call (e.g. the
  // list-all form of list_notebooks/list_tags). Coerce that to {} so object
  // schemas apply their optional-field defaults instead of rejecting undefined;
  // schemas with required fields still error with a proper "required" message.
  return schema.parse(args ?? {});
}
