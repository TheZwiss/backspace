import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import type {
  FederationNeedsAttentionReason,
  FederationPeerStatus,
  FederationPeerStatusReason,
  FederationRejectedReason,
  ServerEvent,
} from '@backspace/shared';
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { generateSnowflake } from './snowflake.js';
import { onPeerActivated, onPeerDeactivated, type PeerActivationReason } from './federationPeerActivation.js';

/**
 * The peer state machine's only writer.
 *
 * Every write of `federation_peers.status`, `status_reason`, `initiated_by`,
 * `probe_attempts` and `last_probe_at`, and every insert and delete of a peer
 * row, goes through this module. A transition is a compare-and-set on the
 * status the caller expects, so a write computed before an await can never
 * overwrite a row something else changed meanwhile. The side effects of a
 * transition (hooks, admin and user notifications, the outbox purge) are
 * decided here from the old and new state, once, instead of at each call site.
 *
 * The state table (states, transitions, what each reader infers) is in
 * docs/systems/federation.md, "Peer state".
 */

export type PeerRow = typeof schema.federationPeers.$inferSelect;
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type DbOrTx = Db | Tx;

const PEER_STATUSES: ReadonlySet<string> = new Set<FederationPeerStatus>([
  'pending',
  'awaiting_approval',
  'active',
  'unreachable',
  'needs_attention',
  'rejected',
  'revoked',
]);

/**
 * The row's status as the union. The column is plain text; a value outside the
 * union is read as `needs_attention` (an admin has to look at it), never as a
 * state that relays or accepts a handshake.
 */
export function peerStatusOf(row: Pick<PeerRow, 'status'>): FederationPeerStatus {
  return PEER_STATUSES.has(row.status) ? (row.status as FederationPeerStatus) : 'needs_attention';
}

/** The row's reason as the union (the column is plain text). */
export function peerStatusReasonOf(row: Pick<PeerRow, 'statusReason'>): FederationPeerStatusReason | null {
  return (row.statusReason as FederationPeerStatusReason | null) ?? null;
}

/**
 * Why a row leaves a status for anything but `active`. Logged by the
 * deactivation hook; `network_threshold` is the outbox worker's
 * PEER_UNREACHABLE_THRESHOLD transition.
 */
export type PeerExitCause =
  | 'network_threshold'
  | 'auth_threshold'
  | 'admin_revoked'
  | 'reset_detected'
  | 'remote_refused'
  | 'remote_denied_request'
  | 'stale_peering'
  | 'handshake_queued'
  | 'repeer_unverified'
  | 'local_admin_denied'
  | 'admin_claimed'
  | 'handshake_released'
  | 'retry_after_remote_reset';

/** Row fields a transition may write alongside the state. */
export type PeerRowFields = Partial<Pick<PeerRow,
  | 'hmacSecret'
  | 'instanceName'
  | 'peerInstanceId'
  | 'observedPeerInstanceId'
  | 'approvalToken'
  | 'lastSeenAt'
  | 'lastFailureAt'
  | 'consecutiveFailures'
  | 'consecutiveAuthFailures'
  | 'initiatedBy'
>>;

interface TransitionBase {
  /** Compare-and-set: the transition applies only while the row is in one of these. */
  from: readonly FederationPeerStatus[];
  /** Also require the row to still hold this secret (the handshake paths). */
  expectSecret?: string;
  fields?: PeerRowFields;
}

export type PeerTransition =
  | (TransitionBase & { to: 'active'; cause: PeerActivationReason })
  | (TransitionBase & { to: 'needs_attention'; reason: FederationNeedsAttentionReason; cause: PeerExitCause })
  | (TransitionBase & { to: 'rejected'; reason: FederationRejectedReason; cause: PeerExitCause })
  | (TransitionBase & { to: 'pending' | 'awaiting_approval' | 'unreachable' | 'revoked'; cause: PeerExitCause });

export interface PeerStateSnapshot {
  id: string;
  origin: string;
  status: FederationPeerStatus;
  statusReason: FederationPeerStatusReason | null;
  hmacSecret: string;
  initiatedBy: PeerRow['initiatedBy'];
}

export type PeerTransitionOutcome =
  | { applied: true; previous: FederationPeerStatus; done: Promise<void> }
  | { applied: false; current: PeerStateSnapshot | null };

/** Statuses whose attempts are paced; entering one starts the pacing afresh. */
const PACED_STATUSES: ReadonlySet<FederationPeerStatus> = new Set(['pending', 'unreachable']);

/** What a committed transition still has to do outside the database. */
export interface TransitionEffects {
  peerId: string;
  origin: string;
  previous: FederationPeerStatus | null;
  next: FederationPeerStatus | null;
  reason: FederationPeerStatusReason | null;
  activation: PeerActivationReason | null;
  exit: PeerExitCause | null;
  /** Contexts that had outbox entries when the row was refused (for the user notice). */
  refusedContexts: Map<string, string> | null;
}

function snapshot(row: PeerRow | undefined): PeerStateSnapshot | null {
  if (!row) return null;
  return {
    id: row.id,
    origin: row.origin,
    status: peerStatusOf(row),
    statusReason: peerStatusReasonOf(row),
    hmacSecret: row.hmacSecret,
    initiatedBy: row.initiatedBy,
  };
}

/** The current state of a peer row, or null when it does not exist. */
export function readPeerState(peerId: string, db: DbOrTx = getDb()): PeerStateSnapshot | null {
  return snapshot(db.select().from(schema.federationPeers).where(eq(schema.federationPeers.id, peerId)).get());
}

/** The current state of the peer row for an origin, or null. */
export function readPeerStateByOrigin(origin: string, db: DbOrTx = getDb()): PeerStateSnapshot | null {
  return snapshot(db.select().from(schema.federationPeers).where(eq(schema.federationPeers.origin, origin)).get());
}

/** Map of contextId → contextType for every outbox entry queued against a peer. */
function queuedContexts(db: DbOrTx, peerId: string): Map<string, string> {
  const entries = db
    .select({ contextId: schema.federationOutbox.contextId, contextType: schema.federationOutbox.contextType })
    .from(schema.federationOutbox)
    .where(eq(schema.federationOutbox.peerId, peerId))
    .all();
  const contexts = new Map<string, string>();
  for (const e of entries) {
    if (!contexts.has(e.contextId)) contexts.set(e.contextId, e.contextType);
  }
  return contexts;
}

function reasonOf(t: PeerTransition): FederationPeerStatusReason | null {
  return t.to === 'needs_attention' || t.to === 'rejected' ? t.reason : null;
}

/**
 * Apply a transition inside the caller's transaction. The caller must run the
 * returned outcome's effects after its transaction commits: `transitionPeer`
 * does both, and is what every caller outside a larger transaction uses.
 */
export function applyPeerTransition(
  db: DbOrTx,
  peerId: string,
  t: PeerTransition,
): { applied: true; previous: FederationPeerStatus; effects: TransitionEffects } | { applied: false; current: PeerStateSnapshot | null } {
  const before = readPeerState(peerId, db);
  if (!before || !t.from.includes(before.status) || (t.expectSecret !== undefined && before.hmacSecret !== t.expectSecret)) {
    return { applied: false, current: before };
  }

  const reason = reasonOf(t);
  const pacing = before.status !== t.to && PACED_STATUSES.has(t.to) ? { probeAttempts: 0, lastProbeAt: null } : {};
  const settled = before.status !== t.to && t.to === 'active' ? { probeAttempts: 0, lastProbeAt: null } : {};

  const result = db.update(schema.federationPeers)
    .set({ ...t.fields, ...pacing, ...settled, status: t.to, statusReason: reason })
    .where(and(
      eq(schema.federationPeers.id, peerId),
      eq(schema.federationPeers.status, before.status),
      ...(t.expectSecret !== undefined ? [eq(schema.federationPeers.hmacSecret, t.expectSecret)] : []),
    ))
    .run();
  if (result.changes === 0) {
    return { applied: false, current: readPeerState(peerId, db) };
  }

  // Entering a refused state ends every queued delivery: the remote will not
  // take it, and the conversation replays from federation_mutation_log if the
  // peering comes back. The notice to the affected users names the contexts,
  // so they are read before the purge.
  let refusedContexts: Map<string, string> | null = null;
  const entersRefusal = before.status !== t.to && (t.to === 'rejected' || t.to === 'revoked');
  if (entersRefusal) {
    if (t.to === 'rejected') refusedContexts = queuedContexts(db, peerId);
    db.delete(schema.federationOutbox).where(eq(schema.federationOutbox.peerId, peerId)).run();
  } else if (t.to === 'needs_attention' && t.reason === 'auth_failures' && before.status !== 'needs_attention') {
    // Entries stay (bounded by the outbox TTL); the users are told delivery stopped.
    refusedContexts = queuedContexts(db, peerId);
  }

  return {
    applied: true,
    previous: before.status,
    effects: {
      peerId,
      origin: before.origin,
      previous: before.status,
      next: t.to,
      reason,
      activation: t.to === 'active' ? t.cause : null,
      exit: t.to === 'active' ? null : t.cause,
      refusedContexts,
    },
  };
}

/**
 * Move a peer row to a new state, compare-and-set on `t.from` (and on
 * `t.expectSecret` when given). Returns whether it applied; when it did not,
 * `current` is the row as it is now, which is the real outcome the caller
 * reports. `done` settles once the transition's hooks have run.
 */
export function transitionPeer(peerId: string, t: PeerTransition): PeerTransitionOutcome {
  const db = getDb();
  const outcome = db.transaction((tx) => applyPeerTransition(tx, peerId, t));
  if (!outcome.applied) return outcome;
  return { applied: true, previous: outcome.previous, done: runPeerTransitionEffects(outcome.effects) };
}

/**
 * Record a failed attempt on a paced row (a handshake for `pending`, a
 * reachability probe for `unreachable`): `last_probe_at` is when the attempt
 * started and `probe_attempts` counts failed attempts since the pacing began.
 * Applies only while the row is still in one of `from`.
 */
export function recordPeerAttempt(
  peerId: string,
  opts: { from: readonly FederationPeerStatus[]; startedAt: number },
): boolean {
  const result = getDb().update(schema.federationPeers)
    .set({
      probeAttempts: sql`${schema.federationPeers.probeAttempts} + 1`,
      lastProbeAt: opts.startedAt,
    })
    .where(and(
      eq(schema.federationPeers.id, peerId),
      inArray(schema.federationPeers.status, [...opts.from]),
    ))
    .run();
  return result.changes > 0;
}

export type NewPeerRow = {
  origin: string;
  hmacSecret: string;
  initiatedBy: PeerRow['initiatedBy'];
  instanceName?: string | null;
  peerInstanceId?: string | null;
  lastSeenAt?: number | null;
} & (
  | { status: 'pending' }
  | { status: 'active'; cause: PeerActivationReason }
  | { status: 'rejected'; reason: FederationRejectedReason }
);

/**
 * Insert a peer row. Returns the row, or null when a row for the origin
 * already exists (the caller re-reads and decides; nothing is overwritten).
 */
export function insertPeer(values: NewPeerRow): { row: PeerRow; done: Promise<void> } | null {
  const db = getDb();
  const now = Date.now();
  const row = db.insert(schema.federationPeers)
    .values({
      id: generateSnowflake(),
      origin: values.origin,
      hmacSecret: values.hmacSecret,
      initiatedBy: values.initiatedBy,
      instanceName: values.instanceName ?? null,
      peerInstanceId: values.peerInstanceId ?? null,
      lastSeenAt: values.lastSeenAt ?? null,
      status: values.status,
      statusReason: values.status === 'rejected' ? values.reason : null,
      createdAt: now,
    })
    .onConflictDoNothing({ target: schema.federationPeers.origin })
    .returning()
    .get();
  if (!row) return null;

  const done = runPeerTransitionEffects({
    peerId: row.id,
    origin: row.origin,
    previous: null,
    next: values.status,
    reason: values.status === 'rejected' ? values.reason : null,
    activation: values.status === 'active' ? values.cause : null,
    exit: null,
    refusedContexts: null,
  });
  return { row, done };
}

/**
 * Delete a peer row while it is still in one of `from`. With `unlessQueued`,
 * a row that has outbox entries queued against it is kept (its entries would
 * cascade away). One statement, so nothing can change between the check and
 * the delete. Returns whether the row was removed.
 */
export function removePeer(
  peerId: string,
  opts: { from: readonly FederationPeerStatus[]; unlessQueued?: boolean },
): boolean {
  const db = getDb();
  const before = readPeerState(peerId, db);
  if (!before) return false;
  const result = db.delete(schema.federationPeers)
    .where(and(
      eq(schema.federationPeers.id, peerId),
      inArray(schema.federationPeers.status, [...opts.from]),
      ...(opts.unlessQueued
        ? [notExists(
          db.select({ id: schema.federationOutbox.id })
            .from(schema.federationOutbox)
            .where(eq(schema.federationOutbox.peerId, peerId)),
        )]
        : []),
    ))
    .run();
  if (result.changes === 0) return false;
  void runPeerTransitionEffects({
    peerId,
    origin: before.origin,
    previous: before.status,
    next: null,
    reason: null,
    activation: null,
    exit: null,
    refusedContexts: null,
  });
  return true;
}

// ─── Effects ────────────────────────────────────────────────────────────────

/** English text for the `federation_peer_rejected` notice, by reason code. */
const REFUSAL_TEXT: Record<FederationPeerStatusReason, string> = {
  denied_by_local_admin: "This instance's admin declined peering with the remote instance",
  denied_by_remote: "The remote instance's admin declined peering",
  revoked_by_remote: 'The remote instance has revoked peering with this instance',
  expired_on_remote: 'The peering request expired before the remote admin answered',
  stale_peering_on_remote: 'The remote instance still holds an older peering with this instance; its admin has to reset it',
  auth_failures: 'Federation trust broke; an admin has to reset peering',
  peer_reset_detected: 'The remote instance was reinstalled; an admin has to re-peer',
  repeer_incomplete: 'Re-peering could not be verified; an admin has to reset peering',
};

/** English text for a reason, for logs, API errors and the notice fallback. */
export function peerStatusReasonText(reason: FederationPeerStatusReason): string {
  return REFUSAL_TEXT[reason];
}

/**
 * Run what a committed transition from applyPeerTransition still has to do.
 * Never rejects: callers hold the promise as `done` and most never await it,
 * so a failure here is logged instead of surfacing as an unhandled rejection.
 */
export async function runPeerTransitionEffects(e: TransitionEffects): Promise<void> {
  try {
    await runEffects(e);
  } catch (err: unknown) {
    console.error('[federation] Effects of the peer transition for %s (%s to %s) failed:', e.origin, e.previous ?? 'none', e.next ?? 'deleted', err);
  }
}

async function runEffects(e: TransitionEffects): Promise<void> {
  const { connectionManager } = await import('../ws/handler.js');
  connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });

  if (e.next === 'active' && e.previous !== 'active' && e.activation) {
    for (const uid of connectionManager.getAllOnlineUserIds()) {
      connectionManager.sendToUser(uid, { type: 'federation_peer_active' as const, peerOrigin: e.origin });
    }
    try {
      await onPeerActivated(e.peerId, e.activation);
    } catch (err: unknown) {
      console.error('[federation] onPeerActivated(%s, %s) failed:', e.peerId, e.activation, err);
    }
  }

  if (e.previous === 'active' && e.next !== null && e.next !== 'active' && e.exit) {
    try {
      await onPeerDeactivated(e.peerId, e.exit);
    } catch (err: unknown) {
      console.error('[federation] onPeerDeactivated(%s, %s) failed:', e.peerId, e.exit, err);
    }
  }

  if (e.refusedContexts && e.refusedContexts.size > 0 && e.reason) {
    pushPeerRejectedEvent(connectionManager, e.origin, e.refusedContexts, e.reason);
  }
}

/** The part of the WebSocket connection manager the notice needs. */
interface UserNotifier {
  sendToUser(userId: string, event: ServerEvent): void;
}

/**
 * Tell the local users who had something queued for a peer that it will not be
 * delivered. Sent when a peer is refused (`rejected`) or its trust broke
 * (`needs_attention` after repeated auth failures). `reasonCode` lets the
 * client show localized text; `reason` is the English fallback. Runs inside
 * runPeerTransitionEffects, so a failure is logged there.
 */
function pushPeerRejectedEvent(
  notifier: UserNotifier,
  peerOrigin: string,
  contextMap: ReadonlyMap<string, string>,
  reasonCode: FederationPeerStatusReason,
): void {
  const db = getDb();
  const affectedContexts: Array<{ contextType: 'dm' | 'friend'; contextId: string; contextLabel: string }> = [];
  const affectedUserIds = new Set<string>();

  for (const [contextId, contextType] of contextMap) {
    if (contextType === 'dm') {
      const members = db
        .select({
          userId: schema.dmMembers.userId,
          username: schema.users.username,
          displayName: schema.users.displayName,
          homeInstance: schema.users.homeInstance,
        })
        .from(schema.dmMembers)
        .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
        .where(eq(schema.dmMembers.dmChannelId, contextId))
        .all();

      affectedContexts.push({
        contextType: 'dm',
        contextId,
        contextLabel: members.map(m => m.displayName || m.username || 'Unknown').slice(0, 4).join(', '),
      });
      for (const m of members) {
        if (!m.homeInstance) affectedUserIds.add(m.userId);
      }
    } else if (contextType === 'friend') {
      // Friend context ids carry the usernames.
      affectedContexts.push({ contextType: 'friend', contextId, contextLabel: contextId });
    }
  }

  const peerRow = db
    .select({ instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, peerOrigin))
    .get();

  const event = {
    type: 'federation_peer_rejected' as const,
    peerOrigin,
    peerLabel: peerRow?.instanceName ?? undefined,
    reason: REFUSAL_TEXT[reasonCode],
    reasonCode,
    affectedContexts,
  };

  for (const userId of affectedUserIds) notifier.sendToUser(userId, event);
}

// ─── Inbound handshake decision ─────────────────────────────────────────────

export type InboundHandshakeDecision =
  | { kind: 'create' }
  | { kind: 'activate'; from: FederationPeerStatus; cause: PeerActivationReason }
  | { kind: 'queue' }
  | { kind: 'refuse_exists' }
  | { kind: 'refuse_revoked' }
  | { kind: 'refuse_denied' }
  | { kind: 'refuse_in_progress' };

/**
 * The rejected reasons that record the remote refusing us (or holding an older
 * peering with us). Only these let a remote's handshake through on a rejected
 * row; any other value is read as unknown provenance.
 */
const REMOTE_REJECTED_REASONS: ReadonlySet<FederationPeerStatusReason> = new Set<FederationRejectedReason>([
  'denied_by_remote',
  'revoked_by_remote',
  'expired_on_remote',
  'stale_peering_on_remote',
]);

export interface InboundHandshakeInput {
  row: Pick<PeerRow, 'status' | 'statusReason' | 'initiatedBy' | 'approvalToken'> | null;
  autoAccept: boolean;
  inboundToken: string | undefined;
  /** Whether this instance has its own handshake with the origin in flight. */
  ownHandshakeInFlight: boolean;
  ourOrigin: string;
  sourceOrigin: string;
}

/**
 * What `POST /api/federation/peer/accept` does for the row it finds. A pure
 * function of the row's state, provenance and the instance setting; the table
 * is in docs/systems/federation.md, "Answering a handshake".
 */
export function decideInboundHandshake(input: InboundHandshakeInput): InboundHandshakeDecision {
  const { row, autoAccept } = input;
  if (!row) return autoAccept ? { kind: 'create' } : { kind: 'queue' };

  const status = peerStatusOf(row);
  // With auto-accept off, only a local admin's decision lets a handshake in.
  const locallyAuthorized = autoAccept || row.initiatedBy === 'admin';

  // No handshake of ours with this origin has completed yet: the remote's
  // handshake is taken, except that when both sides are handshaking at once
  // the one started by the lower origin wins, on both sides.
  const acceptUncompleted = (from: FederationPeerStatus, cause: PeerActivationReason): InboundHandshakeDecision => {
    if (!locallyAuthorized) return { kind: 'queue' };
    if (input.ownHandshakeInFlight && input.ourOrigin < input.sourceOrigin) return { kind: 'refuse_in_progress' };
    return { kind: 'activate', from, cause };
  };

  switch (status) {
    case 'active':
    case 'unreachable':
    case 'needs_attention':
      return { kind: 'refuse_exists' };
    case 'revoked':
      return { kind: 'refuse_revoked' };
    case 'pending':
      return acceptUncompleted('pending', 'accept_pending');
    case 'awaiting_approval': {
      if (!locallyAuthorized) return { kind: 'queue' };
      const tokenValid =
        typeof row.approvalToken === 'string' &&
        row.approvalToken.length > 0 &&
        row.approvalToken === input.inboundToken;
      if (tokenValid) return { kind: 'activate', from: 'awaiting_approval', cause: 'accept_awaiting_approval' };
      if (autoAccept) return { kind: 'activate', from: 'awaiting_approval', cause: 'accept_awaiting_approval_fallback' };
      return { kind: 'queue' };
    }
    case 'rejected': {
      const reason = peerStatusReasonOf(row);
      if (reason === 'denied_by_local_admin') return { kind: 'refuse_denied' };
      if (reason !== null && REMOTE_REJECTED_REASONS.has(reason)) {
        // The remote refused us, or held an older peering with us; its
        // handshake now is the remote acting on that.
        return acceptUncompleted('rejected', 'accept_rejected_override');
      }
      // No reason (a row from before the reason was recorded), or one that is
      // not a rejected reason: which side refused is unknown, so the row keeps
      // the behaviour it had.
      return autoAccept ? { kind: 'activate', from: 'rejected', cause: 'accept_rejected_override' } : { kind: 'refuse_denied' };
    }
  }
}
