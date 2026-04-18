// Copyright (c) 2026 raffishquartan. All rights reserved.
// Licensed for personal use only.

import { createHmac } from 'crypto';

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 * Returns the signature in the format `sha256=<hex>`.
 */
export function computeWebhookSignature(body: string, secret: string): string {
  const hmac = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hmac}`;
}

/**
 * Verify a webhook signature against a payload and secret.
 */
export function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = computeWebhookSignature(body, secret);
  return signature === expected;
}
