import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { NotebookInfo } from './types.js';

interface ResolveNotebookCacheOptions<TApi> {
  currentCache: NotebookInfo[] | null;
  currentApi: TApi | null;
  ensureAPI: () => Promise<TApi>;
  refreshNotebookCache: (api: TApi) => Promise<NotebookInfo[] | null>;
  logError?: (message: string) => void;
}

export async function resolveNotebookCacheForToolDescriptions<TApi>({
  currentCache,
  currentApi,
  ensureAPI,
  refreshNotebookCache,
  logError,
}: ResolveNotebookCacheOptions<TApi>): Promise<NotebookInfo[] | null> {
  if (currentCache !== null) {
    return currentCache;
  }

  try {
    const api = currentApi ?? await ensureAPI();
    return await refreshNotebookCache(api);
  } catch (error: any) {
    logError?.(`Failed to load notebooks for tool descriptions: ${error.message || String(error)}`);
    return currentCache;
  }
}

export function enrichToolsWithNotebookDescriptions(
  tools: Tool[],
  notebooks: NotebookInfo[] | null,
): Tool[] {
  if (!notebooks || notebooks.length === 0) {
    return tools;
  }

  const notebookNames = notebooks.map(notebook => JSON.stringify(notebook.name)).join(', ');
  const defaultNotebook = notebooks.find(notebook => notebook.defaultNotebook);
  const defaultNote = defaultNotebook ? ` Default: ${JSON.stringify(defaultNotebook.name)}.` : '';
  const notebookDescription =
    `Name of the notebook.${defaultNote} Available notebooks: ${notebookNames}. ` +
    `If a name that doesn't exist is provided, a new notebook will be auto-created; ` +
    `if creation fails, the note will use the default notebook.`;

  return tools.map(tool => {
    if (tool.name !== 'evernote_create_note' && tool.name !== 'evernote_update_note') {
      return tool;
    }

    const inputSchema = tool.inputSchema as any;
    const properties = inputSchema.properties || {};

    return {
      ...tool,
      inputSchema: {
        ...inputSchema,
        properties: {
          ...properties,
          notebookName: {
            ...properties.notebookName,
            type: 'string',
            description: notebookDescription,
          },
        },
      },
    };
  });
}
