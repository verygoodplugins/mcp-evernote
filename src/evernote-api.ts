import * as Evernote from 'evernote';
import { createHash } from 'crypto';
import {
  markdownToENML,
  enmlToMarkdown,
  MarkdownAttachment,
  MarkdownExistingResource,
} from './markdown.js';
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
} from './types.js';
import { readFile } from 'fs/promises';
import { basename, extname } from 'path';

export class EvernoteAPI {
  private noteStore: any;
  private client: any;

  constructor(client: any, tokens: OAuthTokens) {
    this.client = client;
    this.noteStore = client.getNoteStore(tokens.noteStoreUrl);
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
      note.attributes = new EvernoteModule.Types.NoteAttributes(noteContent.attributes);
    }

    const resources: any[] = [];

    const attachmentResources = this.buildResourcesFromAttachments(
      conversion.attachments,
      EvernoteModule
    );
    if (attachmentResources.length > 0) {
      resources.push(...attachmentResources);
    }

    const explicitResources = this.buildExplicitResources(
      noteContent.resources,
      EvernoteModule
    );
    if (explicitResources.length > 0) {
      resources.push(...explicitResources);
    }

    if (resources.length > 0) {
      note.resources = resources;
    }

    return await this.noteStore.createNote(note);
  }

  async getNote(guid: string, withContent: boolean = true, withResources: boolean = false): Promise<any> {
    return await this.noteStore.getNote(guid, withContent, withResources, false, false);
  }

  async updateNote(note: any, retryCount: number = 0): Promise<any> {
    const maxRetries = 3;
    const baseDelay = 2000; // 2 seconds base delay
    
    try {
      console.error(`Attempting to update note ${note.guid} with title: ${note.title} (attempt ${retryCount + 1})`);
      console.error(`Note content length: ${note.content ? note.content.length : 'no content'}`);
      console.error(`Note tags: ${note.tagNames ? JSON.stringify(note.tagNames) : 'no tags'}`);
      
      const result = await this.noteStore.updateNote(note);
      console.error(`Note update successful for ${note.guid}`);
      return result;
    } catch (error: any) {
      console.error('=== Note Update Failed ===');
      console.error(`Note GUID: ${note.guid}`);
      console.error(`Note Title: ${note.title}`);
      console.error(`Error Name: ${error.name}`);
      console.error(`Error Message: ${error.message}`);
      console.error(`Error Code: ${error.errorCode || 'none'}`);
      console.error(`Error Parameter: ${error.parameter || 'none'}`);
      console.error(`Attempt: ${retryCount + 1}/${maxRetries + 1}`);
      console.error('========================');
      
      // Handle specific Evernote error codes
      if (error.errorCode === 19 && retryCount < maxRetries) {
        // Error code 19: RTE room already open - retry with exponential backoff
        const delay = baseDelay * Math.pow(2, retryCount);
        console.error(`RTE room conflict detected. Retrying in ${delay}ms...`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.updateNote(note, retryCount + 1);
      }
      
      // Enhanced error with context
      const enhancedError = new Error(`Failed to update note ${note.guid}: ${error.message}`);
      enhancedError.name = error.name || 'EvernoteUpdateError';
      (enhancedError as any).originalError = error;
      (enhancedError as any).noteGuid = note.guid;
      (enhancedError as any).noteTitle = note.title;
      (enhancedError as any).errorCode = error.errorCode;
      (enhancedError as any).parameter = error.parameter;
      (enhancedError as any).retriesAttempted = retryCount;
      
      throw enhancedError;
    }
  }

  async deleteNote(guid: string): Promise<void> {
    await this.noteStore.deleteNote(guid);
  }

  async patchNoteContent(guid: string, replacements: NoteReplacement[]): Promise<PatchNoteResult> {
    // Fetch existing note with content and resources
    const note = await this.getNote(guid, true, true);

    // Preserve original resources before markdown conversion
    const originalResources = note.resources ? [...note.resources] : [];

    // Convert ENML to markdown
    let markdown = this.convertENMLToMarkdown(note.content, note.resources);

    // Track changes
    const changes: PatchNoteResult['changes'] = [];

    // Apply replacements sequentially
    for (const replacement of replacements) {
      const { find, replace, replaceAll = true } = replacement;

      // Count occurrences
      const regex = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
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
        warning: 'No matches found for any replacement patterns',
      };
    }

    // Check if content would be empty after replacement
    const trimmedMarkdown = markdown.trim();
    if (!trimmedMarkdown) {
      return {
        success: false,
        noteGuid: guid,
        changes,
        warning: 'Replacement would result in empty note content - operation aborted',
      };
    }

    // Apply updated markdown back to note
    await this.applyMarkdownToNote(note, markdown);

    // Restore original resources - applyMarkdownToNote may have cleared them
    // if no new attachments were added via markdown syntax
    if (originalResources.length > 0) {
      // Merge: keep any new attachments from applyMarkdownToNote, add back originals
      const existingHashes = new Set(
        (note.resources || []).map((r: any) =>
          r.data?.bodyHash ? Buffer.from(r.data.bodyHash).toString('hex') : null
        ).filter(Boolean)
      );

      for (const resource of originalResources) {
        const hash = resource.data?.bodyHash
          ? Buffer.from(resource.data.bodyHash).toString('hex')
          : null;
        if (hash && !existingHashes.has(hash)) {
          if (!note.resources) {
            note.resources = [];
          }
          note.resources.push(resource);
        }
      }

      // If note.resources was deleted but we have originals, restore them
      if (!note.resources && originalResources.length > 0) {
        note.resources = originalResources;
      }
    }

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

    return await this.noteStore.findNotesMetadata(filter, offset, maxNotes, spec);
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
    return await this.noteStore.getResource(guid, withData, false, false, false);
  }

  async getResourceRecognition(guid: string): Promise<RecognitionData> {
    const recognitionData = await this.noteStore.getResourceRecognition(guid);
    return this.parseRecognitionXml(guid, recognitionData);
  }

  async listNoteResources(noteGuid: string): Promise<ResourceInfo[]> {
    const note = await this.noteStore.getNote(noteGuid, false, true, false, false);

    if (!note.resources || note.resources.length === 0) {
      return [];
    }

    return note.resources.map((r: any) => ({
      guid: r.guid,
      filename: r.attributes?.fileName,
      mimeType: r.mime,
      size: r.data?.size || 0,
      hash: r.data?.bodyHash ? Buffer.from(r.data.bodyHash).toString('hex') : '',
      hasRecognition: !!r.recognition,
    }));
  }

  async addResourceToNote(noteGuid: string, filePath: string, filename?: string): Promise<any> {
    const EvernoteModule = (Evernote as any).default || Evernote;

    // Read file
    const fileData = await readFile(filePath);
    const hash = this.computeHash(fileData);
    const hashHex = hash.toString('hex');

    // Determine MIME type from extension
    const ext = extname(filePath).toLowerCase();
    const mimeType = this.getMimeType(ext);
    const displayName = filename || basename(filePath);

    // Get existing note with content and resources
    const note = await this.noteStore.getNote(noteGuid, true, true, false, false);

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
    note.content = note.content.replace('</en-note>', `<br/>${enMediaTag}</en-note>`);

    // Update note
    return await this.updateNote(note);
  }

  private parseRecognitionXml(resourceGuid: string, xmlData: any): RecognitionData {
    const items: RecognitionItem[] = [];

    if (!xmlData) {
      return { resourceGuid, items };
    }

    // Convert to string if it's a buffer
    const xmlString = typeof xmlData === 'string'
      ? xmlData
      : Buffer.from(xmlData).toString('utf-8');

    // Parse <item> elements with bounding box attributes
    const itemRegex = /<item\s+x="(\d+)"\s+y="(\d+)"\s+w="(\d+)"\s+h="(\d+)"[^>]*>([\s\S]*?)<\/item>/g;
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

  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.amr': 'audio/amr',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.xml': 'text/xml',
      '.json': 'application/json',
      '.zip': 'application/zip',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  // Sync operations
  async getSyncState(): Promise<any> {
    return await this.noteStore.getSyncState();
  }

  async getSyncChunk(afterUSN: number, maxEntries: number = 100, fullSyncOnly: boolean = false): Promise<any> {
    return await this.noteStore.getSyncChunk(afterUSN, maxEntries, fullSyncOnly);
  }

  // Helper methods
  convertMarkdownToENML(content: string, existingResources?: any[]): ReturnType<typeof markdownToENML> {
    const normalized = this.normalizeExistingResources(existingResources);
    return markdownToENML(content, { existingResources: normalized });
  }

  convertENMLToMarkdown(enmlContent: string, resources?: any[]): string {
    const normalized = this.normalizeExistingResources(resources);
    return enmlToMarkdown(enmlContent, { resources: normalized });
  }

  async applyMarkdownToNote(note: any, markdown: string): Promise<void> {
    const EvernoteModule = (Evernote as any).default || Evernote;
    const conversion = this.convertMarkdownToENML(markdown, note.resources);
    note.content = this.wrapEnml(conversion.enml);
    const attachmentResources = this.buildResourcesFromAttachments(
      conversion.attachments,
      EvernoteModule
    );
    if (attachmentResources.length > 0) {
      note.resources = attachmentResources;
    } else if (note.resources) {
      delete note.resources;
    }
  }

  private wrapEnml(body: string): string {
    let enmlContent = '<?xml version="1.0" encoding="UTF-8"?>';
    enmlContent += '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">';
    enmlContent += `<en-note>${body}</en-note>`;
    return enmlContent;
  }

  private buildResourcesFromAttachments(
    attachments: MarkdownAttachment[],
    EvernoteModule: any
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

  private buildExplicitResources(resources: NoteContent['resources'], EvernoteModule: any): any[] {
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
        const attrs = new EvernoteModule.Types.ResourceAttributes(r.attributes || {});
        if (r.filename) {
          attrs.fileName = r.filename;
        }
        resource.attributes = attrs;
      }

      return resource;
    });
  }

  private normalizeExistingResources(resources: any[] | undefined): MarkdownExistingResource[] {
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
        hashHex: hashBuffer.toString('hex'),
        mimeType: resource.mime,
        filename: resource?.attributes?.fileName || resource?.attributes?.filename,
        sourceURL: resource?.attributes?.sourceURL,
        resource,
      });
    }

    return normalized;
  }

  private computeHash(data: Buffer): Buffer {
    return createHash('md5').update(data).digest();
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
