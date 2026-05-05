import { and, eq, like } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { lookupRemoteUserByHomeId } from './federationLookup.js';
import { extractDomain } from '../routes/federation.js';

/**
 * For each replicated stub on this instance whose username still matches the
 * legacy `<homeUserId>@<domain>` pattern AND whose home_instance equals the
 * given peer's domain, ask the peer for the canonical username via
 * lookupRemoteUserByHomeId and rewrite the stub.
 *
 * Idempotent — stubs already migrated (username does not start with their
 * homeUserId) are skipped without a network call.
 *
 * Gated on peer.status='active' — the lookup endpoint requires the requesting
 * peer to be active on the receiving side. We additionally check our local
 * peer row here so we don't waste outbound RTTs on peers we know aren't ready.
 *
 * Called from onPeerActivated (per-origin, gated on peer status='active') and
 * from a one-shot startup pass for any peer already active at boot.
 */
export async function backfillStubUsernamesForPeer(peerOrigin: string): Promise<void> {
  const db = getDb();
  const peerDomain = extractDomain(peerOrigin);

  const peer = db
    .select({ status: schema.federationPeers.status })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, peerOrigin))
    .get();
  if (!peer || peer.status !== 'active') return;

  // Coarse SQL prefilter: stubs from this peer whose username ends with @peerDomain.
  // We then narrow in JS to the legacy `<homeUserId>@<domain>` shape because Drizzle
  // can't express that comparison portably.
  const candidates = db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.homeInstance, peerDomain),
        eq(schema.users.isDeleted, 0),
        like(schema.users.username, '%@' + peerDomain),
      ),
    )
    .all();

  for (const stub of candidates) {
    if (!stub.homeUserId) continue;
    const expectedLegacy = `${stub.homeUserId}@${peerDomain}`.toLowerCase();
    if (stub.username !== expectedLegacy) continue; // already migrated or non-legacy shape

    const result = await lookupRemoteUserByHomeId(peerOrigin, stub.homeUserId);
    if (!result.ok) {
      // not_found / unreachable / rate_limited — leave untouched.
      // Will retry on next onPeerActivated for this origin.
      continue;
    }

    const newUsername = `${result.username}@${peerDomain}`.toLowerCase();
    if (newUsername === stub.username) continue; // already correct

    // Collision check: another row at the target username (rare under the new
    // scheme but possible from prior partial replication).
    const collision = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.username, newUsername))
      .get();
    if (collision && collision.id !== stub.id) {
      console.warn(`[stub-backfill] username collision on ${newUsername} — leaving stub ${stub.id} as ${stub.username}`);
      continue;
    }

    // Fill displayName from result.profile if the stub has none, mirroring the
    // displayName ?? username fallback applied at hydrate / profile_update time.
    const updates: { username: string; displayName?: string; status?: 'online' | 'idle' | 'dnd' | 'offline' } = { username: newUsername };
    if (!stub.displayName) {
      updates.displayName = result.profile.displayName ?? result.username;
    }
    // Heal status too — same root issue (stub was seeded offline at creation
    // because the wire snapshot pre-dated the status field). Only overwrite
    // when the lookup tells us something specific; keep the stub's current
    // value otherwise.
    if (result.profile.status && result.profile.status !== stub.status) {
      updates.status = result.profile.status;
    }

    db.update(schema.users)
      .set(updates)
      .where(eq(schema.users.id, stub.id))
      .run();

    console.log(`[stub-backfill] rewrote stub ${stub.id}: ${stub.username} → ${newUsername}`);
  }
}
