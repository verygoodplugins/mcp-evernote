#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';
import { EvernoteOAuth } from './oauth.js';
import { EvernoteAPI } from './evernote-api.js';
import { EvernoteConfig } from './types.js';

// Load environment variables
config();

// Validate required environment variables
const CONSUMER_KEY = process.env.EVERNOTE_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.EVERNOTE_CONSUMER_SECRET;
const ENVIRONMENT = process.env.EVERNOTE_ENVIRONMENT || 'production';
const CALLBACK_PORT = parseInt(process.env.OAUTH_CALLBACK_PORT || '3000');

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error('Missing required environment variables: EVERNOTE_CONSUMER_KEY and EVERNOTE_CONSUMER_SECRET');
  process.exit(1);
}

// Initialize Evernote configuration
const evernoteConfig: EvernoteConfig = {
  consumerKey: CONSUMER_KEY,
  consumerSecret: CONSUMER_SECRET,
  sandbox: ENVIRONMENT === 'sandbox',
  china: false
};

// Initialize OAuth and API
const oauth = new EvernoteOAuth(evernoteConfig, CALLBACK_PORT);
let api: EvernoteAPI | null = null;

// Initialize API on first use
async function ensureAPI(): Promise<EvernoteAPI> {
  if (!api) {
    const { client, tokens } = await oauth.getAuthenticatedClient();
    api = new EvernoteAPI(client, tokens);
  }
  return api;
}

// Create MCP server
const server = new Server(
  {
    name: 'mcp-evernote',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool schemas
const tools: Tool[] = [
  {
    name: 'evernote_create_note',
    description: 'Create a new note in Evernote',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Note title',
        },
        content: {
          type: 'string',
          description: 'Note content (plain text or markdown)',
        },
        notebookName: {
          type: 'string',
          description: 'Name of the notebook to create the note in (optional)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply to the note',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'evernote_search_notes',
    description: 'Search for notes in Evernote',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (Evernote search syntax supported)',
        },
        notebookName: {
          type: 'string',
          description: 'Limit search to specific notebook',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results (default: 20, max: 100)',
          default: 20,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'evernote_get_note',
    description: 'Get a specific note by its GUID',
    inputSchema: {
      type: 'object',
      properties: {
        guid: {
          type: 'string',
          description: 'Note GUID',
        },
        includeContent: {
          type: 'boolean',
          description: 'Include note content (default: true)',
          default: true,
        },
      },
      required: ['guid'],
    },
  },
  {
    name: 'evernote_update_note',
    description: 'Update an existing note',
    inputSchema: {
      type: 'object',
      properties: {
        guid: {
          type: 'string',
          description: 'Note GUID',
        },
        title: {
          type: 'string',
          description: 'New title (optional)',
        },
        content: {
          type: 'string',
          description: 'New content (optional)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags (replaces existing tags)',
        },
      },
      required: ['guid'],
    },
  },
  {
    name: 'evernote_delete_note',
    description: 'Delete a note',
    inputSchema: {
      type: 'object',
      properties: {
        guid: {
          type: 'string',
          description: 'Note GUID',
        },
      },
      required: ['guid'],
    },
  },
  {
    name: 'evernote_list_notebooks',
    description: 'List all notebooks',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'evernote_create_notebook',
    description: 'Create a new notebook',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Notebook name',
        },
        stack: {
          type: 'string',
          description: 'Stack name (optional)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'evernote_list_tags',
    description: 'List all tags',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'evernote_create_tag',
    description: 'Create a new tag',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tag name',
        },
        parentTagName: {
          type: 'string',
          description: 'Parent tag name (optional)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'evernote_get_user_info',
    description: 'Get current user information and quota',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'evernote_revoke_auth',
    description: 'Revoke stored authentication token',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools,
  };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Handle auth revocation specially
    if (name === 'evernote_revoke_auth') {
      await oauth.revokeToken();
      api = null;
      return {
        content: [
          {
            type: 'text',
            text: 'Authentication token revoked. You will need to re-authenticate on next use.',
          },
        ],
      };
    }

    // Ensure API is initialized for all other operations
    const evernoteApi = await ensureAPI();

    switch (name) {
      case 'evernote_create_note': {
        const { title, content, notebookName, tags } = args as any;
        
        // Find notebook GUID if name provided
        let notebookGuid: string | undefined;
        if (notebookName) {
          const notebooks = await evernoteApi.listNotebooks();
          const notebook = notebooks.find(nb => nb.name === notebookName);
          if (notebook) {
            notebookGuid = notebook.guid;
          } else {
            throw new Error(`Notebook '${notebookName}' not found`);
          }
        }

        const note = await evernoteApi.createNote({
          title,
          content,
          notebookGuid,
          tagNames: tags,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Note created successfully!\nGUID: ${note.guid}\nTitle: ${note.title}`,
            },
          ],
        };
      }

      case 'evernote_search_notes': {
        const { query, notebookName, maxResults = 20 } = args as any;
        
        // Find notebook GUID if name provided
        let notebookGuid: string | undefined;
        if (notebookName) {
          const notebooks = await evernoteApi.listNotebooks();
          const notebook = notebooks.find(nb => nb.name === notebookName);
          if (notebook) {
            notebookGuid = notebook.guid;
          }
        }

        const results = await evernoteApi.searchNotes({
          words: query,
          notebookGuid,
          maxNotes: Math.min(maxResults, 100),
        });

        const notes = results.notes.map((note: any) => ({
          guid: note.guid,
          title: note.title,
          created: new Date(note.created).toISOString(),
          updated: new Date(note.updated).toISOString(),
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                totalNotes: results.totalNotes,
                notes: notes,
              }, null, 2),
            },
          ],
        };
      }

      case 'evernote_get_note': {
        const { guid, includeContent = true } = args as any;
        const note = await evernoteApi.getNote(guid, includeContent);
        
        let result: any = {
          guid: note.guid,
          title: note.title,
          created: new Date(note.created).toISOString(),
          updated: new Date(note.updated).toISOString(),
        };

        if (includeContent && note.content) {
          result.content = evernoteApi.convertFromENML(note.content);
        }

        if (note.tagNames) {
          result.tags = note.tagNames;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'evernote_update_note': {
        const { guid, title, content, tags } = args as any;
        
        // Get existing note
        const note = await evernoteApi.getNote(guid, true);
        
        // Update fields
        if (title !== undefined) note.title = title;
        if (content !== undefined) {
          let enmlContent = '<?xml version="1.0" encoding="UTF-8"?>';
          enmlContent += '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">';
          enmlContent += '<en-note>';
          enmlContent += evernoteApi['convertToENML'](content);
          enmlContent += '</en-note>';
          note.content = enmlContent;
        }
        if (tags !== undefined) note.tagNames = tags;

        const updatedNote = await evernoteApi.updateNote(note);

        return {
          content: [
            {
              type: 'text',
              text: `Note updated successfully!\nGUID: ${updatedNote.guid}\nTitle: ${updatedNote.title}`,
            },
          ],
        };
      }

      case 'evernote_delete_note': {
        const { guid } = args as any;
        await evernoteApi.deleteNote(guid);
        
        return {
          content: [
            {
              type: 'text',
              text: `Note ${guid} deleted successfully`,
            },
          ],
        };
      }

      case 'evernote_list_notebooks': {
        const notebooks = await evernoteApi.listNotebooks();
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(notebooks, null, 2),
            },
          ],
        };
      }

      case 'evernote_create_notebook': {
        const { name, stack } = args as any;
        const notebook = await evernoteApi.createNotebook(name, stack);
        
        return {
          content: [
            {
              type: 'text',
              text: `Notebook created successfully!\nGUID: ${notebook.guid}\nName: ${notebook.name}`,
            },
          ],
        };
      }

      case 'evernote_list_tags': {
        const tags = await evernoteApi.listTags();
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tags, null, 2),
            },
          ],
        };
      }

      case 'evernote_create_tag': {
        const { name, parentTagName } = args as any;
        
        // Find parent tag GUID if name provided
        let parentGuid: string | undefined;
        if (parentTagName) {
          const tags = await evernoteApi.listTags();
          const parentTag = tags.find(t => t.name === parentTagName);
          if (parentTag) {
            parentGuid = parentTag.guid;
          }
        }

        const tag = await evernoteApi.createTag(name, parentGuid);
        
        return {
          content: [
            {
              type: 'text',
              text: `Tag created successfully!\nGUID: ${tag.guid}\nName: ${tag.name}`,
            },
          ],
        };
      }

      case 'evernote_get_user_info': {
        const [user, quota] = await Promise.all([
          evernoteApi.getUser(),
          evernoteApi.getQuotaInfo(),
        ]);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                user: {
                  id: user.id,
                  username: user.username,
                  email: user.email,
                  name: user.name,
                },
                quota: quota,
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    console.error(`Tool ${name} failed:`, error);
    throw new Error(`Tool ${name} failed: ${error.message}`);
  }
});

// Start server
async function main() {
  console.error('Starting Evernote MCP server...');
  console.error(`Environment: ${ENVIRONMENT}`);
  console.error(`OAuth callback port: ${CALLBACK_PORT}`);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Evernote MCP server running on stdio');
}

main().catch(console.error);