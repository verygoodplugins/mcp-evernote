import { describe, it, expect } from '@jest/globals';

// Test the ENML to plain text conversion logic directly
// This mirrors the private enmlToPlainText method in EvernoteAPI

function enmlToPlainText(enmlContent: string): string {
  // Remove XML declaration and DOCTYPE
  let text = enmlContent.replace(/<\?xml[^?]*\?>/gi, '');
  text = text.replace(/<!DOCTYPE[^>]*>/gi, '');

  // Remove en-media tags (attachments)
  text = text.replace(/<en-media[^>]*\/?>/gi, '');

  // Replace common block elements with newlines
  text = text.replace(/<\/?(div|p|br|li|h[1-6])[^>]*>/gi, '\n');

  // Remove all remaining HTML/XML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities (decode &amp; LAST to avoid double-unescaping)
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&amp;/gi, '&');

  // Normalize whitespace
  text = text.replace(/\n\s*\n/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.trim();

  return text;
}

function truncatePreview(plainText: string, maxLength: number = 300): string | null {
  if (!plainText || plainText.length === 0) {
    return null;
  }

  if (plainText.length <= maxLength) {
    return plainText;
  }

  // Find a good break point (word boundary)
  let truncated = plainText.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.7) {
    truncated = truncated.substring(0, lastSpace);
  }

  return truncated + '...';
}

describe('Search Note Preview', () => {
  describe('ENML to Plain Text Conversion', () => {
    it('should extract text from simple ENML', () => {
      const enml = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>Hello World</en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toBe('Hello World');
    });

    it('should handle div and paragraph elements', () => {
      const enml = '<en-note><div>First paragraph</div><div>Second paragraph</div></en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toContain('First paragraph');
      expect(result).toContain('Second paragraph');
    });

    it('should remove en-media tags', () => {
      const enml = '<en-note>Text before<en-media type="image/png" hash="abc123"/>Text after</en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toBe('Text beforeText after');
    });

    it('should decode HTML entities', () => {
      const enml = '<en-note>Tom &amp; Jerry use &lt;tags&gt;</en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toBe('Tom & Jerry use <tags>');
    });

    it('should handle non-breaking spaces', () => {
      const enml = '<en-note>Word&nbsp;another&nbsp;word</en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toBe('Word another word');
    });

    it('should handle quotes and apostrophes', () => {
      const enml = '<en-note>&quot;Hello,&quot; she said. &quot;It&#39;s nice!&quot;</en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toBe('"Hello," she said. "It\'s nice!"');
    });

    it('should normalize multiple whitespace', () => {
      const enml = '<en-note>Word    many    spaces</en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toBe('Word many spaces');
    });

    it('should remove multiple newlines', () => {
      const enml = '<en-note><div>First</div>\n\n\n<div>Second</div></en-note>';
      const result = enmlToPlainText(enml);
      // Should have at most one newline between paragraphs
      expect(result.split('\n').length).toBeLessThanOrEqual(3);
    });

    it('should handle heading elements', () => {
      const enml = '<en-note><h1>Title</h1><p>Content</p></en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toContain('Title');
      expect(result).toContain('Content');
    });

    it('should handle list items', () => {
      const enml = '<en-note><ul><li>Item 1</li><li>Item 2</li></ul></en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toContain('Item 1');
      expect(result).toContain('Item 2');
    });

    it('should handle empty content', () => {
      const enml = '<en-note></en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toBe('');
    });

    it('should handle self-closing br tags', () => {
      const enml = '<en-note>Line 1<br/>Line 2</en-note>';
      const result = enmlToPlainText(enml);
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
    });
  });

  describe('Preview Truncation', () => {
    it('should return null for empty text', () => {
      expect(truncatePreview('')).toBeNull();
    });

    it('should return text as-is if under max length', () => {
      const shortText = 'This is a short text.';
      expect(truncatePreview(shortText, 300)).toBe(shortText);
    });

    it('should truncate long text with ellipsis', () => {
      const longText = 'A'.repeat(400);
      const result = truncatePreview(longText, 300);
      expect(result).toBeDefined();
      expect(result!.endsWith('...')).toBe(true);
      expect(result!.length).toBeLessThanOrEqual(303); // 300 + '...'
    });

    it('should break at word boundary when possible', () => {
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
      const result = truncatePreview(text, 50);
      expect(result).toBeDefined();
      // Should end with a complete word + ellipsis
      expect(result!.endsWith('...')).toBe(true);
      // Check it breaks at a space, not in the middle of a word
      const withoutEllipsis = result!.slice(0, -3);
      expect(withoutEllipsis.endsWith(' ') || !withoutEllipsis.includes(' ') || text.substring(withoutEllipsis.length, withoutEllipsis.length + 1) === ' ').toBe(true);
    });

    it('should use custom max length', () => {
      const text = 'A'.repeat(200);
      const result = truncatePreview(text, 100);
      expect(result).toBeDefined();
      expect(result!.length).toBeLessThanOrEqual(103);
    });
  });
});
