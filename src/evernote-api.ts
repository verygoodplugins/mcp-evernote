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
} from './types.js';

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
