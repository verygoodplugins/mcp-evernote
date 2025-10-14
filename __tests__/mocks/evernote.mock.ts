import { jest } from '@jest/globals';

// Mock Evernote SDK types and classes
export const mockEvernoteClient = {
  getNoteStore: jest.fn() as jest.MockedFunction<any>,
  getUserStore: jest.fn() as jest.MockedFunction<any>,
};

export const mockNoteStore = {
  createNote: jest.fn() as jest.MockedFunction<any>,
  getNote: jest.fn() as jest.MockedFunction<any>,
  updateNote: jest.fn() as jest.MockedFunction<any>,
  deleteNote: jest.fn() as jest.MockedFunction<any>,
  findNotesMetadata: jest.fn() as jest.MockedFunction<any>,
  listNotebooks: jest.fn() as jest.MockedFunction<any>,
  createNotebook: jest.fn() as jest.MockedFunction<any>,
  getNotebook: jest.fn() as jest.MockedFunction<any>,
  updateNotebook: jest.fn() as jest.MockedFunction<any>,
  expungeNotebook: jest.fn() as jest.MockedFunction<any>,
  listTags: jest.fn() as jest.MockedFunction<any>,
  createTag: jest.fn() as jest.MockedFunction<any>,
  getTag: jest.fn() as jest.MockedFunction<any>,
  updateTag: jest.fn() as jest.MockedFunction<any>,
  expungeTag: jest.fn() as jest.MockedFunction<any>,
  getSyncState: jest.fn() as jest.MockedFunction<any>,
  getSyncChunk: jest.fn() as jest.MockedFunction<any>,
};

export const mockUserStore = {
  getUser: jest.fn() as jest.MockedFunction<any>,
};

// Mock Evernote Types
export const mockEvernoteTypes = {
  Note: jest.fn().mockImplementation(() => ({
    title: '',
    content: '',
    notebookGuid: null,
    tagNames: [],
    attributes: null,
    resources: [],
  })),
  Notebook: jest.fn().mockImplementation(() => ({
    name: '',
    stack: null,
    guid: null,
  })),
  Tag: jest.fn().mockImplementation(() => ({
    name: '',
    parentGuid: null,
    guid: null,
  })),
  NoteAttributes: jest.fn().mockImplementation(() => ({})),
  Resource: jest.fn().mockImplementation(() => ({
    data: null,
    mime: '',
    attributes: null,
  })),
  Data: jest.fn().mockImplementation(() => ({
    body: null,
    size: 0,
    bodyHash: null,
  })),
  ResourceAttributes: jest.fn().mockImplementation(() => ({
    fileName: null,
    sourceURL: null,
  })),
};

export const mockEvernoteNoteStore = {
  NoteFilter: jest.fn().mockImplementation(() => ({
    words: '',
    notebookGuid: null,
    tagGuids: [],
    timeZone: null,
    inactive: false,
    emphasized: null,
  })),
  NotesMetadataResultSpec: jest.fn().mockImplementation(() => ({
    includeTitle: false,
    includeContentLength: false,
    includeCreated: false,
    includeUpdated: false,
    includeDeleted: false,
    includeUpdateSequenceNum: false,
    includeNotebookGuid: false,
    includeTagGuids: false,
    includeAttributes: false,
    includeLargestResourceMime: false,
    includeLargestResourceSize: false,
  })),
};

// Mock the entire Evernote module
export const mockEvernote = {
  default: {
    Types: mockEvernoteTypes,
    NoteStore: mockEvernoteNoteStore,
  },
  Types: mockEvernoteTypes,
  NoteStore: mockEvernoteNoteStore,
};

// Configure mock implementations
mockEvernoteClient.getNoteStore.mockReturnValue(mockNoteStore);
mockEvernoteClient.getUserStore.mockReturnValue(mockUserStore);

// Sample test data
export const sampleNote = {
  guid: 'note-guid-123',
  title: 'Test Note',
  content: '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>Test content</en-note>',
  created: Date.now(),
  updated: Date.now(),
  tagNames: ['test-tag'],
  resources: [],
};

export const sampleNotebook = {
  guid: 'notebook-guid-123',
  name: 'Test Notebook',
  updateSequenceNum: 1,
  defaultNotebook: false,
  serviceCreated: Date.now(),
  serviceUpdated: Date.now(),
  stack: null,
  published: false,
};

export const sampleTag = {
  guid: 'tag-guid-123',
  name: 'test-tag',
  parentGuid: null,
  updateSequenceNum: 1,
};

export const sampleUser = {
  id: 123456,
  username: 'testuser',
  email: 'test@example.com',
  name: 'Test User',
  accounting: {
    uploadLimit: 60000000,
    uploadLimitEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
    uploadLimitNextMonth: 60000000,
  },
  premiumInfo: {
    premiumServiceStatus: 'ACTIVE',
    premiumServiceStart: Date.now(),
    premiumExpirationDate: Date.now() + 365 * 24 * 60 * 60 * 1000,
  },
};

// Reset all mocks between tests
export const resetMocks = () => {
  Object.values(mockNoteStore).forEach((mock: any) => {
    if (jest.isMockFunction(mock)) {
      mock.mockClear();
    }
  });
  
  Object.values(mockUserStore).forEach((mock: any) => {
    if (jest.isMockFunction(mock)) {
      mock.mockClear();
    }
  });
  
  mockEvernoteClient.getNoteStore.mockClear();
  mockEvernoteClient.getUserStore.mockClear();
};
