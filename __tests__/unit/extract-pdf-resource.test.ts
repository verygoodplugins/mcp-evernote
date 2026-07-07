import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn(),
}));

import { PDFParse } from 'pdf-parse';
import { EvernoteAPI } from '../../src/evernote-api.js';
import * as pdfExtract from '../../src/pdf-extract.js';

const MockedPDFParse = PDFParse as unknown as jest.Mock;

/**
 * Build an EvernoteAPI backed by a mock noteStore whose getResource is the
 * supplied jest mock. The constructor only needs client.getNoteStore(url).
 */
function makeApi(
  getResource: jest.Mock<(...args: any[]) => Promise<any>>,
  getResourceRecognition: jest.Mock<(...args: any[]) => Promise<any>> = jest.fn(),
) {
  const noteStore = { getResource, getResourceRecognition };
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

describe('EvernoteAPI.extractResourceText', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockedPDFParse.mockImplementation(() => ({
      getText: jest.fn<() => Promise<{ text: string }>>().mockResolvedValue({ text: 'pdf text' }),
    }));
  });

  it('extracts text from PDF resources using the PDF parser', async () => {
    const getResource = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ mime: 'application/pdf', data: { body: Buffer.from('%PDF-1.4') } });
    const getResourceRecognition = jest.fn<(...args: any[]) => Promise<any>>();

    const result = await makeApi(getResource, getResourceRecognition).extractResourceText('pdf-guid');

    expect(result).toBe('pdf text');
    expect(getResourceRecognition).not.toHaveBeenCalled();
  });

  it('falls back to Evernote recognition text when a PDF has no text layer', async () => {
    MockedPDFParse.mockImplementation(() => ({
      getText: jest.fn<() => Promise<{ text: string }>>().mockResolvedValue({ text: '' }),
    }));
    const getResource = jest.fn<(...args: any[]) => Promise<any>>();
    const prefetched = {
      mime: 'application/pdf',
      data: { body: Buffer.from('%PDF-1.4') },
      recognition: Buffer.from(`
        <recoIndex>
          <item x="1" y="2" w="3" h="4"><t w="97">PDF OCR fallback</t></item>
        </recoIndex>
      `),
    };

    const result = await makeApi(getResource).extractResourceText('pdf-guid', prefetched);

    expect(result).toBe('PDF OCR fallback');
  });

  it('extracts OCR text from image recognition data without downloading the body', async () => {
    const getResource = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ mime: 'image/png' });
    const getResourceRecognition = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(`
      <recoIndex>
        <item x="1" y="2" w="3" h="4"><t w="95">Hello</t></item>
        <item x="5" y="6" w="7" h="8"><t w="92">image OCR</t></item>
      </recoIndex>
    `);

    const result = await makeApi(getResource, getResourceRecognition).extractResourceText('image-guid');

    expect(result).toBe('Hello image OCR');
    expect(getResource).toHaveBeenCalledWith('image-guid', false, false, false, false);
    expect(getResourceRecognition).toHaveBeenCalledWith('image-guid');
    expect(MockedPDFParse).not.toHaveBeenCalled();
  });

  it('falls back to OCR when pdf-parse is unavailable', async () => {
    const unavailableSpy = jest
      .spyOn(pdfExtract, 'extractPdfText')
      .mockResolvedValue(
        '[PDF text extraction unavailable — the pdf-parse module could not be loaded (requires Node >= 20.16)]',
      );
    const getResource = jest.fn<(...args: any[]) => Promise<any>>();
    const prefetched = {
      mime: 'application/pdf',
      data: { body: Buffer.from('%PDF-1.4') },
      recognition: {
        body: Buffer.from(`
          <recoIndex>
            <item x="1" y="2" w="3" h="4"><t w="97">Scanned PDF OCR</t></item>
          </recoIndex>
        `),
      },
    };

    try {
      const result = await makeApi(getResource).extractResourceText('pdf-guid', prefetched);
      expect(result).toBe('Scanned PDF OCR');
    } finally {
      unavailableSpy.mockRestore();
    }
  });

  it('reuses prefetched recognition data and does not download the resource again', async () => {
    const getResource = jest.fn<(...args: any[]) => Promise<any>>();
    const getResourceRecognition = jest.fn<(...args: any[]) => Promise<any>>();
    const prefetched = {
      mime: 'image/jpeg',
      recognition: {
        body: Buffer.from(`
        <recoIndex>
          <item x="1" y="2" w="3" h="4"><t w="99">Prefetched OCR</t></item>
        </recoIndex>
      `),
      },
    };

    const result = await makeApi(getResource, getResourceRecognition).extractResourceText('image-guid', prefetched);

    expect(result).toBe('Prefetched OCR');
    expect(getResource).not.toHaveBeenCalled();
    expect(getResourceRecognition).not.toHaveBeenCalled();
    expect(MockedPDFParse).not.toHaveBeenCalled();
  });
});
