import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildToolErrorPayload } from '../../src/errors.js';
import { RateLimitBackoffError } from '../../src/request-queue.js';

/**
 * ensureAPI() wraps init failures in a plain "Not connected" Error. A rate
 * limit during (re)connect must bypass that wrapper so tool errors keep
 * errorCode / retryAfterSeconds (see PR #86 review).
 */
const indexSource = readFileSync(resolve(import.meta.dirname, '../../src/index.ts'), 'utf-8');

describe('ensureAPI rate-limit passthrough', () => {
  it('rethrows rate-limit errors before wrapping init failures', () => {
    const body = indexSource.match(/async function ensureAPI\(forceReinit[\s\S]*?\n}\n/)?.[0] ?? '';
    const passthrough = body.indexOf('getEvernoteErrorMeta(error).errorCode === RATE_LIMIT_ERROR_CODE');
    const wrap = body.indexOf('throw new Error(`Not connected: ${apiInitError}`)');
    expect(passthrough).toBeGreaterThan(-1);
    expect(wrap).toBeGreaterThan(passthrough);
  });

  it('a passed-through backoff error yields a rate_limited payload with retryAfterSeconds', () => {
    const payload: any = buildToolErrorPayload("evernote_connection", new RateLimitBackoffError(42));
    expect(JSON.stringify(payload)).toMatch(/rate_limited/);
    expect(JSON.stringify(payload)).toMatch(/"retryAfterSeconds":42/);
  });
});
