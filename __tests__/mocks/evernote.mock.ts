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
  // Resource operations
  getResource: jest.fn() as jest.MockedFunction<any>,
  getResourceRecognition: jest.fn() as jest.MockedFunction<any>,
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

// Sample resource data for testing
export const sampleResourceHash = Buffer.from('abc123def456', 'hex');

export const sampleResource = {
  guid: 'resource-guid-123',
  noteGuid: 'note-guid-123',
  mime: 'image/png',
  width: 800,
  height: 600,
  duration: 0,
  active: true,
  recognition: null,
  attributes: {
    fileName: 'test-image.png',
    sourceURL: 'https://example.com/image.png',
    timestamp: Date.now(),
    latitude: null,
    longitude: null,
    altitude: null,
    cameraMake: null,
    cameraModel: null,
    recoType: 'unknown',
  },
  data: {
    body: Buffer.from('fake-image-binary-data'),
    size: 21,
    bodyHash: sampleResourceHash,
  },
};

export const sampleResourceWithoutData = {
  ...sampleResource,
  data: {
    size: 21,
    bodyHash: sampleResourceHash,
    body: null,
  },
};

export const sampleNoteWithResources = {
  ...sampleNote,
  resources: [
    sampleResource,
    {
      guid: 'resource-guid-456',
      noteGuid: 'note-guid-123',
      mime: 'application/pdf',
      attributes: {
        fileName: 'document.pdf',
      },
      data: {
        size: 1024,
        bodyHash: Buffer.from('def789abc123', 'hex'),
      },
      recognition: Buffer.from('<recoIndex>has recognition</recoIndex>'),
    },
  ],
};

// Sample OCR recognition XML data (Evernote's recoIndex format)
export const sampleRecognitionXml = `<?xml version="1.0" encoding="UTF-8"?>
<recoIndex docType="unknown" objType="image" objID="resource-guid-123" engineVersion="5.5.10.4" recoType="service" langType="en" objWidth="800" objHeight="600">
  <item x="50" y="100" w="200" h="30">
    <t w="95">Hello</t>
    <t w="80">Helio</t>
    <t w="65">Helo</t>
  </item>
  <item x="50" y="150" w="250" h="30">
    <t w="98">World</t>
    <t w="75">Warld</t>
  </item>
  <item x="50" y="200" w="300" h="30">
    <t w="92">Testing OCR</t>
  </item>
</recoIndex>`;

export const sampleRecognitionXmlBuffer = Buffer.from(sampleRecognitionXml);

// Empty recognition data (no text detected)
export const emptyRecognitionXml = `<?xml version="1.0" encoding="UTF-8"?>
<recoIndex docType="unknown" objType="image" objID="resource-guid-123" engineVersion="5.5.10.4" recoType="service" langType="en" objWidth="800" objHeight="600">
</recoIndex>`;

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
