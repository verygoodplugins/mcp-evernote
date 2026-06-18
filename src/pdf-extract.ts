const FALLBACK_TEXT =
  '[PDF text extraction failed — may be a scanned/image-only document]';
const MODULE_UNAVAILABLE_TEXT =
  '[PDF text extraction unavailable — the pdf-parse module could not be loaded (requires Node >= 20.16)]';

/**
 * Extract plain text from a PDF binary buffer.
 *
 * `pdf-parse` is imported lazily (dynamic import) rather than at module load.
 * This keeps an optional, heavyweight dependency off the server's startup path:
 * if pdf-parse is missing or fails to load (e.g. an ESM/CJS export mismatch on
 * a version bump, or an unsupported Node version), this function degrades to a
 * fallback string instead of throwing a fatal module-load error that would
 * crash the whole MCP server.
 *
 * Returns the extracted text on success, or a human-readable fallback string:
 * a distinct message when the pdf-parse module itself can't be loaded, and the
 * scanned/image-only message for genuine parse / text-layer failures.
 */
export async function extractPdfText(data: Buffer): Promise<string> {
  let mod: typeof import('pdf-parse');
  try {
    mod = await import('pdf-parse');
  } catch {
    return MODULE_UNAVAILABLE_TEXT;
  }

  try {
    // Zero-copy view over the existing Buffer (which is already a Uint8Array),
    // respecting byteOffset/byteLength so pooled Buffers aren't over-read.
    const parser = new mod.PDFParse({
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    });
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
