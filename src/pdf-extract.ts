const FALLBACK_TEXT =
  '[PDF text extraction failed — may be a scanned/image-only document]';

/**
 * Extract plain text from a PDF binary buffer.
 *
 * `pdf-parse` is imported lazily (dynamic import) rather than at module load.
 * This keeps an optional, heavyweight dependency off the server's startup path:
 * if pdf-parse is missing or fails to load (e.g. an ESM/CJS export mismatch on
 * a version bump), this function degrades to the fallback string instead of
 * throwing a fatal module-load error that would crash the whole MCP server.
 *
 * Returns the extracted text on success, or a human-readable fallback string
 * when extraction fails (e.g. image-only / password-protected PDFs).
 */
export async function extractPdfText(data: Buffer): Promise<string> {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(data) });
    const result = await parser.getText();
    const text = result.text?.trim();
    if (!text) {
      return FALLBACK_TEXT;
    }
    return text;
  } catch {
    return FALLBACK_TEXT;
  }
}
