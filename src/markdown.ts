import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { lookup as lookupMimeType } from 'mime-types';
import { validateLocalFilePathSync } from './path-security.js';

export interface MarkdownExistingResource {
  hashHex: string;
  mimeType?: string;
  filename?: string;
  sourceURL?: string;
  resource?: any;
}

export interface MarkdownAttachment {
  hashHex: string;
  hash: Buffer;
  mimeType: string;
  filename?: string;
  sourcePath?: string;
  sourceURL?: string;
  data?: Buffer;
  resource?: any;
  isNew: boolean;
}

export interface MarkdownConversionResult {
  enml: string;
  attachments: MarkdownAttachment[];
}

marked.use({
  gfm: true,
  breaks: true,
});

const allowedTags = [
  'a', 'abbr', 'acronym', 'b', 'blockquote', 'br', 'code', 'dd', 'div', 'dl', 'dt',
  'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre',
  's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'u', 'ul', 'en-todo', 'en-media'
];

const allowedAttributes: Record<string, string[]> = {
  a: ['href', 'title'],
  div: ['align'],
  td: ['colspan', 'rowspan', 'align'],
  th: ['colspan', 'rowspan', 'align'],
  'en-todo': ['checked'],
  'en-media': ['type', 'hash', 'width', 'height', 'style', 'alt', 'title'],
};

export function markdownToENML(
  markdown: string,
  options: { existingResources?: MarkdownExistingResource[] } = {}
): MarkdownConversionResult {
  const attachments: MarkdownAttachment[] = [];
  const attachmentsByHash = new Map<string, MarkdownAttachment>();
  const existingMap = buildExistingResourceMap(options.existingResources);
  const renderer = new marked.Renderer();

  (renderer as any).image = (href: string | null, title: string | null, text: string) => {
    return renderImage(href, title, text, existingMap, attachments, attachmentsByHash);
  };

  const preprocessed = markdown
    .replace(/^(\s*[-*]\s+)\[[xX]\]\s+/gim, '$1<en-todo checked="true"/> ')
    .replace(/^(\s*[-*]\s+)\[ \]\s+/gim, '$1<en-todo/> ');

  const html = marked.parse(preprocessed, { renderer }) as string;

  let transformed = html
    .replace(/<li[^>]*class=["'][^"']*checked[^"']*[^>]*>\s*<input[^>]*type=["']checkbox["'][^>]*>\s*/gi, '<li><en-todo checked="true"/> ')
    .replace(/<li[^>]*>\s*<input[^>]*type=["']checkbox["'][^>]*checked[^>]*>\s*/gi, '<li><en-todo checked="true"/> ')
    .replace(/<li[^>]*>\s*<input[^>]*type=["']checkbox["'][^>]*>\s*/gi, '<li><en-todo/> ')
    .replace(/\sclass=["']task-list-item["']/gi, '')
    .replace(/\sclass=["']contains-task-list["']/gi, '');

  transformed = sanitizeHtml(transformed, {
    allowedTags,
    allowedAttributes,
    allowedSchemes: ['http', 'https', 'mailto'],
    selfClosing: ['en-todo', 'en-media', 'br', 'hr'],
    transformTags: {
      'a': (tagName: string, attribs: Record<string, string>) => {
        if (attribs.href) {
          const cleaned = stripControlCharacters(attribs.href).trim().toLowerCase();
          // Blacklist dangerous schemes
          const dangerousSchemes = ['javascript:', 'data:', 'vbscript:', 'blob:'];
          if (dangerousSchemes.some(s => cleaned.startsWith(s))) {
            return { tagName, attribs: { ...attribs, href: '' } };
          }
          // For absolute URLs, whitelist allowed schemes only
          const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(cleaned);
          if (hasScheme) {
            const safeSchemes = ['http:', 'https:', 'mailto:'];
            if (!safeSchemes.some(s => cleaned.startsWith(s))) {
              return { tagName, attribs: { ...attribs, href: '' } };
            }
          }
        }
        return { tagName, attribs };
      },
    },
  });

  return {
    enml: transformed,
    attachments,
  };
}

export function enmlToMarkdown(
  enml: string,
  options: { resources?: MarkdownExistingResource[] } = {}
): string {
  let content = enml
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');

  const match = content.match(/<en-note[^>]*>([\s\S]*?)<\/en-note>/i);
  if (match) content = match[1];

  content = content
    .replace(/<en-todo\s+checked=["']true["']\s*\/>/gi, '<input type="checkbox" checked />')
    .replace(/<en-todo\s*\/>/gi, '<input type="checkbox" />');

  const resourceMap = buildExistingResourceMap(options.resources);
  content = content.replace(/<en-media\b([^>]*)>(?:<\/en-media>)?/gi, (_, attrs) => {
    const parsed = parseAttributes(attrs || '');
    const hash = (parsed.hash || '').toLowerCase();
    const type = parsed.type || resourceMap.get(hash)?.mimeType || 'application/octet-stream';
    const existing = resourceMap.get(hash);
    const displayName = parsed.title || existing?.filename || existing?.mimeType || hash;

    if (type.toLowerCase().startsWith('image/')) {
      const alt = parsed.alt || displayName;
      return `<img src="evernote-resource:${hash}" alt="${escapeAttribute(alt)}" data-evernote-type="${escapeAttribute(type)}" />`;
    }

    return `<a href="evernote-resource:${hash}" data-evernote-type="${escapeAttribute(type)}">${escapeHtml(displayName)}</a>`;
  });

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  turndown.use(gfm);

  const markdown = turndown.turndown(content).trim();
  return markdown;
}

function renderImage(
  href: string | null,
  title: string | null,
  text: string,
  existingMap: Map<string, MarkdownExistingResource>,
  attachments: MarkdownAttachment[],
  attachmentsByHash: Map<string, MarkdownAttachment>
): string {
  const url = (href || '').trim();
  const altText = text || url;

  if (!url) {
    return escapeHtml(text);
  }

  const resourceMatch = url.match(/^evernote-resource:([a-f0-9]{32})$/i);
  if (resourceMatch) {
    const hashHex = resourceMatch[1].toLowerCase();
    const existing = existingMap.get(hashHex);
    if (!existing) {
      return fallbackLink(url, altText, title);
    }

    const attachment = registerAttachment({
      hashHex,
      hash: Buffer.from(hashHex, 'hex'),
      mimeType: existing.mimeType || 'application/octet-stream',
      filename: existing.filename,
      sourceURL: existing.sourceURL,
      resource: existing.resource,
      isNew: false,
    }, attachments, attachmentsByHash);

    const altAttr = text ? ` alt="${escapeAttribute(text)}"` : '';
    const titleAttr = title ? ` title="${escapeAttribute(title)}"` : '';
    return `<en-media type="${attachment.mimeType}" hash="${hashHex}"${altAttr}${titleAttr} />`;
  }

  const local = resolveLocalPath(url);
  if (local) {
    try {
      const data = readFileSync(local.path);
      const hash = createHash('md5').update(data).digest();
      const hashHex = hash.toString('hex');
      const mimeType = lookupMimeType(local.path) || 'application/octet-stream';

      const attachment = registerAttachment({
        hashHex,
        hash,
        mimeType,
        filename: path.basename(local.path),
        sourcePath: local.path,
        sourceURL: local.sourceURL,
        data,
        isNew: true,
      }, attachments, attachmentsByHash);

      const altAttr = text ? ` alt="${escapeAttribute(text)}"` : '';
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : '';
      return `<en-media type="${attachment.mimeType}" hash="${attachment.hashHex}"${altAttr}${titleAttr} />`;
    } catch (error) {
      console.warn(`Failed to embed attachment '${url}':`, error);
    }
  }

  return fallbackLink(url, altText, title);
}

function registerAttachment(
  candidate: MarkdownAttachment,
  attachments: MarkdownAttachment[],
  attachmentsByHash: Map<string, MarkdownAttachment>
): MarkdownAttachment {
  const key = candidate.hashHex;
  const existing = attachmentsByHash.get(key);
  if (existing) {
    return existing;
  }

  attachmentsByHash.set(key, candidate);
  attachments.push(candidate);
  return candidate;
}

function fallbackLink(url: string, label: string, title: string | null): string {
  const safeUrl = escapeAttribute(url);
  const text = escapeHtml(label || url);
  const titleAttr = title ? ` title="${escapeAttribute(title)}"` : '';
  return `<a href="${safeUrl}"${titleAttr}>${text}</a>`;
}

function resolveLocalPath(href: string): { path: string; sourceURL: string } | null {
  let candidate = href.replace(/[#?].*$/, '');

  try {
    candidate = decodeURI(candidate);
  } catch {
    // ignore decode errors
  }

  try {
    const fileUrl = new URL(candidate);
    if (fileUrl.protocol === 'file:') {
      const filePath = fileURLToPath(fileUrl);
      const validatedPath = validateLocalFilePathSync(filePath);
      if (!validatedPath) {
        console.warn(`Path rejected (security): ${filePath} is outside allowed file roots`);
        return null;
      }
      return {
        path: validatedPath,
        sourceURL: fileUrl.toString(),
      };
    }

    if (fileUrl.protocol && fileUrl.protocol !== 'file:') {
      return null;
    }
  } catch {
    // not an absolute URL, continue
  }

  if (/^[a-zA-Z]+:/.test(candidate)) {
    return null;
  }

  if (candidate.startsWith('~/')) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }

  const absolute = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(process.cwd(), candidate);

  const validatedPath = validateLocalFilePathSync(absolute);
  if (!validatedPath) {
    return null;
  }

  return {
    path: validatedPath,
    sourceURL: pathToFileURL(validatedPath).toString(),
  };
}

function stripControlCharacters(value: string): string {
  let cleaned = '';
  for (const char of value) {
    if (char.charCodeAt(0) >= 32) {
      cleaned += char;
    }
  }
  return cleaned;
}

function buildExistingResourceMap(resources: MarkdownExistingResource[] | undefined) {
  const map = new Map<string, MarkdownExistingResource>();
  if (!resources) {
    return map;
  }

  for (const resource of resources) {
    if (!resource.hashHex) {
      continue;
    }
    map.set(resource.hashHex.toLowerCase(), resource);
  }

  return map;
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    const [, key, , doubleQuoted, singleQuoted, unquoted] = match;
    const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
    attrs[key] = value;
  }

  return attrs;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
