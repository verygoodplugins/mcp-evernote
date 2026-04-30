/**
 * Tests for webhook HMAC signing (H5).
 */
import {
  computeWebhookSignature,
  verifyWebhookSignature,
} from '../../src/webhook';
import { createHmac } from 'crypto';

describe('webhook HMAC signing (H5)', () => {
  const testSecret = 'test-secret-key-123';
  const testBody = '{"source":"mcp-evernote","changes":[]}';

  it('computes correct HMAC-SHA256 signature', () => {
    const expected =
      'sha256=' +
      createHmac('sha256', testSecret).update(testBody).digest('hex');
    const result = computeWebhookSignature(testBody, testSecret);
    expect(result).toBe(expected);
  });

  it('signature format is sha256=<hex>', () => {
    const result = computeWebhookSignature(testBody, testSecret);
    expect(result).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('different secrets produce different signatures', () => {
    const sig1 = computeWebhookSignature(testBody, 'secret-1');
    const sig2 = computeWebhookSignature(testBody, 'secret-2');
    expect(sig1).not.toBe(sig2);
  });

  it('different bodies produce different signatures', () => {
    const sig1 = computeWebhookSignature('body-1', testSecret);
    const sig2 = computeWebhookSignature('body-2', testSecret);
    expect(sig1).not.toBe(sig2);
  });

  it('verifyWebhookSignature returns true for matching signature', () => {
    const sig = computeWebhookSignature(testBody, testSecret);
    expect(verifyWebhookSignature(testBody, sig, testSecret)).toBe(true);
  });

  it('verifyWebhookSignature returns false for wrong signature', () => {
    expect(
      verifyWebhookSignature(testBody, 'sha256=wrong', testSecret),
    ).toBe(false);
  });

  it('verifyWebhookSignature returns false for wrong secret', () => {
    const sig = computeWebhookSignature(testBody, testSecret);
    expect(verifyWebhookSignature(testBody, sig, 'wrong-secret')).toBe(
      false,
    );
  });
});
