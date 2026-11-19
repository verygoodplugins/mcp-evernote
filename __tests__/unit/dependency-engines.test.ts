import { readFileSync } from 'fs';
import { resolve } from 'path';
import semver from 'semver';

/**
 * Every runtime dependency must support the whole Node range this package
 * declares in `engines.node`.
 *
 * Why this exists: sanitize-html 2.17.6+ moved to ESM-only htmlparser2 and
 * declared `node >=22.12.0`. A routine Dependabot security bump pulled it in
 * while we still supported Node 20.16, which broke `require('sanitize-html')`
 * there. The floor is now 22.12 (issue #82), but the same trap applies to any
 * future bump that raises a dependency's floor above ours: this test turns it
 * into one clear failure naming the package.
 */

const readJson = (path: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, path), 'utf-8'));

const pkg = readJson('../../package.json');
const ourRange: string = pkg.engines.node;
const runtimeDeps = Object.keys(pkg.dependencies ?? {});

describe('runtime dependency engines', () => {
  it.each(runtimeDeps)('%s supports the full declared Node range', (dep) => {
    const depEngines: string | undefined = readJson(`../../node_modules/${dep}/package.json`).engines?.node;
    if (!depEngines) return; // no declared constraint

    expect({ dep, installedRange: depEngines, supported: semver.subset(ourRange, depEngines) }).toEqual({
      dep,
      installedRange: depEngines,
      supported: true,
    });
  });
});
