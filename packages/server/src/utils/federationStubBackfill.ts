import { and, eq, like } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { lookupRemoteUserByHomeId } from './federationLookup.js';
import { extractDomain } from '../routes/federation.js';
import { isPlaceholderNamedStub, renamePlaceholderNamedStub } from '../routes/federation/stubName.js';

/**
 * For each replicated stub on this instance that still carries a placeholder
 * name (`isPlaceholderNamedStub`: `<homeUserId>@<domain>`, or a local part that
 * is not a handle) whose home_instance equals the given peer's domain, ask the
 * peer for the canonical username via lookupRemoteUserByHomeId and rename the
 * stub (`renamePlaceholderNamedStub`, which also seeds an empty displayName and
 * a differing status from the answer).
 *
 * Such stubs come from any first contact that happened without a username
 * (the home could not be asked, or the row predates the realname scheme), and
 * from incoming calls, which named the caller after their display name until
 * the call relay stopped passing it as the username.
 * Identity resolution and hydration rename them as soon as a username arrives;
 * this pass catches the ones nothing has touched since.
 *
 * Idempotent: stubs already renamed are skipped without a network call.
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
  // `isPlaceholderNamedStub` then narrows to placeholder names because
  // Drizzle can't express that comparison portably.
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
    if (!stub.homeUserId || !isPlaceholderNamedStub(stub)) continue;

    const result = await lookupRemoteUserByHomeId(peerOrigin, stub.homeUserId);
    if (!result.ok) {
      // not_found / unreachable / rate_limited — leave untouched.
      // Will retry on next onPeerActivated for this origin.
      continue;
    }
    // The answer must be about the id we asked for.
    if (result.homeUserId !== stub.homeUserId) continue;

    renamePlaceholderNamedStub(stub, result.username, db, {
      displayName: result.profile.displayName,
      status: result.profile.status ?? null,
    });
  }
}
