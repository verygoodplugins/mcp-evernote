import { jest } from '@jest/globals';

// Mock fs/promises
export const mockFs = {
  readFile: jest.fn() as jest.MockedFunction<any>,
  writeFile: jest.fn() as jest.MockedFunction<any>,
  unlink: jest.fn() as jest.MockedFunction<any>,
};

// Mock path
export const mockPath = {
  join: jest.fn().mockImplementation((...args) => args.join('/')) as jest.MockedFunction<any>,
};

// Mock Evernote Client
export const mockEvernoteClientClass = jest.fn() as jest.MockedFunction<any>;

export const mockAuthenticatedClient = {
  getUserStore: jest.fn() as jest.MockedFunction<any>,
  getNoteStore: jest.fn() as jest.MockedFunction<any>,
};

export const mockUserStore = {
  getNoteStoreUrl: jest.fn() as jest.MockedFunction<any>,
  getUser: jest.fn() as jest.MockedFunction<any>,
};

// Configure the Evernote Client mock
mockEvernoteClientClass.mockImplementation(() => mockAuthenticatedClient);
mockAuthenticatedClient.getUserStore.mockReturnValue(mockUserStore);

// Sample tokens for testing
export const sampleTokens = {
  token: 'S=s123:U=123456:E=abcdef:C=123456789:P=1cd:A=oauth:V=2:H=abcdef',
  tokenSecret: 'token-secret-123',
  noteStoreUrl: 'https://test-notestore.evernote.com/edam/note/test',
  webApiUrlPrefix: 'https://test-webapp.evernote.com',
  userId: 123456,
  expires: Date.now() + 3600000, // 1 hour from now
};

export const expiredTokens = {
  ...sampleTokens,
  expires: Date.now() - 3600000, // 1 hour ago
};

export const tokensWithoutNoteStore = {
  token: sampleTokens.token,
  tokenSecret: sampleTokens.tokenSecret,
  userId: sampleTokens.userId,
  expires: sampleTokens.expires,
  // noteStoreUrl missing
};

// Reset mocks
export const resetOAuthMocks = () => {
  Object.values(mockFs).forEach((mock: any) => {
    if (jest.isMockFunction(mock)) {
      mock.mockClear();
    }
  });
  
  mockPath.join.mockClear();
  mockEvernoteClientClass.mockClear();
  mockAuthenticatedClient.getUserStore.mockClear();
  mockAuthenticatedClient.getNoteStore.mockClear();
  mockUserStore.getNoteStoreUrl.mockClear();
  mockUserStore.getUser.mockClear();
};
