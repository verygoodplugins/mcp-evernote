/**
 * Tests for URL scheme defence in depth (M3).
 */
import { markdownToENML } from '../../src/markdown';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const markdownSource = readFileSync(
  resolve(__dirname, '../../src/markdown.ts'),
  'utf-8',
);

describe('URL scheme security (M3)', () => {
  it('preserves https links', () => {
    const result = markdownToENML('[link](https://example.com)');
    expect(result.enml).toContain('href="https://example.com"');
  });

  it('strips javascript: scheme', () => {
    const result = markdownToENML('[link](javascript:alert(1))');
    expect(result.enml).not.toContain('javascript:');
  });

  it('strips data: scheme', () => {
    const result = markdownToENML('[link](data:text/html,<script>)');
    expect(result.enml).not.toContain('data:');
  });

  it('strips vbscript: scheme', () => {
    const result = markdownToENML('[link](vbscript:foo)');
    expect(result.enml).not.toContain('vbscript:');
  });

  it('strips JAVASCRIPT: (case variant)', () => {
    const result = markdownToENML('[link](JAVASCRIPT:alert(1))');
    expect(result.enml).not.toContain('JAVASCRIPT:');
    expect(result.enml).not.toContain('javascript:');
  });

  it('preserves mailto: links', () => {
    const result = markdownToENML('[email](mailto:test@example.com)');
    expect(result.enml).toContain('href="mailto:test@example.com"');
  });

  it('preserves http: links', () => {
    const result = markdownToENML('[link](http://example.com)');
    expect(result.enml).toContain('href="http://example.com"');
  });

  it('strips blob: scheme', () => {
    const result = markdownToENML('[link](blob:http://example.com/abc)');
    expect(result.enml).not.toContain('blob:');
  });

  describe('defence-in-depth layer', () => {
    it('sanitizer config has transformTags for a tags', () => {
      // Verify the second layer exists in code
      expect(markdownSource).toContain('transformTags');
      const sanitizeBlock = markdownSource.match(
        /sanitizeHtml\(transformed,[\s\S]*?\}\)/,
      );
      expect(sanitizeBlock).not.toBeNull();
      expect(sanitizeBlock![0]).toContain('transformTags');
    });

    it('transformTags checks for dangerous schemes', () => {
      expect(markdownSource).toContain('javascript:');
      expect(markdownSource).toContain('data:');
      expect(markdownSource).toContain('vbscript:');
      expect(markdownSource).toContain('blob:');
    });

    it('transformTags strips control characters from hrefs', () => {
      expect(markdownSource).toContain('stripControlCharacters');
      const result = markdownToENML('<a href="java\u0000script:alert(1)">link</a>');
      expect(result.enml).not.toContain('java');
      expect(result.enml).not.toContain('script:');
    });
  });
});
