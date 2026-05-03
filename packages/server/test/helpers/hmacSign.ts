import { createHmac, randomUUID } from 'node:crypto';

/**
 * Build federation headers for a raw S2S request. Replicates production
 * `buildFederationHeaders` from src/utils/federationAuth.ts inline — avoids
 * importing that module directly (it pulls in config.ts which requires
 * JWT_SECRET at module-load time, breaking the test process).
 *
 * Used by tests that bypass the home endpoint and hit DELETE /api/federation/identity
 * on the remote directly (#13 attribution guard, #14 idempotency).
 */
export function buildHeadersForOrigin(body: string, secret: string, claimedOrigin: string): Record<string, string> {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const payload = `${timestamp}.${nonce}.${body}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');

  return {
    'X-Federation-Signature': `sha256=${sig}`,
    'X-Federation-Origin': claimedOrigin,
    'X-Federation-Timestamp': String(timestamp),
    'X-Federation-Nonce': nonce,
    'Content-Type': 'application/json',
  };
}
