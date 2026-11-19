import { readFileSync } from 'fs';
import { resolve } from 'path';
import semver from 'semver';

/**
 * package.json `engines.node` is `>=22.12`: the floor sanitize-html 2.17.6+
 * declares (it depends on ESM-only htmlparser2 and relies on `require(esm)`).
 *
 * pdf-parse still declares a disjoint range (`>=20.16.0 <21 || >=22.3.0`).
 * Our range used to mirror it exactly; now it must simply never claim a Node
 * version pdf-parse rejects. `dependency-engines.test.ts` checks the same
 * subset relation for every runtime dependency; this test additionally pins
 * the floor so it can't silently drift below 22.12 or creep upwards.
 */

const readJson = (path: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, path), 'utf-8'));

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
  '22.11.0',
  '22.12.0',
  '22.14.0',
  '24.0.0',
  '24.15.0',
];

describe('package.json engines.node', () => {
  it('is a valid semver range', () => {
    expect(semver.validRange(ourRange)).not.toBeNull();
  });

  it('has a floor of exactly 22.12.0', () => {
    expect(semver.minVersion(ourRange)?.version).toBe('22.12.0');
  });

  it('never claims support for a Node version pdf-parse rejects', () => {
    const overclaimed = probeVersions.filter(
      (v) => semver.satisfies(v, ourRange) && !semver.satisfies(v, pdfParseRange)
    );

    expect(overclaimed).toEqual([]);
    expect(semver.subset(ourRange, pdfParseRange)).toBe(true);
  });

  it('rejects Node 20, 21 and 22 before 22.12', () => {
    for (const v of ['20.16.0', '20.19.0', '21.7.3', '22.3.0', '22.11.0']) {
      expect(semver.satisfies(v, ourRange)).toBe(false);
    }
  });

  it('still admits the versions CI exercises', () => {
    for (const v of ['22.12.0', '22.14.0', '24.0.0', '24.15.0']) {
      expect(semver.satisfies(v, ourRange)).toBe(true);
    }
  });
});
