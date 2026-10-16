import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { buildFederationHeaders, getOurOrigin } from './federationAuth.js';
import { federationFetch } from './federationFetch.js';
import { extractDomain } from '../routes/federation/identity.js';

/**
 * `retry` says whether trying again later can change the answer: an unreachable
 * or not-yet-peered host can recover, an instance that refuses the request
 * (403, 409, ...) will refuse it again.
 */
export type BotRevokeResult = { success: true } | { success: false; error: string; retry: boolean };

/**
 * Origins where this bot holds a per-remote credential, i.e. where it may have
 * a federated account. Read BEFORE tombstoneUser(): the tombstone deletes them.
 */
export function collectBotFederationOrigins(botId: string): string[] {
  return getDb()
    .select({ origin: schema.userFederationCredentials.origin })
    .from(schema.userFederationCredentials)
    .where(eq(schema.userFederationCredentials.userId, botId))
    .all()
    .map(r => r.origin);
}

/** HTTP statuses a later attempt can turn into success (signature skew, overload, restart). */
function statusIsRetryable(status: number): boolean {
  return status >= 500 || status === 401 || status === 408 || status === 429;
}

/**
 * Asks one instance to tombstone the bot's federated account (same signed S2S
 * call as account deletion, DELETE /api/federation/identity). The call is
 * idempotent on the host: no live account answers 200.
 */
export async function revokeBotOnOrigin(
  botId: string,
  origin: string,
  mode: 'soft' | 'full',
): Promise<BotRevokeResult> {
  const ourOrigin = getOurOrigin();
  const domain = extractDomain(origin).toLowerCase();
  const peer = getDb().select().from(schema.federationPeers).all()
    .find(p => p.status === 'active' && extractDomain(p.origin).toLowerCase() === domain);
  if (!peer) return { success: false, error: 'no_active_peer', retry: true };
  try {
    const body = JSON.stringify({ homeUserId: botId, homeInstance: extractDomain(ourOrigin), mode });
    const headers = buildFederationHeaders(body, peer.hmacSecret, ourOrigin);
    // 'approved': the peer row above is an active federation_peers row.
    const response = await federationFetch(peer.origin, '/api/federation/identity', {
      method: 'DELETE',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    }, 'approved');
    if (response.ok) return { success: true };
    let error = `HTTP ${response.status}`;
    try {
      const data = await response.json() as { error?: unknown };
      if (typeof data.error === 'string') error = data.error;
    } catch { /* keep HTTP status */ }
    return { success: false, error, retry: statusIsRetryable(response.status) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unreachable',
      retry: true,
    };
  }
}

/**
 * Cuts a bot off from the instances it registered on, one signed call per
 * origin. The result says what happened per origin; the caller hands the
 * retryable failures to `queueBotRevocations`, which keeps trying in the
 * background (botRevocationQueue.ts).
 */
export async function revokeBotOnPeers(
  botId: string,
  origins: string[],
  mode: 'soft' | 'full',
): Promise<Record<string, BotRevokeResult>> {
  const results: Record<string, BotRevokeResult> = {};
  await Promise.all(origins.map(async (origin) => {
    results[origin] = await revokeBotOnOrigin(botId, origin, mode);
  }));
  return results;
}
