import { and, eq, like } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { lookupRemoteUserByHomeId } from './federationLookup.js';
import { activePeerOriginForHome } from './federationOriginResolve.js';
import { extractDomain } from '../routes/federation/identity.js';
import { applyHomeProfile, homeProfileFromAnswer } from '../routes/federation/profile.js';
import {
  announceUserUpdated,
  applyHomeHandle,
  isPlaceholderNamedStub,
  mayCarryLegacySuffix,
} from '../routes/federation/stubName.js';

type UserRow = typeof schema.users.$inferSelect;

/** What asking a row's home about it came to. */
type RefreshOutcome = 'refreshed' | 'rate_limited' | 'no_answer';

/**
 * Rows whose home is being asked right now, keyed by peer origin and
 * `homeUserId`, so a row created while the activation pass (or an earlier
 * creation) is asking about the same identity costs no second lookup.
 */
const inFlight = new Set<string>();

/**
 * Rows whose name the home confirmed in this process although it looks like a
 * pre-1.8 suffixed name (a real handle such as `kai_1`). They are not asked
 * about again until the next start, so each activation does not spend lookups
 * on them. In memory only.
 */
const handleConfirmed = new Set<string>();

/** Test hook: forget the in-flight and confirmed sets. */
export function _resetHomeRecordPulls(): void {
  inFlight.clear();
  handleConfirmed.clear();
}

function pullKey(peerOrigin: string, homeUserId: string): string {
  return `${peerOrigin}\n${homeUserId}`;
}

/** The live, attached row `id` for identity `homeUserId`, or null. */
function liveRow(id: string, homeUserId: string): UserRow | null {
  const row = getDb().select().from(schema.users).where(eq(schema.users.id, id)).get();
  if (!row || row.isDeleted === 1 || row.federationHomeOrphaned === 1) return null;
  if (!row.homeInstance || row.homeUserId !== homeUserId) return null;
  return row;
}

/**
 * Ask a row's home about it by id (`lookupRemoteUserByHomeId`) and apply the
 * answer: the handle names the row (`applyHomeHandle`), and the profile is
 * applied as the home's (`applyHomeProfile`, version-checked). An answer about
 * another id changes nothing. The row is read again once the home answered,
 * since it may have changed or gone meanwhile (a creation rolled back, a
 * merge, a deletion).
 */
async function refreshFromHome(row: UserRow, peerOrigin: string): Promise<RefreshOutcome> {
  const homeUserId = row.homeUserId;
  if (!homeUserId) return 'no_answer';

  let result: Awaited<ReturnType<typeof lookupRemoteUserByHomeId>>;
  try {
    result = await lookupRemoteUserByHomeId(peerOrigin, homeUserId);
  } catch (err) {
    // Only a peer row that vanished meanwhile; every peer failure comes back
    // as `unreachable`.
    console.warn('[federation] by-home-id lookup of %s on %s failed: %s', homeUserId, peerOrigin, (err as Error).message);
    return 'no_answer';
  }
  if (!result.ok) return result.reason === 'rate_limited' ? 'rate_limited' : 'no_answer';
  if (result.homeUserId !== homeUserId) return 'no_answer';

  const current = liveRow(row.id, homeUserId);
  if (!current) return 'no_answer';

  const db = getDb();
  const named = applyHomeHandle(current, result.username, db);
  if (named.moved) announceUserUpdated(named.moved);
  if (named.user !== current) announceUserUpdated(named.user);
  if (mayCarryLegacySuffix(named.user)) handleConfirmed.add(named.user.id);

  await applyHomeProfile(named.user, homeProfileFromAnswer(result), peerOrigin, db);
  return 'refreshed';
}

/**
 * Ask the home of a row just created for a remote user about it, in the
 * background, when that home is an active peer (`activePeerOriginForHome`).
 * The row was named and filled from whatever first mentioned the user: a
 * relayed snapshot, possibly from a third instance's stale replica, or
 * nothing. Snapshots only fill empty fields, and a `profile_update` that
 * arrived before the row existed was dropped, so without this the row keeps
 * that first state until the user edits their profile. Called by
 * `resolveOrCreateReplicatedUser` for every row it creates; a pull already
 * under way for the identity is not started twice. Never throws.
 */
export function scheduleHomeRecordPull(row: UserRow): void {
  if (!row.homeInstance || !row.homeUserId) return;
  let peerOrigin: string | null;
  try {
    peerOrigin = activePeerOriginForHome(row.homeInstance, getDb());
  } catch (err) {
    console.warn('[federation] Could not resolve the home of %s: %s', row.id, (err as Error).message);
    return;
  }
  if (!peerOrigin) return;
  const key = pullKey(peerOrigin, row.homeUserId);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  void refreshFromHome(row, peerOrigin)
    .catch((err: unknown) => {
      console.warn('[federation] Home pull for %s failed: %s', row.id, (err as Error).message);
    })
    .finally(() => inFlight.delete(key));
}

/**
 * Whether the activation pass asks a row's home about it: the row carries a
 * placeholder name (`isPlaceholderNamedStub`), has no profile version yet
 * (never had a `profile_update` or an answer applied: rows filled only from
 * snapshots, rows from before 1.8), or may carry a pre-1.8 `_<n>` name
 * (`mayCarryLegacySuffix`) the home has not confirmed in this process.
 */
function needsHomeAnswer(row: UserRow): boolean {
  if (isPlaceholderNamedStub(row)) return true;
  if (row.profileUpdatedAt === null) return true;
  return mayCarryLegacySuffix(row) && !handleConfirmed.has(row.id);
}

/**
 * The per-peer activation pass over the rows of users homed on `peerOrigin`:
 * each row that needs it (`needsHomeAnswer`) is refreshed from the home
 * (`refreshFromHome`), one lookup per row. This renames placeholder names and
 * pre-1.8 `_<n>` names by the home's answer (replicas and accounts alike, see
 * `applyHomeHandle`), and applies the home's versioned profile to rows that
 * have none, so rows a snapshot filled before 1.8, or while the home was not
 * reachable, become the home's.
 *
 * The home allows 60 lookups a minute per peer; the pass stops at the first
 * rate-limited answer and the next activation carries on. A row the home did
 * not answer for (unreachable, not found) is left for the next pass without
 * stopping the others. Rows whose home is asked already (a creation pull) are
 * skipped.
 *
 * Gated on our peer row being `active`: the lookup needs an active peering on
 * both sides. Called from `onPeerActivated` (every transition to active) and
 * the startup pass for every peer active at boot.
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

  // Coarse SQL prefilter: live rows homed on this peer, named `...@peerDomain`.
  // `needsHomeAnswer` narrows it.
  const candidates = db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.homeInstance, peerDomain),
        eq(schema.users.isDeleted, 0),
        eq(schema.users.federationHomeOrphaned, 0),
        like(schema.users.username, '%@' + peerDomain),
      ),
    )
    .all();

  for (const row of candidates) {
    if (!row.homeUserId || !needsHomeAnswer(row)) continue;
    const key = pullKey(peerOrigin, row.homeUserId);
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    let outcome: RefreshOutcome;
    try {
      outcome = await refreshFromHome(row, peerOrigin);
    } finally {
      inFlight.delete(key);
    }
    if (outcome === 'rate_limited') {
      console.log(`[federation] ${peerOrigin} rate-limited the record pass; the next activation carries on`);
      return;
    }
  }
}
