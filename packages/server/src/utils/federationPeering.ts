import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { generateSnowflake } from './snowflake.js';
import { getOurOrigin, generateHmacSecret } from './federationAuth.js';
import { validateOrigin } from '../routes/federation.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type EnsurePeeredResult =
  | { status: 'active'; peerId: string }
  | { status: 'rejected'; error: string }
  | { status: 'failed'; error: string };

// ─── In-flight deduplication ─────────────────────────────────────────────────

const inFlightPeering = new Map<string, Promise<EnsurePeeredResult>>();

/**
 * Ensure we have an active peering relationship with the given origin.
 * If no peer exists, creates a pending record and runs the handshake.
 * Deduplicates concurrent calls for the same origin.
 *
 * Returns:
 * - { status: 'active', peerId } — peer is active (existing or newly handshaked)
 * - { status: 'rejected', error } — remote rejected auto-peering, or peer was revoked
 * - { status: 'failed', error } — transient error (network, timeout), will retry
 */
export async function ensurePeered(origin: string): Promise<EnsurePeeredResult> {
  // Validate origin format
  const normalized = validateOrigin(origin);
  if (!normalized) {
    return { status: 'failed', error: `Invalid origin: ${origin}` };
  }

  // Prevent self-peering
  const ourOrigin = getOurOrigin();
  if (normalized === ourOrigin) {
    return { status: 'failed', error: 'Cannot peer with self' };
  }

  // Check existing peer state
  const db = getDb();
  const existing = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, normalized))
    .get();

  if (existing) {
    switch (existing.status) {
      case 'active':
        return { status: 'active', peerId: existing.id };
      case 'rejected':
        return { status: 'rejected', error: 'Remote instance requires manual peering approval' };
      case 'revoked':
        return { status: 'rejected', error: 'Peer was revoked by admin' };
      case 'unreachable':
        // Unreachable peers were previously active — treat as active for peering
        // (the health check will restore them; don't re-handshake)
        return { status: 'active', peerId: existing.id };
      case 'pending':
        // Fall through to dedup logic below
        break;
    }
  }

  // Deduplicate: if a handshake is already in flight, share the promise
  const inflight = inFlightPeering.get(normalized);
  if (inflight) {
    return inflight;
  }

  // Run the handshake
  const promise = performHandshake(normalized, existing?.id, existing?.hmacSecret);
  inFlightPeering.set(normalized, promise);

  try {
    return await promise;
  } finally {
    inFlightPeering.delete(normalized);
  }
}

/**
 * Perform the actual handshake with a remote instance.
 * Creates a pending peer if one doesn't exist, then POSTs to peer/accept.
 */
async function performHandshake(
  origin: string,
  existingPeerId?: string,
  existingSecret?: string,
): Promise<EnsurePeeredResult> {
  const db = getDb();
  const ourOrigin = getOurOrigin();

  // Reuse existing pending peer's secret, or generate a new one
  const hmacSecret = existingSecret || generateHmacSecret();
  let peerId = existingPeerId;

  if (!peerId) {
    // Create pending peer placeholder
    peerId = generateSnowflake();
    db.insert(schema.federationPeers)
      .values({
        id: peerId,
        origin,
        hmacSecret,
        status: 'pending',
        createdAt: Date.now(),
      })
      .run();
  }

  try {
    const response = await fetch(`${origin}/api/federation/peer/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceOrigin: ourOrigin,
        hmacSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      // Activate the peer
      db.update(schema.federationPeers)
        .set({ status: 'active', lastSeenAt: Date.now() })
        .where(eq(schema.federationPeers.id, peerId))
        .run();
      return { status: 'active', peerId };
    }

    // Check for explicit rejection (autoAcceptPeering = 0)
    let code: string | undefined;
    let errorMessage = `Remote rejected peering (HTTP ${response.status})`;
    try {
      const body = (await response.json()) as { error?: string; code?: string };
      if (body.error) errorMessage = body.error;
      code = body.code;
    } catch {
      // Ignore parse failures
    }

    if (response.status === 403 && code === 'PEERING_REQUIRES_APPROVAL') {
      // Explicit rejection — set rejected status (sticky)
      db.update(schema.federationPeers)
        .set({ status: 'rejected' })
        .where(eq(schema.federationPeers.id, peerId))
        .run();
      return { status: 'rejected', error: errorMessage };
    }

    // Other errors (4xx, 5xx) — transient, clean up pending peer
    if (!existingPeerId) {
      db.delete(schema.federationPeers)
        .where(eq(schema.federationPeers.id, peerId))
        .run();
    }
    return { status: 'failed', error: errorMessage };
  } catch (err: unknown) {
    // Network or timeout error — transient, clean up pending peer
    if (!existingPeerId) {
      db.delete(schema.federationPeers)
        .where(eq(schema.federationPeers.id, peerId))
        .run();
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return { status: 'failed', error: 'Remote instance did not respond within 10 seconds' };
    }
    return { status: 'failed', error: `Failed to reach remote instance: ${message}` };
  }
}

/** Clear in-flight peering map (for tests). */
export function _clearInFlightPeering(): void {
  inFlightPeering.clear();
}
