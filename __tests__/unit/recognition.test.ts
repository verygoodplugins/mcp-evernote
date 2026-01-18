import { describe, it, expect } from '@jest/globals';

/**
 * Unit tests for Recognition XML parsing logic.
 *
 * These tests verify the expected format and structure of Evernote's
 * recoIndex XML recognition data, which is used for OCR text extraction.
 *
 * The actual parsing implementation is tested via integration tests
 * in mcp-tools.test.ts through the evernote_get_resource_recognition tool.
 */

// Sample recognition XML for testing structure expectations
const sampleRecognitionXml = `<?xml version="1.0" encoding="UTF-8"?>
<recoIndex docType="unknown" objType="image" objID="resource-guid-123" engineVersion="5.5.10.4" recoType="service" langType="en" objWidth="800" objHeight="600">
  <item x="50" y="100" w="200" h="30">
    <t w="95">Hello</t>
    <t w="80">Helio</t>
    <t w="65">Helo</t>
  </item>
  <item x="50" y="150" w="250" h="30">
    <t w="98">World</t>
    <t w="75">Warld</t>
  </item>
  <item x="50" y="200" w="300" h="30">
    <t w="92">Testing OCR</t>
  </item>
</recoIndex>`;

describe('Recognition XML Parsing', () => {
  describe('XML Structure Validation', () => {
    it('should contain valid recoIndex root element', () => {
      expect(sampleRecognitionXml).toContain('<recoIndex');
      expect(sampleRecognitionXml).toContain('</recoIndex>');
    });

    it('should have item elements with bounding box attributes', () => {
      // Regex to match item elements with x, y, w, h attributes
      const itemRegex = /<item\s+x="(\d+)"\s+y="(\d+)"\s+w="(\d+)"\s+h="(\d+)"[^>]*>/g;
      const matches = [...sampleRecognitionXml.matchAll(itemRegex)];

      expect(matches.length).toBe(3);

      // First item: x=50, y=100, w=200, h=30
      expect(matches[0][1]).toBe('50');
      expect(matches[0][2]).toBe('100');
      expect(matches[0][3]).toBe('200');
      expect(matches[0][4]).toBe('30');
    });

    it('should have text alternatives with confidence weights', () => {
      // Regex to match text alternatives: <t w="weight">text</t>
      const textRegex = /<t\s+w="(\d+)"[^>]*>([^<]*)<\/t>/g;
      const matches = [...sampleRecognitionXml.matchAll(textRegex)];

      expect(matches.length).toBe(6); // 3 + 2 + 1 alternatives

      // First alternative: w=95, text=Hello
      expect(matches[0][1]).toBe('95');
      expect(matches[0][2]).toBe('Hello');
    });

    it('should extract text content correctly', () => {
      const textRegex = /<t\s+w="\d+"[^>]*>([^<]*)<\/t>/g;
      const texts: string[] = [];
      let match;

      while ((match = textRegex.exec(sampleRecognitionXml)) !== null) {
        texts.push(match[1]);
      }

      expect(texts).toContain('Hello');
      expect(texts).toContain('World');
      expect(texts).toContain('Testing OCR');
    });
  });

  describe('Parsing Logic Simulation', () => {
    // Simulate the parseRecognitionXml logic to test expected behavior

    interface RecognitionItem {
      boundingBox: { x: number; y: number; width: number; height: number };
      alternatives: Array<{ text: string; confidence: number }>;
    }

    function parseRecognitionXml(xmlString: string): RecognitionItem[] {
      const items: RecognitionItem[] = [];

      if (!xmlString) {
        return items;
      }

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
            text,
            confidence: parseInt(weight, 10),
          });
        }

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

      return items;
    }

    it('should parse valid XML with multiple items', () => {
      const result = parseRecognitionXml(sampleRecognitionXml);

      expect(result).toHaveLength(3);

      // First item
      expect(result[0].boundingBox).toEqual({ x: 50, y: 100, width: 200, height: 30 });
      expect(result[0].alternatives).toHaveLength(3);
      expect(result[0].alternatives[0]).toEqual({ text: 'Hello', confidence: 95 });

      // Second item
      expect(result[1].alternatives[0]).toEqual({ text: 'World', confidence: 98 });

      // Third item
      expect(result[2].alternatives[0].text).toBe('Testing OCR');
    });

    it('should handle empty XML gracefully', () => {
      const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
        <recoIndex>
        </recoIndex>`;

      const result = parseRecognitionXml(emptyXml);
      expect(result).toHaveLength(0);
    });

    it('should handle null/undefined input', () => {
      expect(parseRecognitionXml('')).toHaveLength(0);
      expect(parseRecognitionXml(null as any)).toHaveLength(0);
      expect(parseRecognitionXml(undefined as any)).toHaveLength(0);
    });

    it('should handle items with no text alternatives', () => {
      const xmlNoText = `<recoIndex>
        <item x="10" y="20" w="100" h="50">
        </item>
      </recoIndex>`;

      const result = parseRecognitionXml(xmlNoText);
      expect(result).toHaveLength(1);
      expect(result[0].alternatives).toHaveLength(0);
    });

    it('should preserve numeric types for coordinates and confidence', () => {
      const result = parseRecognitionXml(sampleRecognitionXml);

      expect(typeof result[0].boundingBox.x).toBe('number');
      expect(typeof result[0].boundingBox.y).toBe('number');
      expect(typeof result[0].boundingBox.width).toBe('number');
      expect(typeof result[0].boundingBox.height).toBe('number');
      expect(typeof result[0].alternatives[0].confidence).toBe('number');
    });

    it('should handle single alternative correctly', () => {
      const singleAltXml = `<recoIndex>
        <item x="0" y="0" w="100" h="20">
          <t w="99">OnlyOne</t>
        </item>
      </recoIndex>`;

      const result = parseRecognitionXml(singleAltXml);
      expect(result).toHaveLength(1);
      expect(result[0].alternatives).toHaveLength(1);
      expect(result[0].alternatives[0]).toEqual({ text: 'OnlyOne', confidence: 99 });
    });

    it('should extract all text from multiple items', () => {
      const result = parseRecognitionXml(sampleRecognitionXml);

      const allText = result
        .map((item) => item.alternatives[0]?.text)
        .filter(Boolean)
        .join(' ');

      expect(allText).toBe('Hello World Testing OCR');
    });
  });

  describe('Buffer to String Conversion', () => {
    it('should handle Buffer input correctly', () => {
      const buffer = Buffer.from(sampleRecognitionXml);
      const converted = buffer.toString('utf-8');

      expect(converted).toContain('<recoIndex');
      expect(converted).toContain('Hello');
    });

    it('should handle empty Buffer', () => {
      const buffer = Buffer.from('');
      const converted = buffer.toString('utf-8');

      expect(converted).toBe('');
    });
  });
});
