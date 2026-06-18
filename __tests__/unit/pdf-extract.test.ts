import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn(),
}));

import { PDFParse } from 'pdf-parse';
import { extractPdfText } from '../../src/pdf-extract.js';

const MockedPDFParse = PDFParse as unknown as jest.Mock;
const FALLBACK = '[PDF text extraction failed — may be a scanned/image-only document]';

describe('extractPdfText', () => {
  let mockGetText: jest.Mock<() => Promise<any>>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetText = jest.fn<() => Promise<any>>();
    MockedPDFParse.mockImplementation(() => ({ getText: mockGetText }));
  });

  it('returns extracted text on success', async () => {
    mockGetText.mockResolvedValue({ text: 'Hello, World!' });
    const result = await extractPdfText(Buffer.from('fake pdf data'));
    expect(result).toBe('Hello, World!');
  });

  it('trims extracted text', async () => {
    mockGetText.mockResolvedValue({ text: '  trimmed content  ' });
    const result = await extractPdfText(Buffer.from('fake pdf data'));
    expect(result).toBe('trimmed content');
  });

  it('returns fallback when text is whitespace only', async () => {
    mockGetText.mockResolvedValue({ text: '   \n\t  ' });
    const result = await extractPdfText(Buffer.from('fake pdf data'));
    expect(result).toBe(FALLBACK);
  });

  it('returns fallback when text is empty string', async () => {
    mockGetText.mockResolvedValue({ text: '' });
    const result = await extractPdfText(Buffer.from('fake pdf data'));
    expect(result).toBe(FALLBACK);
  });

  it('returns fallback when text is null', async () => {
    mockGetText.mockResolvedValue({ text: null });
    const result = await extractPdfText(Buffer.from('fake pdf data'));
    expect(result).toBe(FALLBACK);
  });

  it('returns fallback when text is undefined', async () => {
    mockGetText.mockResolvedValue({ text: undefined });
    const result = await extractPdfText(Buffer.from('fake pdf data'));
    expect(result).toBe(FALLBACK);
  });

  it('returns fallback on parse error', async () => {
    mockGetText.mockRejectedValue(new Error('Invalid PDF'));
    const result = await extractPdfText(Buffer.from('not a pdf'));
    expect(result).toBe(FALLBACK);
  });

  it('returns fallback on unexpected parse error', async () => {
    mockGetText.mockRejectedValue('string error');
    const result = await extractPdfText(Buffer.from('bad data'));
    expect(result).toBe(FALLBACK);
  });

  it('passes buffer as Uint8Array to PDFParse constructor', async () => {
    mockGetText.mockResolvedValue({ text: 'content' });
    const buf = Buffer.from('pdf content');
    await extractPdfText(buf);
    expect(MockedPDFParse).toHaveBeenCalledWith({ data: expect.any(Uint8Array) });
  });
});
