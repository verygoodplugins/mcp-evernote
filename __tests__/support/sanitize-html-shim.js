/**
 * Jest-only compatibility shim for sanitize-html on Node < 24.9.
 *
 * sanitize-html is CommonJS, but 2.17.6+ `require()`s the ESM-only
 * htmlparser2 12. Plain Node >= 22.12 handles that natively (require(esm)),
 * so production is fine. Jest, however, loads CommonJS through its own module
 * registry and can only require() ESM on Node >= 24.9, where the synchronous
 * vm module APIs it needs exist. On older Node (i.e. the 22.x line we support)
 * it throws "Must use import to load ES Module".
 *
 * On those versions `jest.config.js` maps `sanitize-html` to a CommonJS bundle
 * of the *installed* sanitize-html (and its htmlparser2/postcss deps) that this
 * globalSetup builds with esbuild. Same code, different module format. On Node
 * >= 24.9 the shim is skipped and tests load the real package.
 */
import { build } from 'esbuild';
import { createRequire } from 'module';
import { join } from 'path';

const require = createRequire(import.meta.url);

const [major, minor] = process.versions.node.split('.').map(Number);
export const needsSanitizeHtmlShim = major < 24 || (major === 24 && minor < 9);

export const shimPath = (rootDir) => join(rootDir, 'node_modules', '.cache', 'jest-shims', 'sanitize-html.cjs');

export default async function buildSanitizeHtmlShim(_globalConfig, projectConfig) {
  if (!needsSanitizeHtmlShim) return;
  await build({
    entryPoints: [require.resolve('sanitize-html')],
    outfile: shimPath(projectConfig.rootDir),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${major}`,
    logLevel: 'error',
  });
}
