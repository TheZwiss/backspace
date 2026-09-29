import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { generateSnowflake } from './snowflake.js';
import { getOurOrigin, generateHmacSecret } from './federationAuth.js';
import { validateOrigin } from '../routes/federation.js';
import type { EnsurePeeredCallerIntent } from '@backspace/shared';
import {
  insertPeer,
  peerStatusOf,
  peerStatusReasonOf,
  peerStatusReasonText,
  removePeer,
  transitionPeer,
  type PeerRow,
} from './federationPeerState.js';
import { probeEpoch } from './federationEpoch.js';
import { runOutboundHandshake, type HandshakeOutcome } from './federationHandshake.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type EnsurePeeredResult =
  | { status: 'active'; peerId: string }
  | { status: 'rejected'; error: string }
  | { status: 'failed'; error: string }
  | { status: 'pending'; error: string }
  | { status: 'admin_required'; error: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * When the outbound gate fires for a `user_action` intent, upsert the
 * `peer_approval_requests` (parent, keyed on origin+direction='outbound')
 * and `peer_approval_subscribers` (per-user, keyed on parent+user+reason+target)
 * rows, then broadcast WS events so the admin queue and the user's pending
 * list refresh. Idempotent: repeated calls for the same (origin, user, reason,
 * target) refresh `created_at` rather than creating duplicate rows.
 *
 * NOTE: parent row is created with `hmac_secret = NULL`. The CHECK constraint
 * permits this for `direction='outbound'`. The approve handler generates fresh
 * HMAC at the moment it actually sends `/peer/accept` to the remote.
 */
async function queueOutboundApproval(
  origin: string,
  intent: Extract<EnsurePeeredCallerIntent, { kind: 'user_action' }>,
): Promise<void> {
  const db = getDb();
  const now = Date.now();

  // Upsert parent row keyed on (origin, direction='outbound').
  let parent = db
    .select()
    .from(schema.peerApprovalRequests)
    .where(
      and(
        eq(schema.peerApprovalRequests.origin, origin),
        eq(schema.peerApprovalRequests.direction, 'outbound'),
      ),
    )
    .get();

  if (!parent) {
    const id = generateSnowflake();
    db.insert(schema.peerApprovalRequests)
      .values({
        id,
        origin,
        direction: 'outbound',
        instanceName: null,
        hmacSecret: null,
        requestedAt: now,
        expiresAt: now + THIRTY_DAYS_MS,
        approvalToken: null,
      })
      .run();
    parent = db
      .select()
      .from(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, id))
      .get()!;
  }

  // Upsert subscriber row.
  const existingSub = db
    .select({ id: schema.peerApprovalSubscribers.id })
    .from(schema.peerApprovalSubscribers)
    .where(
      and(
        eq(schema.peerApprovalSubscribers.requestId, parent.id),
        eq(schema.peerApprovalSubscribers.userId, intent.userId),
        eq(schema.peerApprovalSubscribers.triggerReason, intent.reason),
        eq(schema.peerApprovalSubscribers.triggerTarget, intent.target),
      ),
    )
    .get();

  if (existingSub) {
    db.update(schema.peerApprovalSubscribers)
      .set({ createdAt: now })
      .where(eq(schema.peerApprovalSubscribers.id, existingSub.id))
      .run();
  } else {
    db.insert(schema.peerApprovalSubscribers)
      .values({
        id: generateSnowflake(),
        requestId: parent.id,
        userId: intent.userId,
        triggerReason: intent.reason,
        triggerTarget: intent.target,
        createdAt: now,
      })
      .run();
  }

  // Broadcast: admins refresh queue; the calling user refreshes pending list.
  // Dynamic import is the existing circular-dep workaround in this file
  // (see ws/handler.js imports later). Keep it consistent.
  const { connectionManager } = await import('../ws/handler.js');
  connectionManager.sendToAdmins({
    type: 'federation_approval_request_received' as const,
    origin,
    instanceName: undefined,
  });
  connectionManager.sendToUser(intent.userId, {
    type: 'peering_subscription_changed' as const,
  });
}

/**
 * The outbound-peering gate, expressed for callers that cannot `await`
 * `ensurePeered()`.
 *
 * `ensurePeered()` refuses to bring a brand-new origin into `federation_peers`
 * when the local admin has not authorized outbound peering (see the two guards
 * inside it). Any other code path that inserts a `pending` row for an unknown
 * origin silently defeats that: `resolvePendingPeers()` finds the row, calls
 * `ensurePeered()`, which now sees `existing` and skips the gate entirely — and
 * the remote's inbound `/peer/accept` reads the same row as proof that our
 * admin initiated peering. So placeholder creation lives here, next to the gate
 * it has to obey, rather than being re-derived at each call site.
 *
 * Returns the created row, or `null` when the gate refuses. A refusal is not a
 * lost message: DM mutations are journalled in `federation_mutation_log`
 * independently of the outbox and replay when the peer is activated later.
 *
 * The row is tagged `initiatedBy: 'auto'` — it records local traffic, never an
 * admin decision.
 */
export function createAutoPlaceholderPeer(
  origin: string,
): typeof schema.federationPeers.$inferSelect | null {
  const db = getDb();

  // Guard 1 (mirrors the `pendingInbound` check in ensurePeered): the remote
  // already asked to peer and our admin has not ruled on it. Creating a row
  // now would answer that question on the admin's behalf.
  const pendingInbound = db
    .select({ id: schema.peerApprovalRequests.id })
    .from(schema.peerApprovalRequests)
    .where(
      and(
        eq(schema.peerApprovalRequests.origin, origin),
        eq(schema.peerApprovalRequests.direction, 'inbound'),
      ),
    )
    .get();

  if (pendingInbound) {
    console.warn(
      `[federation] placeholder peer for ${origin} suppressed: inbound peering approval still pending`,
    );
    return null;
  }

  // Guard 2 (mirrors the outbound gate in ensurePeered for `system` intent):
  // with auto-accept off, outbound peering needs an admin decision. The outbox
  // has no acting user to attribute an approval request to, so it refuses
  // outright, exactly as ensurePeered does for a `system` intent.
  const settings = db
    .select({ autoAcceptPeering: schema.instanceSettings.autoAcceptPeering })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.id, 1))
    .get();

  if ((settings?.autoAcceptPeering ?? 1) === 0) {
    console.warn(
      `[federation] placeholder peer for ${origin} suppressed: outbound peering requires admin approval on this instance`,
    );
    return null;
  }

  const inserted = insertPeer({ origin, hmacSecret: generateHmacSecret(), initiatedBy: 'auto', status: 'pending' });
  if (inserted) return inserted.row;
  // A row for the origin appeared since the caller looked: use it.
  return db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, origin))
    .get() ?? null;
}

// ─── Settled peer rows ──────────────────────────────────────────────────────

/**
 * The answer `ensurePeered` gives for a peer row whose status is settled, or
 * `null` for a `pending` row, which still needs a handshake (or the gate).
 * Settled answers are read from the row alone: no network, no writes.
 */
function settledResultFor(
  peer: Pick<PeerRow, 'id' | 'status' | 'statusReason'>,
): EnsurePeeredResult | null {
  switch (peerStatusOf(peer)) {
    case 'active':
      return { status: 'active', peerId: peer.id };
    case 'unreachable':
      // Unreachable peers were active: treat as active for peering (the
      // recovery probe restores them; a handshake would be refused anyway).
      return { status: 'active', peerId: peer.id };
    case 'rejected': {
      const reason = peerStatusReasonOf(peer);
      return {
        status: 'rejected',
        error: reason ? peerStatusReasonText(reason) : 'Remote instance requires manual peering approval',
      };
    }
    case 'revoked':
      return { status: 'rejected', error: 'Peer was revoked by admin' };
    case 'needs_attention': {
      // Admin intervention required: never auto-healed by a handshake.
      const reason = peerStatusReasonOf(peer);
      return { status: 'rejected', error: reason ? peerStatusReasonText(reason) : 'Peer in needs_attention; an admin has to reset it' };
    }
    case 'awaiting_approval':
      return { status: 'pending', error: 'Awaiting admin approval on remote instance' };
    case 'pending':
      // Still needs a handshake (or the gate).
      return null;
  }
}

/**
 * What `ensurePeered(origin)` would answer without doing any work, or `null`
 * when it would have to handshake or run the outbound gate. Lets
 * `POST /api/federation/peer/ensure` confirm an existing peering without
 * charging the caller's rate limit, which exists to bound handshakes.
 */
export function settledPeeringResult(origin: string): EnsurePeeredResult | null {
  const normalized = validateOrigin(origin);
  if (!normalized) return null;
  const peer = getDb()
    .select({
      id: schema.federationPeers.id,
      status: schema.federationPeers.status,
      statusReason: schema.federationPeers.statusReason,
    })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, normalized))
    .get();
  return peer ? settledResultFor(peer) : null;
}

// ─── In-flight deduplication ─────────────────────────────────────────────────

const inFlightPeering = new Map<string, Promise<EnsurePeeredResult>>();

/**
 * Origins an admin's `POST /peer/initiate` is handshaking with right now. That
 * route runs its own exchange instead of going through ensurePeered, so it
 * claims the origin here; while the claim is held ensurePeered starts no
 * handshake of its own for that origin. Two `/peer/accept` requests in flight
 * with the same origin race on the remote, and the loser's answer (409
 * PEER_EXISTS_RESET_REQUIRED) makes /peer/initiate discard its row.
 */
const adminHandshakes = new Set<string>();

/**
 * Whether a handshake with `origin` is in flight on this instance, from
 * ensurePeered or from an admin's /peer/initiate. `origin` must be normalized
 * (validateOrigin), as both maps are keyed by the normalized origin.
 */
export function isHandshakeInFlight(origin: string): boolean {
  return inFlightPeering.has(origin) || adminHandshakes.has(origin);
}

/**
 * Claim `origin` for an admin-initiated handshake. Returns false, claiming
 * nothing, when a handshake with it is already in flight. A successful claim
 * must be released with releaseAdminHandshake once the exchange has settled.
 */
export function claimAdminHandshake(origin: string): boolean {
  if (isHandshakeInFlight(origin)) return false;
  adminHandshakes.add(origin);
  return true;
}

/** Release a claim taken with claimAdminHandshake. */
export function releaseAdminHandshake(origin: string): void {
  adminHandshakes.delete(origin);
}

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
export async function ensurePeered(
  origin: string,
  intent: EnsurePeeredCallerIntent,
): Promise<EnsurePeeredResult> {
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
    const settled = settledResultFor(existing);
    if (settled) return settled;
  }

  // An admin's /peer/initiate owns this origin's handshake right now. Its
  // outcome settles the row; a second exchange would only race it, and
  // neither gate below may act on the row while the admin's exchange runs.
  if (adminHandshakes.has(normalized)) {
    return { status: 'failed', error: 'An admin-initiated handshake with this instance is in progress' };
  }

  // Pre-handshake gate: refuse if we have an unresolved inbound approval-request
  // for this origin. The local admin must approve or deny it first. Without this
  // check, any code path calling ensurePeered (e.g., the silent auto-reconnect
  // in stores/instanceStore.ts) could bypass autoAcceptPeering=0 by initiating a
  // fresh handshake to the remote, which the remote then accepts against its
  // existing awaiting_approval row (routes/federation.ts /peer/accept branch).
  // The legitimate approval flow (routes/federation.ts /approval-requests/:id/
  // approve) does NOT call ensurePeered — it deletes the approval-request first
  // and does its own fetch — so this guard does not block legitimate approvals.
  //
  // direction='inbound' filter: the table is bidirectional as of the outbound
  // peering gate (Task 3); outbound rows live in the same table and must NOT
  // trigger this guard. The outbound gate below (`if (!existing)` block) is
  // responsible for outbound row state.
  const pendingInbound = db
    .select({ id: schema.peerApprovalRequests.id })
    .from(schema.peerApprovalRequests)
    .where(
      and(
        eq(schema.peerApprovalRequests.origin, normalized),
        eq(schema.peerApprovalRequests.direction, 'inbound'),
      ),
    )
    .get();

  if (pendingInbound) {
    // The local admin's decision on that request settles the peering either
    // way; nothing may be sent before it.
    return {
      status: 'admin_required',
      error: 'Local admin must resolve pending peering approval before initiating',
    };
  }

  // Outbound gate: when autoAcceptPeering=0, regular-user-initiated outbound
  // becomes admin-approvable; system-initiated outbound is refused outright.
  //
  // It runs when no peer row exists, and also for a `pending` row that carries
  // no admin provenance. A settled row (active/unreachable/rejected/revoked/
  // needs_attention/awaiting_approval) returns from the switch above and never
  // reaches here, so this cannot retroactively gate an established peering —
  // `pending` is the one status that means "no handshake has ever completed",
  // where there is nothing yet to preserve and the gate's question is still
  // unanswered. Without this, a placeholder row left behind by local traffic
  // (created while auto-accept was on, or before placeholder creation was
  // gated) would still let `resolvePendingPeers` handshake our secret out to
  // that origin, which is the escalation the gate exists to prevent.
  const ungatedPlaceholder =
    existing !== undefined &&
    existing.status === 'pending' &&
    existing.initiatedBy !== 'admin';

  if (!existing || ungatedPlaceholder) {
    const settings = db
      .select({ autoAcceptPeering: schema.instanceSettings.autoAcceptPeering })
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.id, 1))
      .get();
    const autoAccept = settings?.autoAcceptPeering ?? 1;

    if (autoAccept === 0) {
      // Drop the ungated placeholder before queueing. It can no longer become a
      // peering (both this gate and the inbound /peer/accept gate refuse it), so
      // leaving it would only collide with the fresh row `handleOutboundApprove`
      // inserts when the admin says yes. Its outbox entries cascade away; the
      // conversation itself lives in `federation_mutation_log` and replays on
      // activation, the same way a rejected peer's queue is handled.
      if (ungatedPlaceholder && existing) {
        removePeer(existing.id, { from: ['pending'] });
        console.warn(
          `[federation] discarded ungated placeholder peer for ${normalized}: outbound peering requires admin approval`,
        );
      }

      if (intent.kind === 'user_action') {
        await queueOutboundApproval(normalized, intent);
        return {
          status: 'admin_required',
          error: 'Awaiting your admin\'s approval to initiate peering',
        };
      }
      // system intent — refuse without queue
      return {
        status: 'admin_required',
        error: 'Outbound peering requires admin approval on this instance',
      };
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
 * Perform the actual handshake with a remote instance: create the `pending`
 * row when there is none, then run the shared outbound handshake on it. The
 * row is inserted before the request goes out, so traffic queued while it is
 * in flight lands on it; a transient failure removes a row this attempt
 * created only when nothing was queued against it.
 */
async function performHandshake(
  origin: string,
  existingPeerId?: string,
  existingSecret?: string,
): Promise<EnsurePeeredResult> {
  const startedAt = Date.now();
  let peerId = existingPeerId;
  let hmacSecret = existingSecret;

  if (!peerId || !hmacSecret) {
    // Reaching here means the outbound gate in ensurePeered() let this
    // through, which for a brand-new origin only happens with auto-accept on,
    // so the row records local traffic, not an admin decision.
    hmacSecret = generateHmacSecret();
    const inserted = insertPeer({ origin, hmacSecret, initiatedBy: 'auto', status: 'pending' });
    if (!inserted) return { status: 'failed', error: 'A peer row for this instance appeared meanwhile; try again' };
    peerId = inserted.row.id;
  }

  // 'asserted': performHandshake only runs when no settled peer row exists,
  // and its origin reaches here from a handle a user typed (friend-add,
  // POST /peer/ensure) or from a placeholder row local traffic created. No
  // admin has named it, so it must be publicly routable.
  const outcome = await runOutboundHandshake({
    peerId,
    origin,
    hmacSecret,
    trust: 'asserted',
    activation: 'ensure_peered',
    startedAt,
    onFailure: existingPeerId ? 'keep' : 'remove_unless_queued',
  });
  return ensureResultFor(outcome);
}

/** The `ensurePeered` answer for where a handshake left the row. */
function ensureResultFor(outcome: HandshakeOutcome): EnsurePeeredResult {
  switch (outcome.kind) {
    case 'active':
      return { status: 'active', peerId: outcome.peerId };
    case 'awaiting_approval':
      return { status: 'pending', error: 'Awaiting admin approval on remote instance' };
    case 'rejected':
      return {
        status: 'rejected',
        error: outcome.reason ? peerStatusReasonText(outcome.reason) : outcome.error,
      };
    case 'needs_attention':
      return {
        status: 'rejected',
        error: outcome.reason ? peerStatusReasonText(outcome.reason) : 'Peer in needs_attention; an admin has to reset it',
      };
    case 'revoked':
      return { status: 'rejected', error: 'Peer was revoked by admin' };
    case 'failed':
      return { status: 'failed', error: outcome.error };
  }
}

/**
 * The backstop for rows parked as `rejected` / `stale_peering_on_remote`: the
 * remote answered our handshake with 409 PEER_EXISTS_RESET_REQUIRED, so it
 * holds an older peering with us that only its admin can clear. Nothing
 * retries the handshake; instead each run sends one signed /epoch per parked
 * row, which has no side effect on the remote:
 *
 * - verified: the remote holds our secret now, so the peering is whole.
 * - not_peered (403): the remote dropped its row; one handshake can land.
 *   If it fails for a transient reason the row is parked again.
 * - anything else: the remote still holds its older row; stay parked.
 *
 * The remote admin's Re-peer does not wait for this: it arrives as a
 * handshake, which /peer/accept takes on a parked row.
 */
export async function resolveStaleParkedPeers(): Promise<void> {
  const db = getDb();
  const parked = db
    .select({ id: schema.federationPeers.id, origin: schema.federationPeers.origin, hmacSecret: schema.federationPeers.hmacSecret })
    .from(schema.federationPeers)
    .where(and(
      eq(schema.federationPeers.status, 'rejected'),
      eq(schema.federationPeers.statusReason, 'stale_peering_on_remote'),
    ))
    .all();

  for (const row of parked) {
    if (isHandshakeInFlight(row.origin)) continue;
    const probe = await probeEpoch({ origin: row.origin, hmacSecret: row.hmacSecret });

    if (probe.kind === 'verified') {
      transitionPeer(row.id, {
        from: ['rejected'],
        expectSecret: row.hmacSecret,
        to: 'active',
        cause: 'stale_peering_verified',
        fields: { peerInstanceId: probe.instanceId, lastSeenAt: Date.now(), approvalToken: null },
      });
      continue;
    }

    if (probe.kind === 'not_peered') {
      const reopened = transitionPeer(row.id, {
        from: ['rejected'],
        expectSecret: row.hmacSecret,
        to: 'pending',
        cause: 'retry_after_remote_reset',
      });
      if (!reopened.applied) continue;
      // Through ensurePeered so the outbound gate still applies to the row.
      const result = await ensurePeered(row.origin, { kind: 'system' });
      if (result.status === 'failed') {
        transitionPeer(row.id, {
          from: ['pending'],
          to: 'rejected',
          reason: 'stale_peering_on_remote',
          cause: 'stale_peering',
        });
      }
    }
  }
}

/** Clear in-flight peering state (for tests). */
export function _clearInFlightPeering(): void {
  inFlightPeering.clear();
  adminHandshakes.clear();
}

/**
 * Race ensurePeered() against a deadline. On timeout, the background
 * handshake is NOT aborted — it continues so the next attempt finds
 * the peer active. A warn-logged catch is attached so a late-rejecting
 * background promise does not emit an unhandledRejection.
 *
 * The ensurePeered implementation is injectable for testing; the default
 * is the real function.
 */
export async function racePeering(
  origin: string,
  timeoutMs: number,
  intent: EnsurePeeredCallerIntent,
  ensurePeeredFn: (
    origin: string,
    intent: EnsurePeeredCallerIntent,
  ) => Promise<EnsurePeeredResult> = ensurePeered,
): Promise<EnsurePeeredResult | { status: 'timeout' }> {
  const handshake = ensurePeeredFn(origin, intent);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ status: 'timeout' }>(resolve => {
    timeoutHandle = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });

  let raceResult: EnsurePeeredResult | { status: 'timeout' };
  try {
    raceResult = await Promise.race([handshake, timeoutPromise]);
  } catch (err) {
    // ensurePeeredFn rejected as the race winner. Normalize to failed.
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const message = err instanceof Error ? err.message : 'Unknown handshake error';
    return { status: 'failed', error: message };
  }
  if (timeoutHandle) clearTimeout(timeoutHandle);

  // Only when the timeout arm won is the background handshake still running.
  // Guard its eventual rejection so we don't emit unhandledRejection.
  if (raceResult.status === 'timeout') {
    handshake.catch(err => {
      console.warn('[federation] background handshake after call-relay race:', origin, err);
    });
  }

  return raceResult;
}
