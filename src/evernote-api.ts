import * as Evernote from "evernote";
import { createHash } from "crypto";
import {
  markdownToENML,
  enmlToMarkdown,
  MarkdownAttachment,
  MarkdownExistingResource,
} from "./markdown.js";
import {
  NoteContent,
  SearchParameters,
  NotebookInfo,
  Tag,
  OAuthTokens,
  RecognitionData,
  RecognitionItem,
  ResourceInfo,
  NoteReplacement,
  PatchNoteResult,
  NoteFormat,
} from "./types.js";
import { readFile } from "fs/promises";
import { basename, extname } from "path";
import * as cheerio from "cheerio";
import { validateLocalFilePath } from "./path-security.js";
import { extractPdfText } from "./pdf-extract.js";
import {
  limitNoteStoreMethods,
  resolveRpcLimitOptions,
  RpcLimitOptions,
} from "./concurrency.js";
import {
  getEvernoteErrorMeta,
  isAuthErrorCode,
  RATE_LIMIT_ERROR_CODE,
} from "./errors.js";
import { NoteCache, NoteCacheOptions, NoteCacheSyncApi } from "./note-cache.js";

const UPDATE_NOTE_EDIT_LOCK_RETRY_DELAYS_MS = [2000, 4000, 8000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableEditLock(error: any): boolean {
  const { errorCode, rateLimitDuration } = getEvernoteErrorMeta(error);
  return (
    errorCode === RATE_LIMIT_ERROR_CODE &&
    (typeof rateLimitDuration !== "number" ||
      !Number.isFinite(rateLimitDuration) ||
      rateLimitDuration <= 0)
  );
}

/** One note in a batch fetch result (body-focused; no attachment text). */
export interface BatchNoteEntry {
  guid: string;
  title?: string;
  created?: string;
  updated?: string;
  notebookGuid?: string;
  // getNote returns applied tags as GUIDs (tagNames is unset on reads); the
  // handler resolves these to names via the tag cache.
  tagGuids?: string[];
  contentLength?: number;
  content?: string;
}

export interface BatchFetchResult {
  notes: BatchNoteEntry[];
  failed: Array<{ guid: string; message: string; errorCode?: number }>;
  /**
   * Present when the hourly rate limit aborted the batch mid-way. The caller
   * can wait `retryAfterSeconds` and re-request `remainingGuids`.
   */
  aborted?: {
    reason: "rate_limited";
    retryAfterSeconds?: number;
    remainingGuids: string[];
  };
}

/**
 * Truncate plain text to `maxLength` at a word boundary, appending an ellipsis
 * when clipped. Shared by search previews and any preview projection.
 */
export function truncatePlainText(text: string, maxLength = 300): string {
  if (text.length <= maxLength) {
    return text;
  }
  let truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.7) {
    truncated = truncated.substring(0, lastSpace);
  }
  return truncated + "...";
}

export class EvernoteAPI {
  private noteStore: any;
  private client: any;
  private readonly sleep: (ms: number) => Promise<void>;
  // USN-keyed body cache; null when disabled (EVERNOTE_NOTE_CACHE_SIZE=0).
  private readonly noteCache: NoteCache | null;

  constructor(
    client: any,
    tokens: OAuthTokens,
    options?: Partial<RpcLimitOptions> & { noteCache?: NoteCacheOptions },
  ) {
    this.client = client;
    const rpcLimitOptions = resolveRpcLimitOptions(options);
    this.sleep = rpcLimitOptions.sleep ?? defaultSleep;
    // Gate every NoteStore RPC through a shared concurrency limiter with
    // short-wait rate-limit auto-retry (see src/concurrency.ts).
    this.noteStore = limitNoteStoreMethods(
      client.getNoteStore(tokens.noteStoreUrl),
      rpcLimitOptions,
    );
    const cache = new NoteCache(options?.noteCache ?? {});
    this.noteCache = cache.enabled ? cache : null;
  }

  /**
   * Read-through body cache for note reads. Serves an unchanged note from memory
   * (after a TTL-gated sync check evicts anything edited elsewhere) instead of
   * re-spending an hourly-quota `getNote` call. Always fetches WITH content, so
   * callers that don't want a body should call `getNote` directly.
   *
   * On a hit, resource binaries are stripped, so a caller that needs attachment
   * text still extracts it live (extractResourceText re-fetches). On a miss the
   * full note (bodies inline) is returned and a stripped copy is cached.
   */
  async getNoteCached(
    guid: string,
    opts: { withResources?: boolean } = {},
  ): Promise<any> {
    const withResources = opts.withResources ?? false;
    if (!this.noteCache) {
      return this.getNote(guid, true, withResources);
    }
    await this.noteCache.ensureFresh(this as unknown as NoteCacheSyncApi);
    const hit = this.noteCache.get(guid, withResources);
    if (hit !== undefined) {
      return hit;
    }
    const note = await this.getNote(guid, true, withResources);
    this.noteCache.set(guid, note, withResources);
    return note;
  }

  // Note operations
  async createNote(noteContent: NoteContent): Promise<any> {
    const EvernoteModule = (Evernote as any).default || Evernote;
    const note = new EvernoteModule.Types.Note();
    note.title = noteContent.title;

    const conversion = this.convertMarkdownToENML(noteContent.content);
    note.content = this.wrapEnml(conversion.enml);

    if (noteContent.notebookGuid) {
      note.notebookGuid = noteContent.notebookGuid;
    }

    if (noteContent.tagNames && noteContent.tagNames.length > 0) {
      note.tagNames = noteContent.tagNames;
    }

    if (noteContent.attributes) {
      note.attributes = new EvernoteModule.Types.NoteAttributes(
        noteContent.attributes,
      );
    }

    const resources: any[] = [];

    const attachmentResources = this.buildResourcesFromAttachments(
      conversion.attachments,
      EvernoteModule,
    );
    if (attachmentResources.length > 0) {
      resources.push(...attachmentResources);
    }

    const explicitResources = this.buildExplicitResources(
      noteContent.resources,
      EvernoteModule,
    );
    if (explicitResources.length > 0) {
      resources.push(...explicitResources);
    }

    if (resources.length > 0) {
      note.resources = resources;
    }

    return await this.noteStore.createNote(note);
  }

  async getNote(
    guid: string,
    withContent: boolean = true,
    withResources: boolean = false,
  ): Promise<any> {
    return await this.noteStore.getNote(
      guid,
      withContent,
      withResources,
      false,
      false,
    );
  }

  /**
   * Get a truncated plain text preview of a note's content.
   * Fetches the note content and converts ENML to plain text, truncating to maxLength.
   */
  async getNotePreview(
    guid: string,
    maxLength: number = 300,
  ): Promise<string | null> {
    const note = await this.getNoteCached(guid, { withResources: false });
    if (!note.content) {
      return null;
    }

    // Convert ENML to plain text (strip all tags)
    const plainText = this.enmlToPlainText(note.content);
    if (!plainText || plainText.length === 0) {
      return null;
    }

    return truncatePlainText(plainText, maxLength);
  }

  /**
   * Render a note's ENML body into the requested output projection. `markdown`
   * (default) runs the Turndown/GFM conversion; `text` strips to plain text;
   * `enml` returns the raw ENML untouched.
   */
  renderNoteContent(
    enml: string | undefined,
    resources: any,
    format: NoteFormat,
  ): string | undefined {
    if (!enml) {
      return undefined;
    }
    switch (format) {
      case "text":
        return this.enmlToPlainText(enml);
      case "enml":
        return enml;
      case "markdown":
      default:
        return this.convertENMLToMarkdown(enml, resources);
    }
  }

  /**
   * Fetch many notes in one call. Evernote has no batch endpoint, so this is a
   * sequential server-side fan-out of getNote (the shared RPC limiter bounds
   * concurrency across calls). Body-focused: returns note metadata + content in
   * the requested format, NOT attachment/OCR text — use a single `guid` for
   * that. On the hourly rate limit it stops and returns partial results plus an
   * `aborted` marker so the caller can resume the remaining guids.
   */
  async getNotesBatch(
    guids: string[],
    opts: { includeContent: boolean; format: NoteFormat },
  ): Promise<BatchFetchResult> {
    const notes: BatchNoteEntry[] = [];
    const failed: BatchFetchResult["failed"] = [];

    for (let i = 0; i < guids.length; i++) {
      const guid = guids[i];
      try {
        // Route body-bearing fetches through the cache; a metadata-only fetch
        // (includeContent=false) has no body worth caching, so hit the API.
        const note = opts.includeContent
          ? await this.getNoteCached(guid, { withResources: false })
          : await this.getNote(guid, false, false);
        const entry: BatchNoteEntry = {
          guid: note.guid,
          title: note.title,
          created: note.created
            ? new Date(note.created).toISOString()
            : undefined,
          updated: note.updated
            ? new Date(note.updated).toISOString()
            : undefined,
          notebookGuid: note.notebookGuid,
          tagGuids: note.tagGuids,
          contentLength:
            note.contentLength ??
            (typeof note.content === "string" ? note.content.length : undefined),
        };
        if (opts.includeContent && note.content) {
          entry.content = this.renderNoteContent(
            note.content,
            note.resources,
            opts.format,
          );
        }
        notes.push(entry);
      } catch (error: any) {
        const { errorCode, rateLimitDuration } = getEvernoteErrorMeta(error);
        if (isAuthErrorCode(errorCode)) {
          // Auth failure is fatal for the whole batch (every remaining guid
          // would fail identically). Rethrow so the tool's auth-recovery path
          // runs and the client is told to reconnect, rather than burying it
          // in a per-note `failed` entry and returning success.
          throw error;
        }
        if (errorCode === RATE_LIMIT_ERROR_CODE) {
          // Once the hourly quota trips, every subsequent call fails the same
          // way — stop and hand back what we have plus how to resume.
          return {
            notes,
            failed,
            aborted: {
              reason: "rate_limited",
              retryAfterSeconds:
                typeof rateLimitDuration === "number"
                  ? rateLimitDuration
                  : undefined,
              remainingGuids: guids.slice(i),
            },
          };
        }
        failed.push({
          guid,
          message: error?.message ?? String(error),
          errorCode,
        });
      }
    }

    return { notes, failed };
  }

  /**
   * Convert ENML content to plain text by stripping all XML/HTML tags.
   *
   * This implementation uses an HTML parser instead of regular expressions
   * to avoid incomplete multi-character sanitization issues.
   */
  enmlToPlainText(enmlContent: string): string {
    // Parse the ENML/HTML content
    const $ = cheerio.load(enmlContent);

    // Remove en-media tags (attachments) from the DOM
    $("en-media").remove();

    // Extract text content (HTML/XML tags are not included)
    let text = $.text();

    // Normalize whitespace similar to the original implementation
    text = text.replace(/\r\n/g, "\n");
    text = text.replace(/\n\s*\n/g, "\n");
    text = text.replace(/[ \t]+/g, " ");
    text = text.trim();

    return text;
  }

  async updateNote(note: any, retryCount: number = 0): Promise<any> {
    try {
      console.error(`Updating note ${note.guid} (attempt ${retryCount + 1})`);

      const result = await this.noteStore.updateNote(note);
      console.error(`Note update successful for ${note.guid}`);
      // Self-write eviction: our own edit bumps the note USN, so drop the stale
      // body immediately (covers patch_note / add_resource_to_note, which route
      // through updateNote) instead of waiting for the next sync probe.
      this.noteCache?.evict(note.guid);
      return result;
    } catch (error: any) {
      console.error(
        `Note update failed for ${note.guid}: code=${error.errorCode || "none"} attempt=${retryCount + 1}/${UPDATE_NOTE_EDIT_LOCK_RETRY_DELAYS_MS.length + 1}`,
      );

      if (
        retryCount < UPDATE_NOTE_EDIT_LOCK_RETRY_DELAYS_MS.length &&
        isRetryableEditLock(error)
      ) {
        const delay = UPDATE_NOTE_EDIT_LOCK_RETRY_DELAYS_MS[retryCount];
        console.error(`RTE room conflict detected. Retrying in ${delay}ms...`);
        await this.sleep(delay);
        return this.updateNote(note, retryCount + 1);
      }

      // Rate-limit (errorCode 19) retry is handled uniformly at the NoteStore
      // RPC layer (src/concurrency.ts) for short waits; long waits surface as a
      // structured error so the caller can reschedule. Here we only enrich the
      // error with context (no sensitive data like titles).
      const enhancedError = new Error(
        `Failed to update note ${note.guid}: ${error.message}`,
      );
      enhancedError.name = error.name || "EvernoteUpdateError";
      (enhancedError as any).originalError = error;
      (enhancedError as any).noteGuid = note.guid;
      (enhancedError as any).errorCode = error.errorCode;
      (enhancedError as any).rateLimitDuration = error.rateLimitDuration;
      (enhancedError as any).parameter = error.parameter;
      (enhancedError as any).retriesAttempted = retryCount;

      throw enhancedError;
    }
  }

  async deleteNote(guid: string): Promise<void> {
    await this.noteStore.deleteNote(guid);
    this.noteCache?.evict(guid);
  }

  async patchNoteContent(
    guid: string,
    replacements: NoteReplacement[],
  ): Promise<PatchNoteResult> {
    // Validate inputs before performing I/O
    if (!replacements || replacements.length === 0) {
      return {
        success: false,
        noteGuid: guid,
        changes: [],
        warning: "No replacements provided",
      };
    }

    for (const replacement of replacements) {
      if (
        !replacement.find ||
        typeof replacement.find !== "string" ||
        replacement.find.length === 0
      ) {
        return {
          success: false,
          noteGuid: guid,
          changes: [],
          warning: "Empty find string in replacements",
        };
      }
    }

    // Fetch existing note with content and resources
    const note = await this.getNote(guid, true, true);

    // Convert ENML to markdown
    let markdown = this.convertENMLToMarkdown(note.content, note.resources);

    // Track changes
    const changes: PatchNoteResult["changes"] = [];

    // Apply replacements sequentially
    for (const replacement of replacements) {
      const { find, replace, replaceAll = true } = replacement;

      // Count occurrences
      const regex = new RegExp(
        find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "g",
      );
      const matches = markdown.match(regex);
      const occurrences = matches ? matches.length : 0;

      // Perform replacement
      let replaced = 0;
      if (occurrences > 0) {
        if (replaceAll) {
          markdown = markdown.split(find).join(replace);
          replaced = occurrences;
        } else {
          markdown = markdown.replace(find, replace);
          replaced = 1;
        }
      }

      changes.push({
        find,
        occurrences,
        replaced,
      });
    }

    // Check if any changes were made
    const totalReplaced = changes.reduce((sum, c) => sum + c.replaced, 0);
    if (totalReplaced === 0) {
      return {
        success: false,
        noteGuid: guid,
        changes,
        warning: "No matches found for any replacement patterns",
      };
    }

    // Check if content would be empty after replacement
    const trimmedMarkdown = markdown.trim();
    if (!trimmedMarkdown) {
      return {
        success: false,
        noteGuid: guid,
        changes,
        warning:
          "Replacement would result in empty note content - operation aborted",
      };
    }

    // Apply updated markdown back to note, preserving existing resources
    await this.applyMarkdownToNote(note, markdown, { preserveResources: true });

    // Update the note
    await this.updateNote(note);

    return {
      success: true,
      noteGuid: guid,
      changes,
    };
  }

  async searchNotes(params: SearchParameters): Promise<any> {
    // Handle ES module import where Evernote exports are under .default
    const EvernoteModule = (Evernote as any).default || Evernote;
    const filter = new EvernoteModule.NoteStore.NoteFilter();

    if (params.words) filter.words = params.words;
    if (params.notebookGuid) filter.notebookGuid = params.notebookGuid;
    if (params.tagGuids) filter.tagGuids = params.tagGuids;
    if (params.timeZone) filter.timeZone = params.timeZone;
    if (params.inactive !== undefined) filter.inactive = params.inactive;
    if (params.emphasized) filter.emphasized = params.emphasized;

    const spec = new EvernoteModule.NoteStore.NotesMetadataResultSpec();
    spec.includeTitle = true;
    spec.includeContentLength = true;
    spec.includeCreated = true;
    spec.includeUpdated = true;
    spec.includeDeleted = false;
    spec.includeUpdateSequenceNum = true;
    spec.includeNotebookGuid = true;
    spec.includeTagGuids = true;
    spec.includeAttributes = true;
    spec.includeLargestResourceMime = true;
    spec.includeLargestResourceSize = true;

    const offset = params.offset || 0;
    const maxNotes = params.maxNotes || 100;

    return await this.noteStore.findNotesMetadata(
      filter,
      offset,
      maxNotes,
      spec,
    );
  }

  // Notebook operations
  async listNotebooks(): Promise<NotebookInfo[]> {
    const notebooks = await this.noteStore.listNotebooks();
    return notebooks.map((nb: any) => ({
      guid: nb.guid,
      name: nb.name,
      updateSequenceNum: nb.updateSequenceNum,
      defaultNotebook: nb.defaultNotebook,
      serviceCreated: nb.serviceCreated,
      serviceUpdated: nb.serviceUpdated,
      stack: nb.stack,
      published: nb.published,
    }));
  }

  async createNotebook(name: string, stack?: string): Promise<any> {
    const EvernoteModule = (Evernote as any).default || Evernote;
    const notebook = new EvernoteModule.Types.Notebook();
    notebook.name = name;
    if (stack) {
      notebook.stack = stack;
    }
    return await this.noteStore.createNotebook(notebook);
  }

  async getNotebook(guid: string): Promise<any> {
    return await this.noteStore.getNotebook(guid);
  }

  async updateNotebook(notebook: any): Promise<any> {
    return await this.noteStore.updateNotebook(notebook);
  }

  async expungeNotebook(guid: string): Promise<void> {
    await this.noteStore.expungeNotebook(guid);
  }

  // Tag operations
  async listTags(): Promise<Tag[]> {
    const tags = await this.noteStore.listTags();
    return tags.map((tag: any) => ({
      guid: tag.guid,
      name: tag.name,
      parentGuid: tag.parentGuid,
      updateSequenceNum: tag.updateSequenceNum,
    }));
  }

  async createTag(name: string, parentGuid?: string): Promise<any> {
    const EvernoteModule = (Evernote as any).default || Evernote;
    const tag = new EvernoteModule.Types.Tag();
    tag.name = name;
    if (parentGuid) {
      tag.parentGuid = parentGuid;
    }
    return await this.noteStore.createTag(tag);
  }

  async getTag(guid: string): Promise<any> {
    return await this.noteStore.getTag(guid);
  }

  async updateTag(tag: any): Promise<any> {
    return await this.noteStore.updateTag(tag);
  }

  async expungeTag(guid: string): Promise<void> {
    await this.noteStore.expungeTag(guid);
  }

  // Resource operations
  async getResource(guid: string, withData: boolean = true): Promise<any> {
    return await this.noteStore.getResource(
      guid,
      withData,
      false,
      false,
      false,
    );
  }

  async getResourceRecognition(guid: string): Promise<RecognitionData> {
    const recognitionData = await this.noteStore.getResourceRecognition(guid);
    return this.parseRecognitionXml(guid, recognitionData);
  }

  /**
   * Fetch PDF resource binary data and extract its text content.
   *
   * Pass `prefetched` (a resource already returned by getNote with inline data)
   * to reuse its body instead of downloading the binary a second time.
   *
   * Falls back to a human-readable message if the resource is not a PDF, has no
   * text layer (e.g. scanned / image-only PDFs), or if the API call fails.
   */
  async extractPdfTextFromResource(
    resourceGuid: string,
    prefetched?: any,
  ): Promise<string> {
    try {
      const resource =
        prefetched?.data?.body != null
          ? prefetched
          : await this.getResource(resourceGuid, true);
      if (resource?.mime && resource.mime !== "application/pdf") {
        return `[Not a PDF resource (mime: ${resource.mime}) — text extraction only supports PDF attachments]`;
      }
      if (!resource?.data?.body) {
        return "[PDF text extraction failed — no data available]";
      }
      const buffer = Buffer.isBuffer(resource.data.body)
        ? resource.data.body
        : Buffer.from(resource.data.body);
      return await extractPdfText(buffer);
    } catch {
      // Covers resource fetch / API / network failures. Parse failures (incl.
      // scanned/image-only PDFs) are handled inside extractPdfText.
      return "[PDF text extraction failed — could not retrieve the attachment]";
    }
  }

  /**
   * Extract plain text from any resource type this server can read.
   *
   * PDFs use local text-layer extraction via pdf-parse. Other resources use
   * Evernote's recognition XML when available, which covers image OCR.
   */
  async extractResourceText(
    resourceGuid: string,
    prefetched?: any,
  ): Promise<string> {
    let resource: any;
    try {
      if (prefetched != null) {
        resource = prefetched;
      } else {
        // Metadata-only fetch for OCR paths; PDF text extraction needs the body.
        resource = await this.getResource(resourceGuid, false);
        if (resource?.mime === "application/pdf") {
          resource = await this.getResource(resourceGuid, true);
        }
      }
    } catch {
      return "[Resource text extraction failed — could not retrieve the attachment]";
    }

    if (resource?.mime === "application/pdf") {
      const pdfText = await this.extractPdfTextFromResource(
        resourceGuid,
        resource,
      );
      if (!this.isPdfExtractionFallback(pdfText)) {
        return pdfText;
      }

      const recognitionText = await this.extractRecognitionTextFromResource(
        resourceGuid,
        resource,
      );
      return recognitionText || pdfText;
    }

    if (!this.supportsOcrLookup(resource)) {
      const mime = resource?.mime ? ` (mime: ${resource.mime})` : "";
      return `[No text extraction available for resource${mime}]`;
    }

    const recognitionText = await this.extractRecognitionTextFromResource(
      resourceGuid,
      resource,
    );
    if (recognitionText == null) {
      const mime = resource?.mime ? ` (mime: ${resource.mime})` : "";
      return `[No text extraction available for resource${mime}]`;
    }

    return recognitionText || "[No OCR text recognized for resource]";
  }

  async listNoteResources(noteGuid: string): Promise<ResourceInfo[]> {
    const note = await this.noteStore.getNote(
      noteGuid,
      false,
      true,
      false,
      false,
    );

    if (!note.resources || note.resources.length === 0) {
      return [];
    }

    return note.resources.map((r: any) => ({
      guid: r.guid,
      filename: r.attributes?.fileName,
      mimeType: r.mime,
      size: r.data?.size || 0,
      hash: r.data?.bodyHash
        ? Buffer.from(r.data.bodyHash).toString("hex")
        : "",
      hasRecognition: !!r.recognition,
    }));
  }

  async addResourceToNote(
    noteGuid: string,
    filePath: string,
    filename?: string,
  ): Promise<any> {
    const EvernoteModule = (Evernote as any).default || Evernote;

    const resolvedPath = await validateLocalFilePath(filePath);

    // Read file
    const fileData = await readFile(resolvedPath);
    const hash = this.computeHash(fileData);
    const hashHex = hash.toString("hex");

    // Determine MIME type from extension
    const ext = extname(filePath).toLowerCase();
    const mimeType = this.getMimeType(ext);
    const displayName = filename || basename(filePath);

    // Get existing note with content and resources
    const note = await this.noteStore.getNote(
      noteGuid,
      true,
      true,
      false,
      false,
    );

    // Create new resource
    const resource = new EvernoteModule.Types.Resource();
    resource.data = new EvernoteModule.Types.Data();
    resource.data.body = fileData;
    resource.data.size = fileData.length;
    resource.data.bodyHash = hash;
    resource.mime = mimeType;

    const attrs = new EvernoteModule.Types.ResourceAttributes();
    attrs.fileName = displayName;
    resource.attributes = attrs;

    // Add to existing resources
    if (!note.resources) {
      note.resources = [];
    }
    note.resources.push(resource);

    // Append en-media tag to content before </en-note>
    const enMediaTag = `<en-media type="${mimeType}" hash="${hashHex}"/>`;
    note.content = note.content.replace(
      "</en-note>",
      `<br/>${enMediaTag}</en-note>`,
    );

    // Update note
    return await this.updateNote(note);
  }

  private parseRecognitionXml(
    resourceGuid: string,
    xmlData: any,
  ): RecognitionData {
    const items: RecognitionItem[] = [];

    if (!xmlData) {
      return { resourceGuid, items };
    }

    // Convert to string if it's a buffer
    const xmlString =
      typeof xmlData === "string"
        ? xmlData
        : Buffer.from(xmlData).toString("utf-8");

    // Parse <item> elements with bounding box attributes
    const itemRegex =
      /<item\s+x="(\d+)"\s+y="(\d+)"\s+w="(\d+)"\s+h="(\d+)"[^>]*>([\s\S]*?)<\/item>/g;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(xmlString)) !== null) {
      const [, x, y, w, h, content] = itemMatch;

      // Parse <t> elements (text alternatives with confidence)
      const alternatives: Array<{ text: string; confidence: number }> = [];
      const textRegex = /<t\s+w="(\d+)"[^>]*>([^<]*)<\/t>/g;
      let textMatch;

      while ((textMatch = textRegex.exec(content)) !== null) {
        const [, weight, text] = textMatch;
        alternatives.push({
          text: text,
          confidence: parseInt(weight, 10) / 100, // Convert 0-100 to 0-1
        });
      }

      if (alternatives.length > 0) {
        items.push({
          boundingBox: {
            x: parseInt(x, 10),
            y: parseInt(y, 10),
            width: parseInt(w, 10),
            height: parseInt(h, 10),
          },
          alternatives,
        });
      }
    }

    return { resourceGuid, items };
  }

  extractTextFromRecognition(recognition: RecognitionData): string {
    return recognition.items
      .map((item) => item.alternatives[0]?.text)
      .filter(Boolean)
      .join(" ");
  }

  private recognitionXmlPayload(recognition: any): any {
    if (recognition == null) {
      return null;
    }
    if (recognition.body != null) {
      return recognition.body;
    }
    return recognition;
  }

  private hasParseableRecognitionBody(recognition: any): boolean {
    const payload = this.recognitionXmlPayload(recognition);
    if (payload == null) {
      return false;
    }
    if (typeof payload === 'string') {
      return payload.length > 0;
    }
    if (Buffer.isBuffer(payload)) {
      return payload.length > 0;
    }
    return false;
  }

  private supportsOcrLookup(resource: any): boolean {
    if (
      resource?.mime === 'application/pdf' ||
      resource?.mime?.startsWith('image/')
    ) {
      return true;
    }
    // MIME is occasionally missing on resources that still carry recognition metadata.
    if (!resource?.mime && resource?.recognition != null) {
      return true;
    }
    return false;
  }

  private shouldPropagateRecognitionError(error: unknown): boolean {
    const code = (error as { errorCode?: number })?.errorCode;
    if (code === 9 || code === 19) {
      return true;
    }
    const msg = error instanceof Error ? error.message : String(error);
    return /authentication required|token may be expired|invalid token|not connected/i.test(
      msg,
    );
  }

  private async extractRecognitionTextFromResource(
    resourceGuid: string,
    resource: any,
  ): Promise<string | null> {
    if (!this.supportsOcrLookup(resource)) {
      return null;
    }

    let recognition: RecognitionData;
    try {
      if (
        resource?.recognition != null &&
        this.hasParseableRecognitionBody(resource.recognition)
      ) {
        recognition = this.parseRecognitionXml(
          resourceGuid,
          this.recognitionXmlPayload(resource.recognition),
        );
      } else {
        recognition = await this.getResourceRecognition(resourceGuid);
      }
    } catch (error) {
      if (this.shouldPropagateRecognitionError(error)) {
        throw error;
      }
      return null;
    }

    const text = this.extractTextFromRecognition(recognition);
    return text || null;
  }

  private isPdfExtractionFallback(text: string): boolean {
    return text.startsWith("[") && text.includes("PDF text extraction");
  }

  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".pdf": "application/pdf",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".amr": "audio/amr",
      ".doc": "application/msword",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".txt": "text/plain",
      ".html": "text/html",
      ".xml": "text/xml",
      ".json": "application/json",
      ".zip": "application/zip",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

  // Sync operations
  async getSyncState(): Promise<any> {
    return await this.noteStore.getSyncState();
  }

  async getFilteredSyncChunk(
    afterUSN: number,
    maxEntries: number = 100,
    filter: any,
  ): Promise<any> {
    const EvernoteModule = (Evernote as any).default || Evernote;
    const SyncChunkFilter = EvernoteModule.NoteStore?.SyncChunkFilter;
    const sdkFilter = SyncChunkFilter ? new SyncChunkFilter(filter) : filter;

    return await this.noteStore.getFilteredSyncChunk(
      afterUSN,
      maxEntries,
      sdkFilter,
    );
  }

  // Helper methods
  convertMarkdownToENML(
    content: string,
    existingResources?: any[],
  ): ReturnType<typeof markdownToENML> {
    const normalized = this.normalizeExistingResources(existingResources);
    return markdownToENML(content, { existingResources: normalized });
  }

  convertENMLToMarkdown(enmlContent: string, resources?: any[]): string {
    const normalized = this.normalizeExistingResources(resources);
    return enmlToMarkdown(enmlContent, { resources: normalized });
  }

  async applyMarkdownToNote(
    note: any,
    markdown: string,
    options?: { preserveResources?: boolean },
  ): Promise<void> {
    const EvernoteModule = (Evernote as any).default || Evernote;
    const originalResources = options?.preserveResources
      ? note.resources || []
      : [];

    const conversion = this.convertMarkdownToENML(markdown, note.resources);
    note.content = this.wrapEnml(conversion.enml);
    const attachmentResources = this.buildResourcesFromAttachments(
      conversion.attachments,
      EvernoteModule,
    );

    if (options?.preserveResources) {
      // Merge: start with original resources, add any new attachments
      const existingHashes = new Set(
        originalResources
          .map((r: any) =>
            r.data?.bodyHash
              ? Buffer.from(r.data.bodyHash).toString("hex")
              : null,
          )
          .filter(Boolean),
      );

      // Add new attachments that aren't already in original resources
      const mergedResources = [...originalResources];
      for (const resource of attachmentResources) {
        const hash = resource.data?.bodyHash
          ? Buffer.from(resource.data.bodyHash).toString("hex")
          : null;
        if (hash && !existingHashes.has(hash)) {
          mergedResources.push(resource);
        }
      }

      if (mergedResources.length > 0) {
        note.resources = mergedResources;
      } else {
        delete note.resources;
      }
    } else {
      // Original behavior: replace resources with new attachments only
      if (attachmentResources.length > 0) {
        note.resources = attachmentResources;
      } else if (note.resources) {
        delete note.resources;
      }
    }
  }

  private wrapEnml(body: string): string {
    let enmlContent = '<?xml version="1.0" encoding="UTF-8"?>';
    enmlContent +=
      '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">';
    enmlContent += `<en-note>${body}</en-note>`;
    return enmlContent;
  }

  private buildResourcesFromAttachments(
    attachments: MarkdownAttachment[],
    EvernoteModule: any,
  ): any[] {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const resources: any[] = [];
    const seen = new Set<string>();

    for (const attachment of attachments) {
      if (seen.has(attachment.hashHex)) {
        continue;
      }
      seen.add(attachment.hashHex);

      if (attachment.resource) {
        resources.push(attachment.resource);
        continue;
      }

      if (!attachment.data) {
        continue;
      }

      const resource = new EvernoteModule.Types.Resource();
      resource.data = new EvernoteModule.Types.Data();
      resource.data.body = attachment.data;
      resource.data.size = attachment.data.length;
      resource.data.bodyHash = attachment.hash;
      resource.mime = attachment.mimeType;

      const attrs = new EvernoteModule.Types.ResourceAttributes();
      if (attachment.filename) {
        attrs.fileName = attachment.filename;
      }
      if (attachment.sourceURL) {
        attrs.sourceURL = attachment.sourceURL;
      }
      if (attachment.filename || attachment.sourceURL) {
        resource.attributes = attrs;
      }

      resources.push(resource);
    }

    return resources;
  }

  private buildExplicitResources(
    resources: NoteContent["resources"],
    EvernoteModule: any,
  ): any[] {
    if (!resources || resources.length === 0) {
      return [];
    }

    return resources.map((r) => {
      const resource = new EvernoteModule.Types.Resource();
      resource.data = new EvernoteModule.Types.Data();
      resource.data.body = r.data;
      resource.data.size = r.data?.length ?? 0;
      resource.data.bodyHash = r.data ? this.computeHash(r.data) : undefined;
      resource.mime = r.mimeType;

      if (r.filename || r.attributes) {
        const attrs = new EvernoteModule.Types.ResourceAttributes(
          r.attributes || {},
        );
        if (r.filename) {
          attrs.fileName = r.filename;
        }
        resource.attributes = attrs;
      }

      return resource;
    });
  }

  private normalizeExistingResources(
    resources: any[] | undefined,
  ): MarkdownExistingResource[] {
    if (!resources || resources.length === 0) {
      return [];
    }

    const normalized: MarkdownExistingResource[] = [];

    for (const resource of resources) {
      if (!resource) {
        continue;
      }

      const hashBuffer: Buffer | undefined = resource?.data?.bodyHash
        ? Buffer.from(resource.data.bodyHash)
        : resource?.data?.body
          ? this.computeHash(Buffer.from(resource.data.body))
          : undefined;

      if (!hashBuffer) {
        continue;
      }

      normalized.push({
        hashHex: hashBuffer.toString("hex"),
        mimeType: resource.mime,
        filename:
          resource?.attributes?.fileName || resource?.attributes?.filename,
        sourceURL: resource?.attributes?.sourceURL,
        resource,
      });
    }

    return normalized;
  }

  private computeHash(data: Buffer): Buffer {
    return createHash("md5").update(data).digest();
  }

  // User info
  async getUser(): Promise<any> {
    const userStore = this.client.getUserStore();
    return await userStore.getUser();
  }

  async getQuotaInfo(): Promise<any> {
    const userStore = this.client.getUserStore();
    const user = await userStore.getUser();
    return {
      uploadLimit: user.accounting.uploadLimit,
      uploadLimitEnd: user.accounting.uploadLimitEnd,
      uploadLimitNextMonth: user.accounting.uploadLimitNextMonth,
      premiumServiceStatus: user.premiumInfo?.premiumServiceStatus,
      premiumServiceStart: user.premiumInfo?.premiumServiceStart,
      premiumExpirationDate: user.premiumInfo?.premiumExpirationDate,
    };
  }
}
