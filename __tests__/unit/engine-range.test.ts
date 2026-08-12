import { readFileSync } from 'fs';
import { resolve } from 'path';
import semver from 'semver';

/**
 * package.json `engines.node` exists to mirror what pdf-parse actually supports.
 * That range is disjoint (`>=20.16.0 <21 || >=22.3.0`), so a naive `>=20.16.0`
 * silently claims support for Node 21.x and 22.0-22.2 — versions where an
 * engine-strict install fails or PDF extraction is unavailable.
 *
 * CI cannot catch this on its own: the matrix pins `22.x`, which resolves to a
 * current 22 release well past 22.3. So this test pins the invariant directly
 * against the installed dependency, and fails when pdf-parse widens or narrows
 * its own range.
 */

const readJson = (path: string) => JSON.parse(readFileSync(resolve(__dirname, path), 'utf-8'));

const ourRange: string = readJson('../../package.json').engines.node;
const pdfParseRange: string = readJson('../../node_modules/pdf-parse/package.json').engines.node;

// Sampled across every boundary in either range, plus the gaps between them.
const probeVersions = [
  '18.18.0',
  '20.15.0',
  '20.16.0',
  '20.19.0',
  '21.0.0',
  '21.7.3',
  '22.0.0',
  '22.2.0',
  '22.3.0',
  '22.14.0',
  '24.0.0',
  '24.15.0',
];

describe('package.json engines.node', () => {
  it('is a valid semver range', () => {
    expect(semver.validRange(ourRange)).not.toBeNull();
  });

  it('never claims support for a Node version pdf-parse rejects', () => {
    const overclaimed = probeVersions.filter(
      (v) => semver.satisfies(v, ourRange) && !semver.satisfies(v, pdfParseRange)
    );

    expect(overclaimed).toEqual([]);
  });

  it('matches the range pdf-parse declares', () => {
    // Kept as an exact match rather than a subset check: if pdf-parse widens its
    // support we want to widen too, not silently keep excluding Node versions.
    expect(ourRange).toBe(pdfParseRange);
  });

  it('still admits the versions CI exercises', () => {
    for (const v of ['20.16.0', '22.14.0', '24.15.0']) {
      expect(semver.satisfies(v, ourRange)).toBe(true);
    }
  });
});
