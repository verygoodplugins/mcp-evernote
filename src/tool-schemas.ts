// Copyright (c) 2026 raffishquartan. All rights reserved.
// Licensed for personal use only.

import { z } from 'zod';

export const CreateNoteSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  content: z.string(),
  notebookName: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const SearchNotesSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  notebookName: z.string().optional(),
  maxResults: z.number().min(1).max(100).optional().default(20),
  includePreview: z.boolean().optional().default(false),
});

export const GetNoteSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  includeContent: z.boolean().optional().default(true),
});

export const UpdateNoteSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  forceUpdate: z.boolean().optional().default(false),
  forceUpdateConfirmation: z.string().optional(),
}).refine(
  data => !data.forceUpdate || data.forceUpdateConfirmation === 'I understand this will delete the original note',
  {
    message: 'forceUpdate requires forceUpdateConfirmation set to exactly: "I understand this will delete the original note"',
    path: ['forceUpdateConfirmation'],
  },
);

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

export const GetResourceSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  includeData: z.boolean().optional().default(true),
});

export const ListNoteResourcesSchema = z.object({
  noteGuid: z.string().min(1, 'Note GUID is required'),
});

export const AddResourceToNoteSchema = z.object({
  noteGuid: z.string().min(1, 'Note GUID is required'),
  filePath: z.string().min(1, 'File path is required'),
  filename: z.string().optional(),
});

export const GetResourceRecognitionSchema = z.object({
  resourceGuid: z.string().min(1, 'Resource GUID is required'),
});

export const GetNotebookSchema = z.object({
  name: z.string().optional(),
  guid: z.string().optional(),
}).refine(data => data.name || data.guid, {
  message: 'Either name or guid must be provided',
});

export const UpdateNotebookSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  name: z.string().optional(),
  stack: z.string().optional(),
});

export const GetTagSchema = z.object({
  name: z.string().optional(),
  guid: z.string().optional(),
}).refine(data => data.name || data.guid, {
  message: 'Either name or guid must be provided',
});

export const UpdateTagSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  name: z.string().optional(),
  parentTagName: z.string().optional(),
});

export const PatchNoteSchema = z.object({
  guid: z.string().min(1, 'GUID is required'),
  replacements: z.array(z.object({
    find: z.string().min(1, 'Find string must not be empty'),
    replace: z.string(),
    replaceAll: z.boolean().optional().default(true),
  })).min(1, 'At least one replacement is required'),
});

export const HealthCheckSchema = z.object({
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
  evernote_list_note_resources: ListNoteResourcesSchema,
  evernote_add_resource_to_note: AddResourceToNoteSchema,
  evernote_get_resource_recognition: GetResourceRecognitionSchema,
  evernote_get_notebook: GetNotebookSchema,
  evernote_update_notebook: UpdateNotebookSchema,
  evernote_get_tag: GetTagSchema,
  evernote_update_tag: UpdateTagSchema,
  evernote_patch_note: PatchNoteSchema,
  evernote_health_check: HealthCheckSchema,
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
  return schema.parse(args);
}
