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
if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error('Missing required environment variables: EVERNOTE_CONSUMER_KEY and EVERNOTE_CONSUMER_SECRET');
  process.exit(1);
}

// Polling configuration
const MIN_POLL_INTERVAL = 15 * 60 * 1000; // 15 minutes minimum (Evernote requirement)
const DEFAULT_POLL_INTERVAL = 60 * 60 * 1000; // 1 hour default
const POLL_INTERVAL = Math.max(
  MIN_POLL_INTERVAL,
  parseInt(process.env.EVERNOTE_POLL_INTERVAL || String(DEFAULT_POLL_INTERVAL), 10)
);
const WEBHOOK_URL = process.env.EVERNOTE_WEBHOOK_URL; // URL to notify on changes
const POLLING_ENABLED = process.env.EVERNOTE_POLLING_ENABLED === 'true';

// Polling state
let lastUpdateCount: number | null = null;
let pollInterval: NodeJS.Timeout | null = null;
let lastPollTime: number = 0;
let pollErrorCount: number = 0;

// Initialize Evernote configuration
const evernoteConfig: EvernoteConfig = {
  consumerKey: CONSUMER_KEY,
  consumerSecret: CONSUMER_SECRET,
  sandbox: ENVIRONMENT === 'sandbox',
  china: false
};

// Initialize OAuth and API
const oauth = new EvernoteOAuth(evernoteConfig);
let api: EvernoteAPI | null = null;

// Initialize API on first use
let apiInitError: string | null = null;
let lastInitAttempt: number = 0;
const INIT_RETRY_DELAY = 30000; // 30 seconds before retrying failed init

async function ensureAPI(forceReinit: boolean = false): Promise<EvernoteAPI> {
  // If forcing reinitialization, clear existing state
  if (forceReinit) {
    api = null;
    apiInitError = null;
    lastInitAttempt = 0;
  }
  
  // If we have a working API, return it
  if (api) {
    return api;
  }
  
  // If we recently failed, check if enough time has passed to retry
  const now = Date.now();
  if (apiInitError && lastInitAttempt > 0) {
    const timeSinceLastAttempt = now - lastInitAttempt;
    if (timeSinceLastAttempt < INIT_RETRY_DELAY) {
      throw new Error(`Not connected. Last attempt failed ${Math.floor(timeSinceLastAttempt / 1000)}s ago. Retry in ${Math.ceil((INIT_RETRY_DELAY - timeSinceLastAttempt) / 1000)}s.`);
    }
    // Enough time has passed, clear error and retry
    console.error(`Retrying API initialization after ${timeSinceLastAttempt}ms...`);
    apiInitError = null;
  }
  
  try {
    lastInitAttempt = now;
    const { client, tokens } = await oauth.getAuthenticatedClient();
    api = new EvernoteAPI(client, tokens);
    apiInitError = null;
    console.error('API initialized successfully');
    return api;
  } catch (error: any) {
    apiInitError = error.message || 'Failed to initialize Evernote API';
    console.error(`API initialization failed: ${apiInitError}`);
    
    // For auth errors, provide a clearer message
    const errorMsg = error.message || '';
    if (errorMsg.includes('Authentication required') || errorMsg.includes('token')) {
      throw new Error('Not connected: Authentication required. Token may be expired or invalid.');
    }
    
    throw new Error(`Not connected: ${apiInitError}`);
  }
}

// ============================================================================
// Polling for Changes
// ============================================================================

interface PollingChange {
  type: 'note_created' | 'note_updated' | 'note_deleted' | 'notebook_changed' | 'tag_changed';
  guid?: string;
  title?: string;
  notebookGuid?: string;
  timestamp: string;
}

async function sendWebhookNotification(changes: PollingChange[]): Promise<void> {
  if (!WEBHOOK_URL) {
    console.error('No webhook URL configured, skipping notification');
    return;
  }

  // Send one webhook per change for cleaner workflow processing
  for (const change of changes) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Evernote-Source': 'mcp-evernote-polling',
        },
        body: JSON.stringify({
          source: 'mcp-evernote',
          timestamp: new Date().toISOString(),
          changes: [change], // Single change per webhook
        }),
      });

      if (!response.ok) {
        console.error(`Webhook notification failed for ${change.guid}: ${response.status} ${response.statusText}`);
      } else {
        console.error(`Webhook notification sent: ${change.type} - ${change.title || change.guid}`);
      }
    } catch (error: any) {
      console.error(`Webhook notification error for ${change.guid}: ${error.message}`);
    }
  }

  if (changes.length > 0) {
    console.error(`Webhook notifications complete: ${changes.length} changes sent`);
  }
}

async function checkForChanges(): Promise<PollingChange[]> {
  const changes: PollingChange[] = [];
  
  try {
    const evernoteApi = await ensureAPI();
    const syncState = await evernoteApi.getSyncState();
    const currentUpdateCount = syncState.updateCount;
    
    console.error(`Polling: Current updateCount = ${currentUpdateCount}, last = ${lastUpdateCount}`);
    
    // First run - just store the count
    if (lastUpdateCount === null) {
      lastUpdateCount = currentUpdateCount;
      console.error('Polling: Initial sync state captured');
      return changes;
    }
    
    // No changes
    if (currentUpdateCount === lastUpdateCount) {
      console.error('Polling: No changes detected');
      return changes;
    }
    
    // Changes detected - get the sync chunk to see what changed
    console.error(`Polling: Changes detected! Getting sync chunk from USN ${lastUpdateCount}...`);
    
    try {
      const chunk = await evernoteApi.getSyncChunk(lastUpdateCount, 100, false);
      
      // Process notes
      if (chunk.notes && chunk.notes.length > 0) {
        for (const note of chunk.notes) {
          const isNew = note.created === note.updated;
          changes.push({
            type: isNew ? 'note_created' : 'note_updated',
            guid: note.guid,
            title: note.title,
            notebookGuid: note.notebookGuid,
            timestamp: new Date(note.updated).toISOString(),
          });
        }
      }
      
      // Process expunged notes (deleted)
      if (chunk.expungedNotes && chunk.expungedNotes.length > 0) {
        for (const guid of chunk.expungedNotes) {
          changes.push({
            type: 'note_deleted',
            guid,
            timestamp: new Date().toISOString(),
          });
        }
      }
      
      // Process notebooks
      if (chunk.notebooks && chunk.notebooks.length > 0) {
        for (const notebook of chunk.notebooks) {
          changes.push({
            type: 'notebook_changed',
            guid: notebook.guid,
            title: notebook.name,
            timestamp: new Date().toISOString(),
          });
        }
      }
      
      // Process tags
      if (chunk.tags && chunk.tags.length > 0) {
        for (const tag of chunk.tags) {
          changes.push({
            type: 'tag_changed',
            guid: tag.guid,
            title: tag.name,
            timestamp: new Date().toISOString(),
          });
        }
      }
      
      console.error(`Polling: Found ${changes.length} changes`);
    } catch (chunkError: any) {
      console.error(`Polling: Failed to get sync chunk: ${chunkError.message}`);
      // Still update the count to avoid re-processing
    }
    
    lastUpdateCount = currentUpdateCount;
    return changes;
    
  } catch (error: any) {
    console.error(`Polling error: ${error.message}`);
    pollErrorCount++;
    
    // If too many errors, stop polling
    if (pollErrorCount >= 5) {
      console.error('Polling: Too many errors, stopping polling');
      stopPolling();
    }
    
    return changes;
  }
}

async function pollOnce(): Promise<PollingChange[]> {
  lastPollTime = Date.now();
  pollErrorCount = 0; // Reset on successful poll attempt
  
  const changes = await checkForChanges();
  
  if (changes.length > 0 && WEBHOOK_URL) {
    await sendWebhookNotification(changes);
  }
  
  return changes;
}

function startPolling(): void {
  if (pollInterval) {
    console.error('Polling already running');
    return;
  }
  
  console.error(`Starting Evernote polling every ${POLL_INTERVAL / 60000} minutes`);
  if (WEBHOOK_URL) {
    console.error(`Webhook URL: ${WEBHOOK_URL}`);
  } else {
    console.error('Warning: No EVERNOTE_WEBHOOK_URL configured - changes will be logged but not sent');
  }
  
  // Do an initial poll
  pollOnce().catch(err => console.error(`Initial poll failed: ${err.message}`));
  
  // Set up the interval
  pollInterval = setInterval(() => {
    pollOnce().catch(err => console.error(`Poll failed: ${err.message}`));
  }, POLL_INTERVAL);
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.error('Polling stopped');
  }
}

function getPollingStatus(): any {
  return {
    enabled: POLLING_ENABLED,
    running: !!pollInterval,
    intervalMinutes: POLL_INTERVAL / 60000,
    minIntervalMinutes: MIN_POLL_INTERVAL / 60000,
    webhookUrl: WEBHOOK_URL ? WEBHOOK_URL.substring(0, 50) + '...' : null,
    lastPollTime: lastPollTime ? new Date(lastPollTime).toISOString() : null,
    lastUpdateCount,
    errorCount: pollErrorCount,
  };
}

// ============================================================================
// MCP Server
// ============================================================================

// Create MCP server
const server = new Server(
  {
    name: 'mcp-evernote',
    version: '1.2.0',
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
    description: 'Search for notes in Evernote with optional content preview',
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
        includePreview: {
          type: 'boolean',
          description: 'Include first ~300 chars of note content as plain text preview (requires extra API calls)',
          default: false,
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
          description: 'New content (optional, Markdown supported)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags (replaces existing tags)',
        },
        forceUpdate: {
          type: 'boolean',
          description: 'Force update by creating a new note if update fails due to locks',
          default: false,
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
  {
    name: 'evernote_health_check',
    description: 'Check the health and status of the Evernote MCP server',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: {
          type: 'boolean',
          description: 'Include detailed diagnostic information',
          default: false,
        },
      },
    },
  },
  {
    name: 'evernote_reconnect',
    description: 'Force reconnection to Evernote (useful when "Not connected" errors persist)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'evernote_start_polling',
    description: 'Start polling for Evernote changes. Checks for new/updated notes and sends notifications to configured webhook URL.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'evernote_stop_polling',
    description: 'Stop polling for Evernote changes',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'evernote_poll_now',
    description: 'Check for Evernote changes immediately without waiting for next poll interval',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'evernote_polling_status',
    description: 'Get the current polling configuration and status',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // Resource tools
  {
    name: 'evernote_get_resource',
    description: 'Download a resource (attachment) by its GUID',
    inputSchema: {
      type: 'object',
      properties: {
        guid: {
          type: 'string',
          description: 'Resource GUID',
        },
        includeData: {
          type: 'boolean',
          description: 'Include binary data as base64 (default: true)',
          default: true,
        },
      },
      required: ['guid'],
    },
  },
  {
    name: 'evernote_list_note_resources',
    description: 'List all resources (attachments) in a note',
    inputSchema: {
      type: 'object',
      properties: {
        noteGuid: {
          type: 'string',
          description: 'Note GUID',
        },
      },
      required: ['noteGuid'],
    },
  },
  {
    name: 'evernote_add_resource_to_note',
    description: 'Add a file/image attachment to an existing note',
    inputSchema: {
      type: 'object',
      properties: {
        noteGuid: {
          type: 'string',
          description: 'Note GUID',
        },
        filePath: {
          type: 'string',
          description: 'Local file path to attach',
        },
        filename: {
          type: 'string',
          description: 'Optional display filename (defaults to file basename)',
        },
      },
      required: ['noteGuid', 'filePath'],
    },
  },
  {
    name: 'evernote_get_resource_recognition',
    description: 'Get OCR/text recognition data from an image resource',
    inputSchema: {
      type: 'object',
      properties: {
        resourceGuid: {
          type: 'string',
          description: 'Resource GUID',
        },
      },
      required: ['resourceGuid'],
    },
  },
  // Notebook get/update tools
  {
    name: 'evernote_get_notebook',
    description: 'Get notebook details by name or GUID',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Notebook name',
        },
        guid: {
          type: 'string',
          description: 'Notebook GUID',
        },
      },
    },
  },
  {
    name: 'evernote_update_notebook',
    description: 'Update notebook name or stack',
    inputSchema: {
      type: 'object',
      properties: {
        guid: {
          type: 'string',
          description: 'Notebook GUID',
        },
        name: {
          type: 'string',
          description: 'New notebook name',
        },
        stack: {
          type: 'string',
          description: 'Stack name (empty string to remove from stack)',
        },
      },
      required: ['guid'],
    },
  },
  // Tag get/update tools
  {
    name: 'evernote_get_tag',
    description: 'Get tag details by name or GUID',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tag name',
        },
        guid: {
          type: 'string',
          description: 'Tag GUID',
        },
      },
    },
  },
  {
    name: 'evernote_update_tag',
    description: 'Update tag name or parent',
    inputSchema: {
      type: 'object',
      properties: {
        guid: {
          type: 'string',
          description: 'Tag GUID',
        },
        name: {
          type: 'string',
          description: 'New tag name',
        },
        parentTagName: {
          type: 'string',
          description: 'Parent tag name (empty string to remove parent)',
        },
      },
      required: ['guid'],
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
      apiInitError = null;
      lastInitAttempt = 0;
      return {
        content: [
          {
            type: 'text',
            text: 'Authentication token revoked. You will need to re-authenticate on next use.',
          },
        ],
      };
    }
    
    // Handle reconnect specially
    if (name === 'evernote_reconnect') {
      console.error('Force reconnect requested');
      try {
        await ensureAPI(true); // Force reinitialization
        return {
          content: [
            {
              type: 'text',
              text: '✅ Successfully reconnected to Evernote',
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Reconnection failed: ${error.message}\n\nYou may need to re-authenticate. Run "npm run auth" or use the /mcp command in Claude Code.`,
            },
          ],
        };
      }
    }
    
    // Handle polling tools
    if (name === 'evernote_start_polling') {
      startPolling();
      const status = getPollingStatus();
      return {
        content: [
          {
            type: 'text',
            text: `✅ Polling started\n\nInterval: Every ${status.intervalMinutes} minutes\n` +
                  `Webhook: ${WEBHOOK_URL || 'Not configured'}\n\n` +
                  `Changes will be detected and sent to the webhook URL when found.`,
          },
        ],
      };
    }
    
    if (name === 'evernote_stop_polling') {
      stopPolling();
      return {
        content: [
          {
            type: 'text',
            text: '✅ Polling stopped',
          },
        ],
      };
    }
    
    if (name === 'evernote_poll_now') {
      try {
        const changes = await pollOnce();
        if (changes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: '✅ Poll complete - no changes detected',
              },
            ],
          };
        }
        
        const changesSummary = changes.map(c => 
          `- ${c.type}: ${c.title || c.guid} (${c.timestamp})`
        ).join('\n');
        
        return {
          content: [
            {
              type: 'text',
              text: `✅ Poll complete - ${changes.length} changes detected:\n\n${changesSummary}\n\n` +
                    (WEBHOOK_URL ? 'Webhook notification sent.' : 'No webhook configured - changes not sent.'),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Poll failed: ${error.message}`,
            },
          ],
        };
      }
    }
    
    if (name === 'evernote_polling_status') {
      const status = getPollingStatus();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(status, null, 2),
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
        const { query, notebookName, maxResults = 20, includePreview = false } = args as any;

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

        // Build tag lookup map (tagGuid -> tagName) - single API call
        let tagMap: Map<string, string> | undefined;
        const hasAnyTags = results.notes.some((note: any) => note.tagGuids && note.tagGuids.length > 0);
        if (hasAnyTags) {
          const tags = await evernoteApi.listTags();
          tagMap = new Map(tags.map(t => [t.guid!, t.name!]));
        }

        // Build enhanced note results
        const notes = await Promise.all(results.notes.map(async (note: any) => {
          const enhanced: any = {
            guid: note.guid,
            title: note.title,
            created: new Date(note.created).toISOString(),
            updated: new Date(note.updated).toISOString(),
            contentLength: note.contentLength,
            notebookGuid: note.notebookGuid,
          };

          // Resolve tag names from GUIDs
          if (note.tagGuids && note.tagGuids.length > 0 && tagMap) {
            enhanced.tags = note.tagGuids
              .map((guid: string) => tagMap!.get(guid))
              .filter(Boolean);
          }

          // Include useful attributes if present
          if (note.attributes) {
            if (note.attributes.sourceURL) {
              enhanced.sourceURL = note.attributes.sourceURL;
            }
            if (note.attributes.author) {
              enhanced.author = note.attributes.author;
            }
          }

          // Fetch content preview if requested
          if (includePreview) {
            try {
              const preview = await evernoteApi.getNotePreview(note.guid, 300);
              if (preview) {
                enhanced.preview = preview;
              }
            } catch (e) {
              // Skip preview on error, don't fail the whole search
              console.error(`Failed to get preview for note ${note.guid}: ${(e as Error).message}`);
            }
          }

          return enhanced;
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
        const note = await evernoteApi.getNote(guid, includeContent, includeContent);
        
        const result: any = {
          guid: note.guid,
          title: note.title,
          created: new Date(note.created).toISOString(),
          updated: new Date(note.updated).toISOString(),
        };

        if (includeContent && note.content) {
          result.content = evernoteApi.convertENMLToMarkdown(note.content, note.resources);
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
        const { guid, title, content, tags, forceUpdate = false } = args as any;
        
        console.error(`=== Update Note Debug ===`);
        console.error(`GUID: ${guid}`);
        console.error(`Title: ${title || 'unchanged'}`);
        console.error(`Content: ${content ? `${content.length} chars` : 'unchanged'}`);
        console.error(`Tags: ${tags ? JSON.stringify(tags) : 'unchanged'}`);
        console.error(`========================`);
        
        try {
          // Get existing note
          console.error(`Step 1: Getting existing note ${guid}...`);
          const note = await evernoteApi.getNote(guid, true, true);
          console.error(`Step 1 complete: Retrieved note "${note.title}"`);
          
          // Update fields
          if (title !== undefined) {
            console.error(`Step 2: Updating title from "${note.title}" to "${title}"`);
            note.title = title;
          }
          
          if (content !== undefined) {
            console.error(`Step 3: Updating content (${content.length} chars)...`);
            await evernoteApi.applyMarkdownToNote(note, content);
            console.error(`Step 3 complete: Content updated`);
          }
          
          if (tags !== undefined) {
            console.error(`Step 4: Updating tags to ${JSON.stringify(tags)}`);
            note.tagNames = tags;
          }

          console.error(`Step 5: Calling updateNote API...`);
          const updatedNote = await evernoteApi.updateNote(note);
          console.error(`Step 5 complete: Note updated successfully`);

          return {
            content: [
              {
                type: 'text',
                text: `✅ Note updated successfully!\nGUID: ${updatedNote.guid}\nTitle: ${updatedNote.title}`,
              },
            ],
          };
        } catch (stepError: any) {
          console.error(`=== Update Note Step Failed ===`);
          console.error(`Step Error: ${stepError.message}`);
          console.error(`Error Code: ${stepError.errorCode}`);
          console.error(`Step Stack: ${stepError.stack}`);
          console.error(`==============================`);
          
          // Handle RTE room conflict with forceUpdate option
          if (stepError.errorCode === 19 && forceUpdate) {
            console.error(`Attempting force update by creating new note...`);
            try {
              // Get the original note again for force update
              const originalNote = await evernoteApi.getNote(guid, true, true);
              
              // Create a new note with updated content
              const newNote = await evernoteApi.createNote({
                title: title || originalNote.title,
                content: content || evernoteApi.convertENMLToMarkdown(originalNote.content, originalNote.resources),
                notebookGuid: originalNote.notebookGuid,
                tagNames: tags || originalNote.tagNames,
              });
              
              // Delete the old note
              await evernoteApi.deleteNote(guid);
              
              return {
                content: [
                  {
                    type: 'text',
                    text: `⚠️ Note update forced by creating new note due to edit lock!\n` +
                          `Original GUID: ${guid}\n` +
                          `New GUID: ${newNote.guid}\n` +
                          `Title: ${newNote.title}\n\n` +
                          `The original note was deleted and replaced with an updated version.`,
                  },
                ],
              };
            } catch (forceError: any) {
              console.error(`Force update also failed: ${forceError.message}`);
              stepError.message += `\n\nForce update also failed: ${forceError.message}`;
            }
          }
          
          throw stepError;
        }
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

      // Resource tools
      case 'evernote_get_resource': {
        const { guid, includeData = true } = args as any;
        const resource = await evernoteApi.getResource(guid, includeData);

        const result: any = {
          guid: resource.guid,
          filename: resource.attributes?.fileName,
          mimeType: resource.mime,
          size: resource.data?.size || 0,
          hash: resource.data?.bodyHash
            ? Buffer.from(resource.data.bodyHash).toString('hex')
            : '',
        };

        if (includeData && resource.data?.body) {
          result.data = Buffer.from(resource.data.body).toString('base64');
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

      case 'evernote_list_note_resources': {
        const { noteGuid } = args as any;
        const resources = await evernoteApi.listNoteResources(noteGuid);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(resources, null, 2),
            },
          ],
        };
      }

      case 'evernote_add_resource_to_note': {
        const { noteGuid, filePath, filename } = args as any;
        const updatedNote = await evernoteApi.addResourceToNote(noteGuid, filePath, filename);

        return {
          content: [
            {
              type: 'text',
              text: `✅ Resource added successfully!\nNote GUID: ${updatedNote.guid}\nNote Title: ${updatedNote.title}`,
            },
          ],
        };
      }

      case 'evernote_get_resource_recognition': {
        const { resourceGuid } = args as any;
        const recognition = await evernoteApi.getResourceRecognition(resourceGuid);

        // Extract just the text for a summary
        const allText = recognition.items
          .map(item => item.alternatives[0]?.text)
          .filter(Boolean)
          .join(' ');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ...recognition,
                  extractedText: allText || '(no text recognized)',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Notebook get/update tools
      case 'evernote_get_notebook': {
        const { name, guid } = args as any;

        if (!name && !guid) {
          throw new Error('Either name or guid must be provided');
        }

        let notebook;
        if (guid) {
          notebook = await evernoteApi.getNotebook(guid);
        } else {
          const notebooks = await evernoteApi.listNotebooks();
          notebook = notebooks.find(nb => nb.name === name);
          if (!notebook) {
            throw new Error(`Notebook '${name}' not found`);
          }
          // Get full notebook details
          notebook = await evernoteApi.getNotebook(notebook.guid);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(notebook, null, 2),
            },
          ],
        };
      }

      case 'evernote_update_notebook': {
        const { guid, name, stack } = args as any;
        const notebook = await evernoteApi.getNotebook(guid);

        if (name !== undefined) {
          notebook.name = name;
        }
        if (stack !== undefined) {
          notebook.stack = stack || null; // Empty string removes stack
        }

        const updatedNotebook = await evernoteApi.updateNotebook(notebook);

        return {
          content: [
            {
              type: 'text',
              text: `✅ Notebook updated!\nGUID: ${updatedNotebook.guid}\nName: ${updatedNotebook.name}\nStack: ${updatedNotebook.stack || '(none)'}`,
            },
          ],
        };
      }

      // Tag get/update tools
      case 'evernote_get_tag': {
        const { name, guid } = args as any;

        if (!name && !guid) {
          throw new Error('Either name or guid must be provided');
        }

        let tag;
        if (guid) {
          tag = await evernoteApi.getTag(guid);
        } else {
          const tags = await evernoteApi.listTags();
          tag = tags.find(t => t.name === name);
          if (!tag) {
            throw new Error(`Tag '${name}' not found`);
          }
          // Get full tag details
          tag = await evernoteApi.getTag(tag.guid!);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tag, null, 2),
            },
          ],
        };
      }

      case 'evernote_update_tag': {
        const { guid, name, parentTagName } = args as any;
        const tag = await evernoteApi.getTag(guid);

        if (name !== undefined) {
          tag.name = name;
        }
        if (parentTagName !== undefined) {
          if (parentTagName === '') {
            tag.parentGuid = null; // Remove parent
          } else {
            const tags = await evernoteApi.listTags();
            const parentTag = tags.find(t => t.name === parentTagName);
            if (!parentTag) {
              throw new Error(`Parent tag '${parentTagName}' not found`);
            }
            tag.parentGuid = parentTag.guid;
          }
        }

        const updatedTag = await evernoteApi.updateTag(tag);

        return {
          content: [
            {
              type: 'text',
              text: `✅ Tag updated!\nGUID: ${updatedTag.guid}\nName: ${updatedTag.name}\nParent: ${updatedTag.parentGuid || '(none)'}`,
            },
          ],
        };
      }

      case 'evernote_health_check': {
        const { verbose = false } = args as any;

        // Basic server info
        const healthStatus: any = {
          server: {
            name: 'mcp-evernote',
            version: '1.2.0',
            status: 'running',
            environment: ENVIRONMENT,
            timestamp: new Date().toISOString(),
          },
          configuration: {
            consumerKeySet: !!CONSUMER_KEY,
            consumerSecretSet: !!CONSUMER_SECRET,
            environment: ENVIRONMENT,
            isClaudeCode: oauth['isClaudeCode'],
          },
          authentication: {
            status: 'checking',
            apiInitialized: !!api,
            lastError: apiInitError,
          },
        };

        // Try to check authentication status
        try {
          // Check if we have tokens without initializing API
          const hasEnvToken = !!process.env.EVERNOTE_ACCESS_TOKEN;
          const hasOAuthToken = !!process.env.OAUTH_TOKEN;
          
          // Try to load token file
          let hasTokenFile = false;
          let tokenFileInfo: any = null;
          try {
            const fs = await import('fs/promises');
            const path = await import('path');
            const tokenPath = path.join(process.cwd(), '.evernote-token.json');
            const tokenData = await fs.readFile(tokenPath, 'utf-8');
            const token = JSON.parse(tokenData);
            hasTokenFile = true;
            tokenFileInfo = {
              exists: true,
              hasToken: !!token.token,
              hasNoteStoreUrl: !!token.noteStoreUrl,
              userId: token.userId,
              expires: token.expires ? new Date(token.expires).toISOString() : null,
              isExpired: token.expires ? token.expires < Date.now() : false,
            };
          } catch (e) {
            tokenFileInfo = { exists: false, error: (e as Error).message };
          }

          healthStatus.authentication = {
            status: 'checked',
            apiInitialized: !!api,
            hasEnvToken,
            hasOAuthToken,
            hasTokenFile,
            tokenFileInfo: verbose ? tokenFileInfo : undefined,
            lastError: apiInitError,
          };

          // If API is already initialized, test it
          if (api) {
            try {
              const user = await api.getUser();
              healthStatus.authentication.status = 'authenticated';
              healthStatus.authentication.user = {
                id: user.id,
                username: user.username,
              };
              healthStatus.status = 'healthy';
            } catch (e) {
              healthStatus.authentication.status = 'api_error';
              healthStatus.authentication.apiError = (e as Error).message;
              healthStatus.status = 'unhealthy';
            }
          } else {
            // Try to initialize API if we haven't yet
            try {
              await ensureAPI();
              healthStatus.authentication.status = 'authenticated';
              healthStatus.authentication.apiInitialized = true;
              healthStatus.status = 'healthy';
              
              // Get user info if successful
              try {
                const user = await api!.getUser();
                healthStatus.authentication.user = {
                  id: user.id,
                  username: user.username,
                };
              } catch (e) {
                // API initialized but can't get user
                healthStatus.authentication.apiError = (e as Error).message;
              }
            } catch (e) {
              healthStatus.authentication.status = 'not_authenticated';
              healthStatus.authentication.initError = (e as Error).message;
              healthStatus.status = 'needs_auth';
            }
          }
        } catch (error: any) {
          healthStatus.authentication.error = error.message;
          healthStatus.status = 'error';
        }

        // Add diagnostic information if verbose
        if (verbose) {
          healthStatus.diagnostics = {
            cwd: process.cwd(),
            nodeVersion: process.version,
            platform: process.platform,
            env: {
              MCP_TRANSPORT: process.env.MCP_TRANSPORT || 'not set',
              CLAUDE_CODE_MCP: process.env.CLAUDE_CODE_MCP || 'not set',
              hasConsumerKey: !!process.env.EVERNOTE_CONSUMER_KEY,
              hasConsumerSecret: !!process.env.EVERNOTE_CONSUMER_SECRET,
            },
          };
        }

        // Overall status determination
        if (!healthStatus.status) {
          if (healthStatus.authentication.status === 'authenticated') {
            healthStatus.status = 'healthy';
          } else if (healthStatus.authentication.hasTokenFile || 
                     healthStatus.authentication.hasEnvToken || 
                     healthStatus.authentication.hasOAuthToken) {
            healthStatus.status = 'auth_issue';
          } else {
            healthStatus.status = 'needs_setup';
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(healthStatus, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    // Check if it's an authentication error that we can retry
    const isAuthError = 
      error.message?.includes('Not connected') ||
      error.message?.includes('Authentication required') ||
      error.message?.includes('token') ||
      error.message?.includes('AUTHENTICATION_EXPIRED') ||
      error.errorCode === 9; // Evernote auth expired error code
    
    // If auth error and haven't retried yet, try once with forced reinit
    if (isAuthError && name !== 'evernote_reconnect' && name !== 'evernote_health_check') {
      console.error(`Auth error detected, attempting automatic recovery for ${name}...`);
      try {
        // Force reinitialization
        await ensureAPI(true);
        
        // Verify reconnection succeeded
        console.error(`Verifying reconnection after ${name} failure...`);
        await ensureAPI();
        
        // Execute the same operation again (simplified - real implementation would need to rerun the switch)
        // For now, just inform user to retry
        return {
          content: [
            {
              type: 'text',
              text: `⚠️ Connection was lost but has been restored.\n\n` +
                    `Original error: ${error.message}\n\n` +
                    `Please retry your operation.`,
            },
          ],
        };
      } catch (retryError: any) {
        console.error(`Auto-recovery failed: ${retryError.message}`);
        // Continue with normal error handling below
      }
    }
    
    // Enhanced error logging with debug information
    const errorInfo = {
      tool: name,
      arguments: args,
      timestamp: new Date().toISOString(),
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
        // Include Evernote-specific error details if available
        ...(error.errorCode && { errorCode: error.errorCode }),
        ...(error.parameter && { parameter: error.parameter }),
        ...(error.rateLimitDuration && { rateLimitDuration: error.rateLimitDuration }),
      },
      environment: {
        apiInitialized: !!api,
        apiInitError,
        environment: ENVIRONMENT,
        hasTokens: !!(process.env.EVERNOTE_ACCESS_TOKEN || process.env.OAUTH_TOKEN),
      }
    };
    
    console.error('=== MCP Tool Execution Failed ===');
    console.error(JSON.stringify(errorInfo, null, 2));
    console.error('================================');

    // Return detailed error information instead of throwing
    return {
      content: [
        {
          type: 'text',
          text: `❌ Tool execution failed: ${name}\n\n` +
                `Error: ${error.message}\n\n` +
                `Arguments: ${JSON.stringify(args, null, 2)}\n\n` +
                `Timestamp: ${errorInfo.timestamp}\n\n` +
                `Debug Info:\n${JSON.stringify(errorInfo, null, 2)}`,
        },
      ],
      isError: true,
    };
  }
});

// Handle unhandled rejections to prevent server crash
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('=== Unhandled Rejection ===');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  console.error('=========================');
  
  // If it's an authentication error, reset API state
  if (reason?.message?.includes('Authentication') || 
      reason?.message?.includes('token') ||
      reason?.message?.includes('AUTHENTICATION_EXPIRED')) {
    console.error('Detected authentication error in unhandled rejection, resetting API state');
    api = null;
    apiInitError = null;
    lastInitAttempt = 0;
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  console.error('=== Uncaught Exception ===');
  console.error('Error:', error);
  console.error('Stack:', error.stack);
  console.error('========================');
  
  // Don't exit the process - try to recover
  if (error.message?.includes('Authentication') || 
      error.message?.includes('token') ||
      error.message?.includes('AUTHENTICATION_EXPIRED')) {
    console.error('Detected authentication error in uncaught exception, resetting API state');
    api = null;
    apiInitError = null;
    lastInitAttempt = 0;
  }
});

// Start server
async function main() {
  console.error('Starting Evernote MCP server...');
  console.error(`Environment: ${ENVIRONMENT}`);
  console.error(`Polling: ${POLLING_ENABLED ? 'enabled' : 'disabled'} (interval: ${POLL_INTERVAL / 60000} min)`);
  if (WEBHOOK_URL) {
    console.error(`Webhook URL: ${WEBHOOK_URL}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Evernote MCP server running on stdio');
  
  // Auto-start polling if enabled
  if (POLLING_ENABLED) {
    console.error('Auto-starting polling...');
    // Delay polling start to allow server to fully initialize
    setTimeout(() => {
      startPolling();
    }, 5000);
  }
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
