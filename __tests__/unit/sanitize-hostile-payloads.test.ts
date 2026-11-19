/**
 * Hostile-payload regression tests for the markdown -> ENML sanitizer.
 *
 * sanitize-html was pinned to 2.17.5 until issue #82 (Node >=22.12 + Jest ESM)
 * let us take 2.17.6+. Those releases fixed advisories around svg, math,
 * textarea, xmp, meta, noscript, iframe and SVG animation tags. None of them
 * are in our allowedTags, and these payloads must keep producing no live
 * markup, event handlers or script URLs on whichever version is installed.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import semver from 'semver';
import { markdownToENML } from '../../src/markdown.js';

const installedSanitizeHtml: string = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../node_modules/sanitize-html/package.json'), 'utf-8'),
).version;

const payloads: Record<string, string> = {
  script: '<script>alert(1)</script>',
  'img onerror': '<img src=x onerror="alert(1)">',
  'svg onload': '<svg onload="alert(1)"><circle r="1"/></svg>',
  'svg animate href': '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>',
  'svg set': '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
  'math mxss': '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  'textarea breakout': '<textarea></textarea><img src=x onerror=alert(1)></textarea>',
  'xmp breakout': '<xmp></xmp><img src=x onerror=alert(1)></xmp>',
  'noscript breakout': '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  'meta refresh': '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  iframe: '<iframe src="javascript:alert(1)"></iframe>',
  'iframe srcdoc': '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  'style tag': '<style>@import "javascript:alert(1)";</style>',
  'object embed': '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
};

const forbiddenMarkup = [
  /<script/i,
  /<svg/i,
  /<math/i,
  /<animate/i,
  /<set[\s>/]/i,
  /<textarea/i,
  /<xmp/i,
  /<noscript/i,
  /<meta/i,
  /<iframe/i,
  /<style/i,
  /<object/i,
  /<embed/i,
  /<img/i, // images only become <en-media> via the resource pipeline
  /\son\w+\s*=/i,
  /(href|src|srcdoc|data|values|to)\s*=\s*["']?\s*javascript:/i,
];

describe('sanitize-html hostile payloads', () => {
  it('runs on an unpinned sanitize-html >= 2.17.6', () => {
    expect(semver.gte(installedSanitizeHtml, '2.17.6')).toBe(true);
  });

  it.each(Object.entries(payloads))('neutralises %s', (_name, payload) => {
    for (const markdown of [payload, `Intro paragraph\n\n${payload}\n\nOutro`]) {
      const { enml } = markdownToENML(markdown);
      const leaked = forbiddenMarkup.filter((re) => re.test(enml));
      expect({ enml, leaked }).toEqual({ enml, leaked: [] });
    }
  });
});
