import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { buildFederationHeaders, getOurOrigin } from './federationAuth.js';
import { federationFetch } from './federationFetch.js';
import { extractDomain } from '../routes/federation/identity.js';

export type BotRevokeResult = { success: true } | { success: false; error: string };

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

/**
 * Cuts a bot off from the instances it registered on: asks each active peer to
 * tombstone the federated account (same signed S2S call as account deletion,
 * DELETE /api/federation/identity). The host's JWT for that account dies with
 * the tombstone. Best effort per origin; the result says what happened.
 */
export async function revokeBotOnPeers(
  botId: string,
  origins: string[],
  mode: 'soft' | 'full',
): Promise<Record<string, BotRevokeResult>> {
  const db = getDb();
  const ourOrigin = getOurOrigin();
  const homeInstance = extractDomain(ourOrigin);
  const peers = db.select().from(schema.federationPeers).all();
  const results: Record<string, BotRevokeResult> = {};

  await Promise.all(origins.map(async (origin) => {
    const domain = extractDomain(origin).toLowerCase();
    const peer = peers.find(p => p.status === 'active' && extractDomain(p.origin).toLowerCase() === domain);
    if (!peer) {
      results[origin] = { success: false, error: 'no_active_peer' };
      return;
    }
    try {
      const body = JSON.stringify({ homeUserId: botId, homeInstance, mode });
      const headers = buildFederationHeaders(body, peer.hmacSecret, ourOrigin);
      // 'approved': the peer row above is an active federation_peers row.
      const response = await federationFetch(peer.origin, '/api/federation/identity', {
        method: 'DELETE',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      }, 'approved');
      if (response.ok) {
        results[origin] = { success: true };
        return;
      }
      let error = `HTTP ${response.status}`;
      try {
        const data = await response.json() as { error?: unknown };
        if (typeof data.error === 'string') error = data.error;
      } catch { /* keep HTTP status */ }
      results[origin] = { success: false, error };
    } catch (err) {
      results[origin] = { success: false, error: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  }));

  return results;
}
