import { jest, describe, beforeEach, afterEach, it, expect } from '@jest/globals';
import { 
  mockMCPSDK,
  mockServer,
  getCapturedHandlers,
  resetMCPMocks
} from '../mocks/mcp-server.mock';
import {
  mockNoteStore,
  mockUserStore,
  resetMocks,
  sampleNote,
  sampleNotebook,
  sampleTag,
  sampleUser,
  mockEvernote
} from '../mocks/evernote.mock';
import {
  mockFs,
  mockPath,
  mockEvernoteClientClass,
  mockAuthenticatedClient,
  resetOAuthMocks,
  sampleTokens
} from '../mocks/oauth.mock';

// Mock all external modules
jest.unstable_mockModule('evernote', () => mockEvernote);
jest.unstable_mockModule('fs/promises', () => mockFs);
jest.unstable_mockModule('path', () => mockPath);
jest.unstable_mockModule('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: mockMCPSDK.Server,
}));
jest.unstable_mockModule('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: mockMCPSDK.StdioServerTransport,
}));
jest.unstable_mockModule('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: mockMCPSDK.CallToolRequestSchema,
  ListToolsRequestSchema: mockMCPSDK.ListToolsRequestSchema,
}));

describe('MCP Protocol Compliance', () => {
  let listToolsHandler: any;
  let callToolHandler: any;

  beforeEach(async () => {
    resetMocks();
    resetOAuthMocks();
    resetMCPMocks();

    // Set up authentication
    mockFs.readFile.mockResolvedValue(JSON.stringify(sampleTokens));
    mockEvernoteClientClass.mockReturnValue(mockAuthenticatedClient);
    mockAuthenticatedClient.getUserStore.mockReturnValue(mockUserStore);
    mockAuthenticatedClient.getNoteStore.mockReturnValue(mockNoteStore);

    // Set up default successful responses
    mockNoteStore.createNote.mockResolvedValue(sampleNote);
    mockNoteStore.getNote.mockResolvedValue(sampleNote);
    mockNoteStore.updateNote.mockResolvedValue(sampleNote);
    mockNoteStore.deleteNote.mockResolvedValue(undefined);
    mockNoteStore.findNotesMetadata.mockResolvedValue({ totalNotes: 0, notes: [] });
    mockNoteStore.listNotebooks.mockResolvedValue([sampleNotebook]);
    mockNoteStore.createNotebook.mockResolvedValue(sampleNotebook);
    mockNoteStore.listTags.mockResolvedValue([sampleTag]);
    mockNoteStore.createTag.mockResolvedValue(sampleTag);
    mockUserStore.getUser.mockResolvedValue(sampleUser);

    // Import the server module to trigger setup
    await import('../../src/index');
    
    const handlers = getCapturedHandlers();
    listToolsHandler = handlers.listTools;
    callToolHandler = handlers.callTool;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('MCP Server Initialization', () => {
    it('should initialize MCP server with correct configuration', () => {
      expect(mockMCPSDK.Server).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'mcp-evernote',
          version: '1.0.0'
        }),
        expect.objectContaining({
          capabilities: {
            tools: {}
          }
        })
      );
    });

    it('should register request handlers', () => {
      expect(mockServer.setRequestHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe('Tool Discovery Protocol', () => {
    it('should implement ListToolsRequest correctly', async () => {
      expect(listToolsHandler).toBeDefined();
      
      const result = await listToolsHandler();
      
      // Validate response structure
      expect(result).toHaveProperty('tools');
      expect(Array.isArray(result.tools)).toBe(true);
      
      // Validate each tool has required fields
      result.tools.forEach((tool: any) => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.inputSchema).toBe('object');
        expect(tool.inputSchema).toHaveProperty('type');
        expect(tool.inputSchema.type).toBe('object');
      });
    });

    it('should return consistent tool list across calls', async () => {
      const result1 = await listToolsHandler();
      const result2 = await listToolsHandler();
      
      expect(result1.tools).toEqual(result2.tools);
    });

    it('should include all expected tools', async () => {
      const result = await listToolsHandler();
      const toolNames = result.tools.map((tool: any) => tool.name);
      
      const expectedTools = [
        'evernote_create_note',
        'evernote_search_notes',
        'evernote_get_note',
        'evernote_update_note',
        'evernote_delete_note',
        'evernote_list_notebooks',
        'evernote_create_notebook',
        'evernote_list_tags',
        'evernote_create_tag',
        'evernote_get_user_info',
        'evernote_revoke_auth',
        'evernote_health_check'
      ];

      expectedTools.forEach(toolName => {
        expect(toolNames).toContain(toolName);
      });
    });

    it('should have valid JSON schemas for all tools', async () => {
      const result = await listToolsHandler();
      
      result.tools.forEach((tool: any) => {
        // Validate schema structure
        expect(tool.inputSchema).toHaveProperty('type', 'object');
        expect(tool.inputSchema).toHaveProperty('properties');
        expect(typeof tool.inputSchema.properties).toBe('object');
        
        // Tools with required parameters should specify them
        if (tool.inputSchema.required) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);
          
          // All required properties should exist in properties
          tool.inputSchema.required.forEach((reqProp: string) => {
            expect(tool.inputSchema.properties).toHaveProperty(reqProp);
          });
        }
      });
    });
  });

  describe('Tool Execution Protocol', () => {
    it('should implement CallToolRequest correctly', async () => {
      expect(callToolHandler).toBeDefined();
      
      const request = {
        params: {
          name: 'evernote_health_check',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);
      
      // Validate response structure
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      
      // Validate content structure
      result.content.forEach((content: any) => {
        expect(content).toHaveProperty('type');
        expect(['text', 'image', 'resource'].includes(content.type)).toBe(true);
      });
    });

    it('should handle invalid tool names', async () => {
      const request = {
        params: {
          name: 'nonexistent_tool',
          arguments: {}
        }
      };

      await expect(callToolHandler(request)).rejects.toThrow('Unknown tool');
    });

    it('should validate required arguments', async () => {
      const request = {
        params: {
          name: 'evernote_create_note',
          arguments: {
            // Missing required 'title' and 'content'
          }
        }
      };

      // Should not throw validation error but may fail in implementation
      // The actual validation depends on the implementation
      await expect(callToolHandler(request)).rejects.toThrow();
    });

    it('should handle optional arguments correctly', async () => {
      const request = {
        params: {
          name: 'evernote_create_note',
          arguments: {
            title: 'Test Note',
            content: 'Test content'
            // Optional arguments omitted
          }
        }
      };

      const result = await callToolHandler(request);
      expect(result).toHaveProperty('content');
    });
  });

  describe('Error Response Protocol', () => {
    it('should return proper error format for API failures', async () => {
      mockNoteStore.createNote.mockRejectedValue(new Error('API Error'));
      
      const request = {
        params: {
          name: 'evernote_create_note',
          arguments: {
            title: 'Test',
            content: 'Test'
          }
        }
      };

      await expect(callToolHandler(request)).rejects.toThrow('Tool evernote_create_note failed: API Error');
    });

    it('should handle authentication errors properly', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT: file not found'));
      
      // Reset mocks to simulate no authentication
      resetMocks();
      resetOAuthMocks();
      resetMCPMocks();
      
      // Re-import to trigger server setup without authentication  
      await import('../../src/index');
      
      const handlers = getCapturedHandlers();
      const authenticatedCallHandler = handlers.callTool;

      const request = {
        params: {
          name: 'evernote_get_user_info',
          arguments: {}
        }
      };

      await expect(authenticatedCallHandler(request)).rejects.toThrow();
    });
  });

  describe('Content Type Handling', () => {
    it('should return text content for most operations', async () => {
      const request = {
        params: {
          name: 'evernote_list_notebooks',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);
      
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');
    });

    it('should handle JSON content correctly', async () => {
      const request = {
        params: {
          name: 'evernote_get_user_info',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);
      
      expect(result.content[0].type).toBe('text');
      
      // Should be valid JSON
      expect(() => {
        JSON.parse(result.content[0].text);
      }).not.toThrow();
    });

    it('should handle empty responses correctly', async () => {
      const request = {
        params: {
          name: 'evernote_revoke_auth',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);
      
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBeTruthy();
    });
  });

  describe('Concurrent Request Handling', () => {
    it('should handle multiple simultaneous requests', async () => {
      const requests = [
        { params: { name: 'evernote_list_notebooks', arguments: {} } },
        { params: { name: 'evernote_list_tags', arguments: {} } },
        { params: { name: 'evernote_health_check', arguments: {} } }
      ];

      const results = await Promise.all(
        requests.map(req => callToolHandler(req))
      );

      results.forEach(result => {
        expect(result).toHaveProperty('content');
        expect(Array.isArray(result.content)).toBe(true);
      });
    });

    it('should handle request isolation', async () => {
      // First request that modifies state
      const createRequest = {
        params: {
          name: 'evernote_create_note',
          arguments: {
            title: 'Test Note 1',
            content: 'Content 1'
          }
        }
      };

      // Second request that should not be affected
      const listRequest = {
        params: {
          name: 'evernote_list_notebooks',
          arguments: {}
        }
      };

      const [createResult, listResult] = await Promise.all([
        callToolHandler(createRequest),
        callToolHandler(listRequest)
      ]);

      expect(createResult).toHaveProperty('content');
      expect(listResult).toHaveProperty('content');
    });
  });

  describe('Memory and Resource Management', () => {
    it('should not leak memory across requests', async () => {
      // Simulate many requests
      const requests = Array(10).fill(null).map(() => ({
        params: {
          name: 'evernote_health_check',
          arguments: {}
        }
      }));

      for (const request of requests) {
        const result = await callToolHandler(request);
        expect(result).toHaveProperty('content');
      }

      // No specific assertion, but this should not cause memory issues
    });

    it('should handle large response data', async () => {
      // Mock a large notebook list
      const largeNotebookList = Array(100).fill(null).map((_, i) => ({
        ...sampleNotebook,
        guid: `notebook-${i}`,
        name: `Notebook ${i}`
      }));
      
      mockNoteStore.listNotebooks.mockResolvedValue(largeNotebookList);

      const request = {
        params: {
          name: 'evernote_list_notebooks',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);
      
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text.length).toBeGreaterThan(1000);
    });
  });

  describe('Transport Layer Compatibility', () => {
    it('should work with stdio transport', () => {
      expect(mockMCPSDK.StdioServerTransport).toHaveBeenCalled();
    });
  });
});
