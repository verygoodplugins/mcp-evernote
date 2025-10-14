import { jest } from '@jest/globals';

// Mock MCP SDK components
export const mockServer = {
  setRequestHandler: jest.fn(),
  connect: jest.fn(),
};

export const mockStdioTransport = {
  connect: jest.fn(),
  close: jest.fn(),
};

export const mockServerClass = jest.fn().mockImplementation(() => mockServer);
export const mockStdioServerTransportClass = jest.fn().mockImplementation(() => mockStdioTransport);

// Mock request handlers
export const mockListToolsHandler = jest.fn();
export const mockCallToolHandler = jest.fn();

// Configure server mock to capture handlers
let capturedListToolsHandler: any;
let capturedCallToolHandler: any;

mockServer.setRequestHandler.mockImplementation((schema: any, handler: any) => {
  if (schema.properties && schema.properties.method && schema.properties.method.const === 'tools/list') {
    capturedListToolsHandler = handler;
  } else if (schema.properties && schema.properties.method && schema.properties.method.const === 'tools/call') {
    capturedCallToolHandler = handler;
  }
});

// Helper to get captured handlers
export const getCapturedHandlers = () => ({
  listTools: capturedListToolsHandler,
  callTool: capturedCallToolHandler,
});

// Mock MCP SDK exports
export const mockMCPSDK = {
  Server: mockServerClass,
  StdioServerTransport: mockStdioServerTransportClass,
  ListToolsRequestSchema: {
    type: 'object',
    properties: {
      method: { const: 'tools/list' },
    },
  },
  CallToolRequestSchema: {
    type: 'object',
    properties: {
      method: { const: 'tools/call' },
    },
  },
};

// Reset mocks
export const resetMCPMocks = () => {
  mockServer.setRequestHandler.mockClear();
  mockServer.connect.mockClear();
  mockStdioTransport.connect.mockClear();
  mockStdioTransport.close.mockClear();
  mockServerClass.mockClear();
  mockStdioServerTransportClass.mockClear();
  
  capturedListToolsHandler = undefined;
  capturedCallToolHandler = undefined;
};
