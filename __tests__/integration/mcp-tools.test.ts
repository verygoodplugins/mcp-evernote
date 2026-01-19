import { jest, describe, beforeEach, afterEach, it, expect } from '@jest/globals';
import {
  mockNoteStore,
  mockUserStore,
  resetMocks,
  sampleNote,
  sampleNotebook,
  sampleTag,
  sampleUser,
  sampleResource,
  sampleResourceWithoutData,
  sampleNoteWithResources,
  sampleRecognitionXml,
  sampleRecognitionXmlBuffer,
  emptyRecognitionXml,
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
import {
  mockMCPSDK,
  getCapturedHandlers,
  resetMCPMocks
} from '../mocks/mcp-server.mock';

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

describe('MCP Tools Integration', () => {
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

    // Import the server module to trigger setup
    await import('../../src/index');
    
    const handlers = getCapturedHandlers();
    listToolsHandler = handlers.listTools;
    callToolHandler = handlers.callTool;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Tool Discovery', () => {
    it('should list all available tools', async () => {
      expect(listToolsHandler).toBeDefined();
      
      const result = await listToolsHandler();
      
      expect(result).toHaveProperty('tools');
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools).toHaveLength(11);
      
      const toolNames = result.tools.map((tool: any) => tool.name);
      expect(toolNames).toContain('evernote_create_note');
      expect(toolNames).toContain('evernote_search_notes');
      expect(toolNames).toContain('evernote_get_note');
      expect(toolNames).toContain('evernote_update_note');
      expect(toolNames).toContain('evernote_delete_note');
      expect(toolNames).toContain('evernote_list_notebooks');
      expect(toolNames).toContain('evernote_create_notebook');
      expect(toolNames).toContain('evernote_list_tags');
      expect(toolNames).toContain('evernote_create_tag');
      expect(toolNames).toContain('evernote_get_user_info');
      expect(toolNames).toContain('evernote_health_check');
    });

    it('should include proper tool schemas', async () => {
      const result = await listToolsHandler();
      
      const createNoteTool = result.tools.find((tool: any) => tool.name === 'evernote_create_note');
      expect(createNoteTool).toBeDefined();
      expect(createNoteTool.description).toContain('Create a new note');
      expect(createNoteTool.inputSchema.properties).toHaveProperty('title');
      expect(createNoteTool.inputSchema.properties).toHaveProperty('content');
      expect(createNoteTool.inputSchema.required).toContain('title');
      expect(createNoteTool.inputSchema.required).toContain('content');
    });
  });

  describe('Note Operations', () => {
    beforeEach(() => {
      mockNoteStore.createNote.mockResolvedValue(sampleNote);
      mockNoteStore.getNote.mockResolvedValue(sampleNote);
      mockNoteStore.updateNote.mockResolvedValue({ ...sampleNote, title: 'Updated Note' });
      mockNoteStore.deleteNote.mockResolvedValue(undefined);
      mockNoteStore.listNotebooks.mockResolvedValue([sampleNotebook]);
    });

    it('should create a note successfully', async () => {
      const request = {
        params: {
          name: 'evernote_create_note',
          arguments: {
            title: 'Test Note',
            content: 'This is a test note with **markdown**.',
            tags: ['test', 'integration']
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.createNote).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Note created successfully');
      expect(result.content[0].text).toContain(sampleNote.guid);
    });

    it('should create a note with notebook name', async () => {
      const request = {
        params: {
          name: 'evernote_create_note',
          arguments: {
            title: 'Test Note in Notebook',
            content: 'Content',
            notebookName: 'Test Notebook'
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.listNotebooks).toHaveBeenCalledTimes(1);
      expect(mockNoteStore.createNote).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('Note created successfully');
    });

    it('should handle notebook not found error', async () => {
      const request = {
        params: {
          name: 'evernote_create_note',
          arguments: {
            title: 'Test Note',
            content: 'Content',
            notebookName: 'Nonexistent Notebook'
          }
        }
      };

      await expect(callToolHandler(request)).rejects.toThrow('Notebook \'Nonexistent Notebook\' not found');
    });

    it('should get a note successfully', async () => {
      const request = {
        params: {
          name: 'evernote_get_note',
          arguments: {
            guid: 'note-123',
            includeContent: true
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.getNote).toHaveBeenCalledWith('note-123', true, true, false, false);
      expect(result.content[0].type).toBe('text');
      
      const noteData = JSON.parse(result.content[0].text);
      expect(noteData).toHaveProperty('guid', sampleNote.guid);
      expect(noteData).toHaveProperty('title', sampleNote.title);
    });

    it('should update a note successfully', async () => {
      const request = {
        params: {
          name: 'evernote_update_note',
          arguments: {
            guid: 'note-123',
            title: 'Updated Title',
            content: 'Updated content'
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.getNote).toHaveBeenCalledTimes(1);
      expect(mockNoteStore.updateNote).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('Note updated successfully');
    });

    it('should delete a note successfully', async () => {
      const request = {
        params: {
          name: 'evernote_delete_note',
          arguments: {
            guid: 'note-123'
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.deleteNote).toHaveBeenCalledWith('note-123');
      expect(result.content[0].text).toContain('Note note-123 deleted successfully');
    });

    it('should search notes successfully', async () => {
      const searchResult = {
        totalNotes: 1,
        notes: [sampleNote]
      };
      mockNoteStore.findNotesMetadata.mockResolvedValue(searchResult);

      const request = {
        params: {
          name: 'evernote_search_notes',
          arguments: {
            query: 'test query',
            maxResults: 10
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.findNotesMetadata).toHaveBeenCalledTimes(1);
      expect(result.content[0].type).toBe('text');
      
      const searchData = JSON.parse(result.content[0].text);
      expect(searchData).toHaveProperty('totalNotes', 1);
      expect(searchData.notes).toHaveLength(1);
    });
  });

  describe('Notebook Operations', () => {
    beforeEach(() => {
      mockNoteStore.listNotebooks.mockResolvedValue([sampleNotebook]);
      mockNoteStore.createNotebook.mockResolvedValue(sampleNotebook);
    });

    it('should list notebooks successfully', async () => {
      const request = {
        params: {
          name: 'evernote_list_notebooks',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.listNotebooks).toHaveBeenCalledTimes(1);
      expect(result.content[0].type).toBe('text');
      
      const notebooks = JSON.parse(result.content[0].text);
      expect(Array.isArray(notebooks)).toBe(true);
      expect(notebooks).toHaveLength(1);
      expect(notebooks[0]).toHaveProperty('name', sampleNotebook.name);
    });

    it('should create a notebook successfully', async () => {
      const request = {
        params: {
          name: 'evernote_create_notebook',
          arguments: {
            name: 'New Notebook',
            stack: 'Test Stack'
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.createNotebook).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('Notebook created successfully');
      expect(result.content[0].text).toContain(sampleNotebook.name);
    });
  });

  describe('Tag Operations', () => {
    beforeEach(() => {
      mockNoteStore.listTags.mockResolvedValue([sampleTag]);
      mockNoteStore.createTag.mockResolvedValue(sampleTag);
    });

    it('should list tags successfully', async () => {
      const request = {
        params: {
          name: 'evernote_list_tags',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.listTags).toHaveBeenCalledTimes(1);
      expect(result.content[0].type).toBe('text');
      
      const tags = JSON.parse(result.content[0].text);
      expect(Array.isArray(tags)).toBe(true);
      expect(tags).toHaveLength(1);
      expect(tags[0]).toHaveProperty('name', sampleTag.name);
    });

    it('should create a tag successfully', async () => {
      const request = {
        params: {
          name: 'evernote_create_tag',
          arguments: {
            name: 'New Tag'
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.createTag).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('Tag created successfully');
      expect(result.content[0].text).toContain(sampleTag.name);
    });

    it('should create a tag with parent', async () => {
      const parentTag = { ...sampleTag, name: 'Parent Tag' };
      mockNoteStore.listTags.mockResolvedValue([parentTag]);

      const request = {
        params: {
          name: 'evernote_create_tag',
          arguments: {
            name: 'Child Tag',
            parentTagName: 'Parent Tag'
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.listTags).toHaveBeenCalledTimes(1);
      expect(mockNoteStore.createTag).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('Tag created successfully');
    });
  });

  describe('User Operations', () => {
    beforeEach(() => {
      mockUserStore.getUser.mockResolvedValue(sampleUser);
    });

    it('should get user info successfully', async () => {
      const request = {
        params: {
          name: 'evernote_get_user_info',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);

      expect(mockUserStore.getUser).toHaveBeenCalledTimes(2); // Called twice for user and quota
      expect(result.content[0].type).toBe('text');
      
      const userInfo = JSON.parse(result.content[0].text);
      expect(userInfo).toHaveProperty('user');
      expect(userInfo).toHaveProperty('quota');
      expect(userInfo.user).toHaveProperty('username', sampleUser.username);
    });
  });

  describe('Authentication Operations', () => {
    it('should revoke authentication successfully', async () => {
      mockFs.unlink.mockResolvedValue(undefined);

      const request = {
        params: {
          name: 'evernote_revoke_auth',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);

      expect(result.content[0].text).toContain('Authentication token revoked');
    });
  });

  describe('Resource Operations', () => {
    describe('evernote_get_resource', () => {
      it('should get resource with binary data', async () => {
        mockNoteStore.getResource.mockResolvedValue(sampleResource);

        const request = {
          params: {
            name: 'evernote_get_resource',
            arguments: {
              guid: 'resource-guid-123',
              includeData: true
            }
          }
        };

        const result = await callToolHandler(request);

        expect(mockNoteStore.getResource).toHaveBeenCalledWith('resource-guid-123', true, false, false, false);
        expect(result.content[0].type).toBe('text');

        const resourceData = JSON.parse(result.content[0].text);
        expect(resourceData).toHaveProperty('guid', 'resource-guid-123');
        expect(resourceData).toHaveProperty('filename', 'test-image.png');
        expect(resourceData).toHaveProperty('mimeType', 'image/png');
        expect(resourceData).toHaveProperty('data'); // base64 encoded
      });

      it('should get resource without binary data', async () => {
        mockNoteStore.getResource.mockResolvedValue(sampleResourceWithoutData);

        const request = {
          params: {
            name: 'evernote_get_resource',
            arguments: {
              guid: 'resource-guid-123',
              includeData: false
            }
          }
        };

        const result = await callToolHandler(request);

        expect(mockNoteStore.getResource).toHaveBeenCalledWith('resource-guid-123', false, false, false, false);

        const resourceData = JSON.parse(result.content[0].text);
        expect(resourceData).toHaveProperty('guid', 'resource-guid-123');
        expect(resourceData).not.toHaveProperty('data');
      });

      it('should handle resource not found error', async () => {
        mockNoteStore.getResource.mockRejectedValue(new Error('Resource not found'));

        const request = {
          params: {
            name: 'evernote_get_resource',
            arguments: {
              guid: 'nonexistent-guid'
            }
          }
        };

        await expect(callToolHandler(request)).rejects.toThrow('Resource not found');
      });
    });

    describe('evernote_list_note_resources', () => {
      it('should list resources for a note with attachments', async () => {
        mockNoteStore.getNote.mockResolvedValue(sampleNoteWithResources);

        const request = {
          params: {
            name: 'evernote_list_note_resources',
            arguments: {
              noteGuid: 'note-guid-123'
            }
          }
        };

        const result = await callToolHandler(request);

        expect(mockNoteStore.getNote).toHaveBeenCalledWith('note-guid-123', false, true, false, false);
        expect(result.content[0].type).toBe('text');

        const resources = JSON.parse(result.content[0].text);
        expect(Array.isArray(resources)).toBe(true);
        expect(resources).toHaveLength(2);
        expect(resources[0]).toHaveProperty('guid', 'resource-guid-123');
        expect(resources[0]).toHaveProperty('filename', 'test-image.png');
        expect(resources[0]).toHaveProperty('mimeType', 'image/png');
        expect(resources[0]).toHaveProperty('hasRecognition', false);
        expect(resources[1]).toHaveProperty('guid', 'resource-guid-456');
        expect(resources[1]).toHaveProperty('hasRecognition', true);
      });

      it('should return empty array for note without resources', async () => {
        mockNoteStore.getNote.mockResolvedValue({ ...sampleNote, resources: [] });

        const request = {
          params: {
            name: 'evernote_list_note_resources',
            arguments: {
              noteGuid: 'note-guid-456'
            }
          }
        };

        const result = await callToolHandler(request);

        const resources = JSON.parse(result.content[0].text);
        expect(Array.isArray(resources)).toBe(true);
        expect(resources).toHaveLength(0);
      });

      it('should handle note not found error', async () => {
        mockNoteStore.getNote.mockRejectedValue(new Error('Note not found'));

        const request = {
          params: {
            name: 'evernote_list_note_resources',
            arguments: {
              noteGuid: 'nonexistent-note'
            }
          }
        };

        await expect(callToolHandler(request)).rejects.toThrow('Note not found');
      });
    });

    describe('evernote_add_resource_to_note', () => {
      beforeEach(() => {
        // Mock file read
        mockFs.readFile.mockImplementation((path: string) => {
          if (path === '/path/to/image.png') {
            return Promise.resolve(Buffer.from('fake-image-data'));
          }
          if (path.includes('.evernote-token.json')) {
            return Promise.resolve(JSON.stringify(sampleTokens));
          }
          return Promise.reject(new Error('File not found'));
        });
        mockNoteStore.getNote.mockResolvedValue({
          ...sampleNote,
          resources: []
        });
        mockNoteStore.updateNote.mockResolvedValue({
          ...sampleNote,
          resources: [sampleResource]
        });
      });

      it('should add resource to note successfully', async () => {
        const request = {
          params: {
            name: 'evernote_add_resource_to_note',
            arguments: {
              noteGuid: 'note-guid-123',
              filePath: '/path/to/image.png'
            }
          }
        };

        const result = await callToolHandler(request);

        expect(mockNoteStore.getNote).toHaveBeenCalledWith('note-guid-123', true, true, false, false);
        expect(mockNoteStore.updateNote).toHaveBeenCalled();
        expect(result.content[0].text).toContain('Resource added successfully');
        expect(result.content[0].text).toContain('note-guid-123');
      });

      it('should add resource with custom filename', async () => {
        const request = {
          params: {
            name: 'evernote_add_resource_to_note',
            arguments: {
              noteGuid: 'note-guid-123',
              filePath: '/path/to/image.png',
              filename: 'custom-name.png'
            }
          }
        };

        const result = await callToolHandler(request);

        expect(result.content[0].text).toContain('Resource added successfully');
      });

      it('should handle file not found error', async () => {
        const request = {
          params: {
            name: 'evernote_add_resource_to_note',
            arguments: {
              noteGuid: 'note-guid-123',
              filePath: '/path/to/nonexistent.png'
            }
          }
        };

        await expect(callToolHandler(request)).rejects.toThrow('File not found');
      });

      it('should handle invalid note error', async () => {
        mockNoteStore.getNote.mockRejectedValue(new Error('Note not found'));

        const request = {
          params: {
            name: 'evernote_add_resource_to_note',
            arguments: {
              noteGuid: 'invalid-note-guid',
              filePath: '/path/to/image.png'
            }
          }
        };

        await expect(callToolHandler(request)).rejects.toThrow('Note not found');
      });
    });

    describe('evernote_get_resource_recognition', () => {
      it('should get OCR recognition data successfully', async () => {
        mockNoteStore.getResourceRecognition.mockResolvedValue(sampleRecognitionXml);

        const request = {
          params: {
            name: 'evernote_get_resource_recognition',
            arguments: {
              resourceGuid: 'resource-guid-123'
            }
          }
        };

        const result = await callToolHandler(request);

        expect(mockNoteStore.getResourceRecognition).toHaveBeenCalledWith('resource-guid-123');
        expect(result.content[0].type).toBe('text');

        const recognitionData = JSON.parse(result.content[0].text);
        expect(recognitionData).toHaveProperty('resourceGuid', 'resource-guid-123');
        expect(recognitionData).toHaveProperty('items');
        expect(Array.isArray(recognitionData.items)).toBe(true);
        expect(recognitionData.items.length).toBeGreaterThan(0);
        expect(recognitionData).toHaveProperty('extractedText');
        expect(recognitionData.extractedText).toContain('Hello');
        expect(recognitionData.extractedText).toContain('World');
      });

      it('should handle recognition data as Buffer', async () => {
        mockNoteStore.getResourceRecognition.mockResolvedValue(sampleRecognitionXmlBuffer);

        const request = {
          params: {
            name: 'evernote_get_resource_recognition',
            arguments: {
              resourceGuid: 'resource-guid-123'
            }
          }
        };

        const result = await callToolHandler(request);

        const recognitionData = JSON.parse(result.content[0].text);
        expect(recognitionData).toHaveProperty('items');
        expect(recognitionData.items.length).toBeGreaterThan(0);
      });

      it('should handle empty recognition data', async () => {
        mockNoteStore.getResourceRecognition.mockResolvedValue(emptyRecognitionXml);

        const request = {
          params: {
            name: 'evernote_get_resource_recognition',
            arguments: {
              resourceGuid: 'resource-guid-123'
            }
          }
        };

        const result = await callToolHandler(request);

        const recognitionData = JSON.parse(result.content[0].text);
        expect(recognitionData).toHaveProperty('items');
        expect(recognitionData.items).toHaveLength(0);
        expect(recognitionData.extractedText).toBe('(no text recognized)');
      });

      it('should handle null recognition data', async () => {
        mockNoteStore.getResourceRecognition.mockResolvedValue(null);

        const request = {
          params: {
            name: 'evernote_get_resource_recognition',
            arguments: {
              resourceGuid: 'resource-guid-123'
            }
          }
        };

        const result = await callToolHandler(request);

        const recognitionData = JSON.parse(result.content[0].text);
        expect(recognitionData).toHaveProperty('items');
        expect(recognitionData.items).toHaveLength(0);
      });

      it('should handle resource not found error', async () => {
        mockNoteStore.getResourceRecognition.mockRejectedValue(new Error('Resource not found'));

        const request = {
          params: {
            name: 'evernote_get_resource_recognition',
            arguments: {
              resourceGuid: 'nonexistent-resource'
            }
          }
        };

        await expect(callToolHandler(request)).rejects.toThrow('Resource not found');
      });
    });
  });

  describe('Health Check', () => {
    it('should perform basic health check', async () => {
      mockUserStore.getUser.mockResolvedValue(sampleUser);

      const request = {
        params: {
          name: 'evernote_health_check',
          arguments: {}
        }
      };

      const result = await callToolHandler(request);

      expect(result.content[0].type).toBe('text');
      
      const healthStatus = JSON.parse(result.content[0].text);
      expect(healthStatus).toHaveProperty('server');
      expect(healthStatus).toHaveProperty('configuration');
      expect(healthStatus).toHaveProperty('authentication');
      expect(healthStatus.server.name).toBe('mcp-evernote');
    });

    it('should perform verbose health check', async () => {
      mockUserStore.getUser.mockResolvedValue(sampleUser);

      const request = {
        params: {
          name: 'evernote_health_check',
          arguments: {
            verbose: true
          }
        }
      };

      const result = await callToolHandler(request);

      const healthStatus = JSON.parse(result.content[0].text);
      expect(healthStatus).toHaveProperty('diagnostics');
      expect(healthStatus.diagnostics).toHaveProperty('cwd');
      expect(healthStatus.diagnostics).toHaveProperty('nodeVersion');
    });
  });

  describe('Patch Note Operations', () => {
    const sampleNoteWithContent = {
      ...sampleNote,
      content: '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>Status: Pending<br/>Task: TODO: Review code<br/>Priority: High</en-note>'
    };

    beforeEach(() => {
      mockNoteStore.getNote.mockResolvedValue(sampleNoteWithContent);
      mockNoteStore.updateNote.mockImplementation((note: any) => Promise.resolve(note));
    });

    it('should patch note with single replacement', async () => {
      const request = {
        params: {
          name: 'evernote_patch_note',
          arguments: {
            guid: 'note-123',
            replacements: [
              { find: 'Status: Pending', replace: 'Status: Complete' }
            ]
          }
        }
      };

      const result = await callToolHandler(request);

      expect(mockNoteStore.getNote).toHaveBeenCalledWith('note-123', true, true, false, false);
      expect(mockNoteStore.updateNote).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Note patched successfully');
      expect(result.content[0].text).toContain('found 1x');
      expect(result.content[0].text).toContain('replaced 1x');
    });

    it('should patch note with multiple replacements', async () => {
      const request = {
        params: {
          name: 'evernote_patch_note',
          arguments: {
            guid: 'note-123',
            replacements: [
              { find: 'Status: Pending', replace: 'Status: Complete' },
              { find: 'TODO:', replace: 'DONE:' }
            ]
          }
        }
      };

      const result = await callToolHandler(request);

      expect(result.content[0].text).toContain('Note patched successfully');
    });

    it('should return warning when no matches found', async () => {
      const request = {
        params: {
          name: 'evernote_patch_note',
          arguments: {
            guid: 'note-123',
            replacements: [
              { find: 'Nonexistent text', replace: 'Replacement' }
            ]
          }
        }
      };

      const result = await callToolHandler(request);

      expect(result.content[0].text).toContain('Note patch failed');
      expect(result.content[0].text).toContain('No matches found');
      expect(mockNoteStore.updateNote).not.toHaveBeenCalled();
    });

    it('should replace only first occurrence when replaceAll is false', async () => {
      const noteWithDuplicates = {
        ...sampleNote,
        content: '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>TODO: First task<br/>TODO: Second task</en-note>'
      };
      mockNoteStore.getNote.mockResolvedValue(noteWithDuplicates);

      const request = {
        params: {
          name: 'evernote_patch_note',
          arguments: {
            guid: 'note-123',
            replacements: [
              { find: 'TODO:', replace: 'DONE:', replaceAll: false }
            ]
          }
        }
      };

      const result = await callToolHandler(request);

      expect(result.content[0].text).toContain('found 2x');
      expect(result.content[0].text).toContain('replaced 1x');
    });

    it('should reject patch that would result in empty content', async () => {
      const noteWithMinimalContent = {
        ...sampleNote,
        content: '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>Only content</en-note>'
      };
      mockNoteStore.getNote.mockResolvedValue(noteWithMinimalContent);

      const request = {
        params: {
          name: 'evernote_patch_note',
          arguments: {
            guid: 'note-123',
            replacements: [
              { find: 'Only content', replace: '' }
            ]
          }
        }
      };

      const result = await callToolHandler(request);

      expect(result.content[0].text).toContain('Note patch failed');
      expect(result.content[0].text).toContain('empty note content');
      expect(mockNoteStore.updateNote).not.toHaveBeenCalled();
    });

    it('should throw error when no replacements provided', async () => {
      const request = {
        params: {
          name: 'evernote_patch_note',
          arguments: {
            guid: 'note-123',
            replacements: []
          }
        }
      };

      await expect(callToolHandler(request)).rejects.toThrow('At least one replacement must be provided');
    });

    it('should handle note not found error', async () => {
      mockNoteStore.getNote.mockRejectedValue(new Error('Note not found'));

      const request = {
        params: {
          name: 'evernote_patch_note',
          arguments: {
            guid: 'nonexistent-guid',
            replacements: [
              { find: 'test', replace: 'replacement' }
            ]
          }
        }
      };

      await expect(callToolHandler(request)).rejects.toThrow('Note not found');
    });
  });

  describe('Error Handling', () => {
    it('should handle unknown tool error', async () => {
      const request = {
        params: {
          name: 'unknown_tool',
          arguments: {}
        }
      };

      await expect(callToolHandler(request)).rejects.toThrow('Unknown tool: unknown_tool');
    });

    it('should handle API errors gracefully', async () => {
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
  });
});
