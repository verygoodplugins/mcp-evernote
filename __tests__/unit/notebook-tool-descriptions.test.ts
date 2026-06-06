import { describe, expect, it, jest } from '@jest/globals';
import {
  enrichToolsWithNotebookDescriptions,
  resolveNotebookCacheForToolDescriptions,
} from '../../src/notebook-tool-descriptions';

const baseTools = [
  {
    name: 'evernote_create_note',
    description: 'Create a note',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title' },
        notebookName: { type: 'string', description: 'Name of notebook' },
      },
    },
  },
  {
    name: 'evernote_update_note',
    description: 'Update a note',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'GUID' },
        notebookName: { type: 'string', description: 'Move note to this notebook' },
      },
    },
  },
  {
    name: 'evernote_search_notes',
    description: 'Search notes',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query' },
      },
    },
  },
];

const notebooks = [
  { guid: 'personal-guid', name: 'Personal', defaultNotebook: true },
  { guid: 'work-guid', name: 'Work' },
];

describe('notebook-aware tool descriptions', () => {
  it('loads notebooks through ensureAPI when tool discovery happens before any tool call', async () => {
    const api = {};
    const ensureAPI = jest.fn<() => Promise<object>>().mockResolvedValue(api);
    const refreshNotebookCache = jest
      .fn<(evernoteApi: object) => Promise<typeof notebooks>>()
      .mockResolvedValue(notebooks);

    const result = await resolveNotebookCacheForToolDescriptions({
      currentCache: null,
      currentApi: null,
      ensureAPI,
      refreshNotebookCache,
      logError: jest.fn(),
    });

    expect(ensureAPI).toHaveBeenCalledTimes(1);
    expect(refreshNotebookCache).toHaveBeenCalledWith(api);
    expect(result).toEqual(notebooks);
  });

  it('keeps tool discovery available when API initialization fails', async () => {
    const ensureAPI = jest.fn<() => Promise<object>>().mockRejectedValue(new Error('auth failed'));
    const refreshNotebookCache = jest.fn<(evernoteApi: object) => Promise<typeof notebooks>>();

    const result = await resolveNotebookCacheForToolDescriptions({
      currentCache: null,
      currentApi: null,
      ensureAPI,
      refreshNotebookCache,
      logError: jest.fn(),
    });

    expect(result).toBeNull();
    expect(refreshNotebookCache).not.toHaveBeenCalled();
  });

  it('injects live notebook names into create and update tool schemas', () => {
    const enriched = enrichToolsWithNotebookDescriptions(baseTools as any, notebooks);
    const createNoteTool = enriched.find((tool: any) => tool.name === 'evernote_create_note')!;
    const updateNoteTool = enriched.find((tool: any) => tool.name === 'evernote_update_note')!;
    const searchTool = enriched.find((tool: any) => tool.name === 'evernote_search_notes')!;
    const createNotebookDescription = (createNoteTool.inputSchema as any).properties.notebookName.description;
    const updateNotebookDescription = (updateNoteTool.inputSchema as any).properties.notebookName.description;

    expect(createNotebookDescription).toContain(
      'Available notebooks: "Personal", "Work".',
    );
    expect(createNotebookDescription).toContain(
      'Default: "Personal".',
    );
    expect(createNotebookDescription).toContain(
      'if creation fails, the note will use the default notebook.',
    );
    expect(updateNotebookDescription).toBe(createNotebookDescription);
    expect((searchTool.inputSchema as any).properties).not.toHaveProperty('notebookName');
  });
});
