import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn(),
}));

import { PDFParse } from 'pdf-parse';
import { EvernoteAPI } from '../../src/evernote-api.js';

const MockedPDFParse = PDFParse as unknown as jest.Mock;

/**
 * Build an EvernoteAPI backed by a mock noteStore whose getResource is the
 * supplied jest mock. The constructor only needs client.getNoteStore(url).
 */
function makeApi(getResource: jest.Mock<(...args: any[]) => Promise<any>>) {
  const noteStore = { getResource };
  const client = { getNoteStore: () => noteStore };
  return new EvernoteAPI(client as any, { noteStoreUrl: 'https://example/notestore' } as any);
}

describe('EvernoteAPI.extractPdfTextFromResource', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockedPDFParse.mockImplementation(() => ({
      getText: jest.fn<() => Promise<{ text: string }>>().mockResolvedValue({ text: 'extracted text' }),
    }));
  });

  it('rejects non-PDF resources with a clear message and never parses', async () => {
    const getResource = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ mime: 'image/png', data: { body: Buffer.from('x') } });
    const result = await makeApi(getResource).extractPdfTextFromResource('g1');
    expect(result).toContain('Not a PDF resource');
    expect(result).toContain('image/png');
    expect(MockedPDFParse).not.toHaveBeenCalled();
  });

  it('returns a no-data message when the resource has no body', async () => {
    const getResource = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ mime: 'application/pdf', data: {} });
    const result = await makeApi(getResource).extractPdfTextFromResource('g2');
    expect(result).toBe('[PDF text extraction failed — no data available]');
  });

  it('reuses a prefetched resource body and does not download again', async () => {
    const getResource = jest.fn<(...args: any[]) => Promise<any>>();
    const prefetched = { mime: 'application/pdf', data: { body: Buffer.from('%PDF-1.4') } };
    const result = await makeApi(getResource).extractPdfTextFromResource('g3', prefetched);
    expect(getResource).not.toHaveBeenCalled();
    expect(result).toBe('extracted text');
  });

  it('downloads the resource when no prefetched body is provided', async () => {
    const getResource = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ mime: 'application/pdf', data: { body: Buffer.from('%PDF-1.4') } });
    const result = await makeApi(getResource).extractPdfTextFromResource('g4');
    expect(getResource).toHaveBeenCalledTimes(1);
    expect(getResource).toHaveBeenCalledWith('g4', true, false, false, false);
    expect(result).toBe('extracted text');
  });

  it('returns a generic failure message when the fetch throws', async () => {
    const getResource = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockRejectedValue(new Error('network'));
    const result = await makeApi(getResource).extractPdfTextFromResource('g5');
    expect(result).toBe('[PDF text extraction failed — could not retrieve the attachment]');
  });
});
