import * as Evernote from 'evernote';
import { 
  NoteContent, 
  SearchParameters, 
  NotebookInfo, 
  Tag,
  OAuthTokens 
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
    
    // Build ENML content
    let enmlContent = '<?xml version="1.0" encoding="UTF-8"?>';
    enmlContent += '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">';
    enmlContent += '<en-note>';
    enmlContent += this.convertToENML(noteContent.content);
    enmlContent += '</en-note>';
    
    note.content = enmlContent;
    
    if (noteContent.notebookGuid) {
      note.notebookGuid = noteContent.notebookGuid;
    }
    
    if (noteContent.tagNames && noteContent.tagNames.length > 0) {
      note.tagNames = noteContent.tagNames;
    }

    if (noteContent.attributes) {
      note.attributes = new EvernoteModule.Types.NoteAttributes(noteContent.attributes);
    }

    if (noteContent.resources && noteContent.resources.length > 0) {
      note.resources = noteContent.resources.map(r => {
        const resource = new EvernoteModule.Types.Resource();
        resource.data = new EvernoteModule.Types.Data();
        resource.data.body = r.data;
        resource.mime = r.mimeType;
        if (r.attributes) {
          resource.attributes = new EvernoteModule.Types.ResourceAttributes(r.attributes);
        }
        return resource;
      });
    }

    return await this.noteStore.createNote(note);
  }

  async getNote(guid: string, withContent: boolean = true, withResources: boolean = false): Promise<any> {
    return await this.noteStore.getNote(guid, withContent, withResources, false, false);
  }

  async updateNote(note: any): Promise<any> {
    return await this.noteStore.updateNote(note);
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
      published: nb.published
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
      updateSequenceNum: tag.updateSequenceNum
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
  private convertToENML(content: string): string {
    // Convert markdown or plain text to ENML
    // This is a simplified version - you might want to use a proper markdown parser
    let enml = content;
    
    // Replace newlines with <br/>
    enml = enml.replace(/\n/g, '<br/>');
    
    // Escape special characters
    enml = enml.replace(/&/g, '&amp;');
    enml = enml.replace(/</g, '&lt;');
    enml = enml.replace(/>/g, '&gt;');
    enml = enml.replace(/"/g, '&quot;');
    enml = enml.replace(/'/g, '&apos;');
    
    // Re-enable br tags
    enml = enml.replace(/&lt;br\/&gt;/g, '<br/>');
    
    return enml;
  }

  convertFromENML(enmlContent: string): string {
    // Remove XML declaration and DOCTYPE
    let content = enmlContent.replace(/<\?xml[^>]*\?>/g, '');
    content = content.replace(/<!DOCTYPE[^>]*>/g, '');
    
    // Remove en-note tags
    content = content.replace(/<\/?en-note[^>]*>/g, '');
    
    // Convert br tags to newlines
    content = content.replace(/<br\s*\/?>/gi, '\n');
    
    // Remove other HTML tags (simplified)
    content = content.replace(/<[^>]*>/g, '');
    
    // Unescape HTML entities
    content = content.replace(/&amp;/g, '&');
    content = content.replace(/&lt;/g, '<');
    content = content.replace(/&gt;/g, '>');
    content = content.replace(/&quot;/g, '"');
    content = content.replace(/&apos;/g, "'");
    
    return content.trim();
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
      premiumExpirationDate: user.premiumInfo?.premiumExpirationDate
    };
  }
}