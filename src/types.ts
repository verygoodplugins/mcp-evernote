export interface EvernoteConfig {
  consumerKey: string;
  consumerSecret: string;
  sandbox: boolean;
  china?: boolean;
}

export interface OAuthTokens {
  token: string;
  tokenSecret?: string;
  expires?: number;
  noteStoreUrl?: string;
  webApiUrlPrefix?: string;
  userId?: number;
}

export interface NoteContent {
  title: string;
  content: string;
  notebookGuid?: string;
  tagNames?: string[];
  resources?: Resource[];
  attributes?: NoteAttributes;
}

export interface Resource {
  data: Buffer;
  mimeType: string;
  filename?: string;
  attributes?: ResourceAttributes;
}

export interface ResourceAttributes {
  sourceURL?: string;
  timestamp?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  cameraMake?: string;
  cameraModel?: string;
}

export interface NoteAttributes {
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
  lastEditedBy?: string;
  classifications?: Record<string, string>;
}

export interface SearchParameters {
  words?: string;
  notebookGuid?: string;
  tagGuids?: string[];
  timeZone?: string;
  inactive?: boolean;
  emphasized?: string;
  includeAllReadableNotebooks?: boolean;
  filter?: NoteFilter;
  offset?: number;
  maxNotes?: number;
}

export interface NoteFilter {
  order?: number;
  ascending?: boolean;
  words?: string;
  notebookGuid?: string;
  tagGuids?: string[];
  timeZone?: string;
  inactive?: boolean;
  emphasized?: string;
}

export interface NotebookInfo {
  guid: string;
  name: string;
  updateSequenceNum?: number;
  defaultNotebook?: boolean;
  serviceCreated?: number;
  serviceUpdated?: number;
  publishing?: Publishing;
  published?: boolean;
  stack?: string;
  sharedNotebookIds?: number[];
  sharedNotebooks?: SharedNotebook[];
  businessNotebook?: BusinessNotebook;
  contact?: User;
  restrictions?: NotebookRestrictions;
}

export interface Publishing {
  uri?: string;
  order?: number;
  ascending?: boolean;
  publicDescription?: string;
}

export interface SharedNotebook {
  id?: number;
  userId?: number;
  notebookGuid?: string;
  email?: string;
  notebookModifiable?: boolean;
  requireLogin?: boolean;
  serviceCreated?: number;
  shareKey?: string;
  username?: string;
}

export interface BusinessNotebook {
  notebookDescription?: string;
  privilege?: number;
  recommended?: boolean;
}

export interface User {
  id?: number;
  username?: string;
  email?: string;
  name?: string;
  timezone?: string;
  privilege?: number;
  created?: number;
  updated?: number;
  deleted?: number;
  active?: boolean;
}

export interface NotebookRestrictions {
  noReadNotes?: boolean;
  noCreateNotes?: boolean;
  noUpdateNotes?: boolean;
  noExpungeNotes?: boolean;
  noShareNotes?: boolean;
  noEmailNotes?: boolean;
  noSendMessageToRecipients?: boolean;
  noUpdateNotebook?: boolean;
  noExpungeNotebook?: boolean;
  noSetDefaultNotebook?: boolean;
  noSetNotebookStack?: boolean;
  noPublishToPublic?: boolean;
  noPublishToBusinessLibrary?: boolean;
  noCreateTags?: boolean;
  noUpdateTags?: boolean;
  noExpungeTags?: boolean;
  noSetParentTag?: boolean;
  noCreateSharedNotebooks?: boolean;
  noShareNotesWithBusiness?: boolean;
  noRenameNotebook?: boolean;
}

export interface Tag {
  guid?: string;
  name: string;
  parentGuid?: string;
  updateSequenceNum?: number;
}

export interface RecognitionItem {
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  alternatives: Array<{
    text: string;
    confidence: number;
  }>;
}

export interface RecognitionData {
  resourceGuid: string;
  items: RecognitionItem[];
}

export interface ResourceInfo {
  guid: string;
  filename?: string;
  mimeType: string;
  size: number;
  hash: string;
  hasRecognition: boolean;
}