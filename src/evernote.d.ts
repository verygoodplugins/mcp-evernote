declare module 'evernote' {
  namespace Evernote {
    namespace Types {
    export class Note {
      guid?: string;
      title?: string;
      content?: string;
      contentHash?: Buffer;
      contentLength?: number;
      created?: number;
      updated?: number;
      deleted?: number;
      active?: boolean;
      updateSequenceNum?: number;
      notebookGuid?: string;
      tagGuids?: string[];
      resources?: Resource[];
      attributes?: NoteAttributes;
      tagNames?: string[];
    }

    export class NoteAttributes {
      constructor(attrs?: any);
      subjectDate?: number;
      latitude?: number;
      longitude?: number;
      altitude?: number;
      author?: string;
      source?: string;
      sourceURL?: string;
      sourceApplication?: string;
      shareDate?: number;
      reminderOrder?: number;
      reminderDoneTime?: number;
      reminderTime?: number;
      placeName?: string;
      contentClass?: string;
      applicationData?: any;
      lastEditedBy?: string;
      classifications?: Record<string, string>;
      creatorId?: number;
      lastEditorId?: number;
    }

    export class Resource {
      guid?: string;
      noteGuid?: string;
      data?: Data;
      mime?: string;
      width?: number;
      height?: number;
      duration?: number;
      active?: boolean;
      recognition?: any;
      attributes?: ResourceAttributes;
      updateSequenceNum?: number;
      alternateData?: Data;
    }

    export class ResourceAttributes {
      constructor(attrs?: any);
      sourceURL?: string;
      timestamp?: number;
      latitude?: number;
      longitude?: number;
      altitude?: number;
      cameraMake?: string;
      cameraModel?: string;
      clientWillIndex?: boolean;
      recoType?: string;
      fileName?: string;
      attachment?: boolean;
      applicationData?: any;
    }

    export class Data {
      bodyHash?: Buffer;
      size?: number;
      body?: Buffer;
    }

    export class Notebook {
      guid?: string;
      name?: string;
      updateSequenceNum?: number;
      defaultNotebook?: boolean;
      serviceCreated?: number;
      serviceUpdated?: number;
      publishing?: any;
      published?: boolean;
      stack?: string;
      sharedNotebookIds?: number[];
      sharedNotebooks?: any[];
      businessNotebook?: any;
      contact?: any;
      restrictions?: any;
    }

    export class Tag {
      guid?: string;
      name?: string;
      parentGuid?: string;
      updateSequenceNum?: number;
    }
  }

    namespace NoteStore {
    export class NoteFilter {
      order?: number;
      ascending?: boolean;
      words?: string;
      notebookGuid?: string;
      tagGuids?: string[];
      timeZone?: string;
      inactive?: boolean;
      emphasized?: string;
    }

    export class NotesMetadataResultSpec {
      includeTitle?: boolean;
      includeContentLength?: boolean;
      includeCreated?: boolean;
      includeUpdated?: boolean;
      includeDeleted?: boolean;
      includeUpdateSequenceNum?: boolean;
      includeNotebookGuid?: boolean;
      includeTagGuids?: boolean;
      includeAttributes?: boolean;
      includeLargestResourceMime?: boolean;
      includeLargestResourceSize?: boolean;
    }
  }

    class Client {
    constructor(options: {
      consumerKey?: string;
      consumerSecret?: string;
      token?: string;
      sandbox?: boolean;
      china?: boolean;
    });
    getRequestToken(callbackUrl: string, callback: Function): void;
    getAuthorizeUrl(oauthToken: string): string;
    getAccessToken(
      oauthToken: string,
      oauthTokenSecret: string,
      oauthVerifier: string,
      callback: Function
    ): void;
    getNoteStore(noteStoreUrl?: string): any;
    getUserStore(): any;
    }
  }
  export = Evernote;
}