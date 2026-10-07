import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { FederationRelayEvent, FederationSyncRequest, FederationSyncResponse } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { buildFederationHeaders, getOurOrigin, normalizeOriginForCompare } from './federationAuth.js';
import { federationFetch } from './federationFetch.js';
import { dmDeleteKey, hasAppliedEvent } from './federationAppliedEvents.js';
import { isFederationRelayEnabled, MUTATION_LOG_RETENTION_MS } from './federationOutbox.js';
import { classifyPulledRejection } from './federationRejections.js';
import { friendPairClockSubject, memberClockSubject } from './federationSubjectClock.js';
import { generateSnowflake } from './snowflake.js';
import type { PeerActivationReason } from './federationPeerActivation.js';

/**
 * Pull-sync: this instance reads each active peer's mutation log through the
 * peer's `POST /api/federation/sync` and applies what it finds, so an event
 * the live relay lost (a rejection, an expired outbox row, downtime, a restore
 * from backup) reaches this instance anyway. See docs/systems/federation.md,
 * "Pull sync".
 *
 * - A cursor per (peer, context) in `federation_sync_cursors`, in the PEER's
 *   clock: the `(mutated_at, id)` of the last log row consumed, saved after
 *   every page. Each pass starts `FIRST_PAGE_OVERLAP_MS` before it, which
 *   absorbs a backward clock step on the peer; later pages continue by keyset
 *   (`afterId`), or from `checkpoint - 1` against a server that predates it.
 * - Every pulled event is applied as `catch_up` (`RelayDelivery`) and its
 *   outcome classified by `classifyPulledRejection`: a `retry` refusal is
 *   kept with the whole event in `federation_sync_retry` and replayed locally
 *   with backoff; the cursor never stops. Events are ordered per subject
 *   (`syncSubjectKey`: a message, a group member, a friend pair, ...): a
 *   subject with a kept event holds its later pulled events behind it, and
 *   other subjects never wait for it.
 * - One peer is pulled by one caller at a time (`runForPeer`): activation, the
 *   periodic tick and the retry tick queue behind each other.
 *
 * A 401/403 from the peer's `/sync` only skips that pass: peer state belongs
 * to the outbox and recovery workers.
 */

export type SyncContext = 'dm' | 'friend' | 'profile';
export type SyncReason = PeerActivationReason | 'periodic' | 'manual';

export const ALL_SYNC_CONTEXTS: readonly SyncContext[] = ['dm', 'friend', 'profile'];
/** What the periodic tick pulls. */
export const PERIODIC_SYNC_CONTEXTS: readonly SyncContext[] = ALL_SYNC_CONTEXTS;

export const SYNC_PAGE_LIMIT = 100;
export const FIRST_PAGE_OVERLAP_MS = 120_000;
export const RESYNC_INTERVAL_MS = 15 * 60_000;
export const RESYNC_FIRST_DELAY_MS = 60_000;
export const SYNC_RETRY_INTERVAL_MS = 5 * 60_000;
/** Backoff after the nth failed retry of a kept event (n = attempts). */
export const SYNC_RETRY_BACKOFF_MS: readonly number[] = [
  60_000,       // 1 min
  300_000,      // 5 min
  1_800_000,    // 30 min
  7_200_000,    // 2 h
  21_600_000,   // 6 h
  86_400_000,   // 24 h cap
];
/** A kept event older than this (since it was first kept) is dropped with a warning. */
export const SYNC_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SYNC_FETCH_TIMEOUT_MS = 30_000;

export interface SyncPeerResult {
  contexts: Partial<Record<SyncContext, 'ok' | 'http_error' | 'error'>>;
  /** Events accepted by their processor. */
  applied: number;
  /** Events refused as already held (`duplicate`, or an effect already in place). */
  duplicates: number;
  /** Events kept in `federation_sync_retry`, refused for now or held behind one that was. */
  deferred: number;
  /** Events refused for good, logged. */
  dropped: number;
}

type PeerRow = typeof schema.federationPeers.$inferSelect;
type PulledOutcome =
  | { kind: 'applied' }
  | { kind: 'taken' }
  | { kind: 'refused'; reason: string; why: string }
  | { kind: 'retry'; reason: string };

interface CursorPosition {
  ts: number;
  id: string | null;
}

// ─── Per-peer serialization ─────────────────────────────────────────────────

const peerQueues = new Map<string, Promise<unknown>>();

/** Run `fn` for `peerId` after every earlier pull or retry run for that peer. */
function runForPeer<T>(peerId: string, fn: () => Promise<T>): Promise<T> {
  const previous = peerQueues.get(peerId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  peerQueues.set(peerId, settled);
  void settled.then(() => {
    if (peerQueues.get(peerId) === settled) peerQueues.delete(peerId);
  });
  return run;
}

// ─── Cursors ────────────────────────────────────────────────────────────────

/** Whether `a` is past `b` in `(mutated_at, id)` order; a missing id sorts first. */
function isAfter(a: CursorPosition, b: CursorPosition): boolean {
  if (a.ts !== b.ts) return a.ts > b.ts;
  if (a.id === null) return false;
  if (b.id === null) return true;
  if (a.id.length !== b.id.length) return a.id.length > b.id.length;
  return a.id > b.id;
}

/**
 * Where a context's cursor starts when it has none: the whole log. Every
 * relay processor is safe to apply twice (friend events through the ledger,
 * within `friendHistoryFloor`). A peer that had synced before the upgrade got
 * every cursor from migration 0022 instead, at its `last_synced_at`.
 */
const INITIAL_CURSOR_TS = 0;

/**
 * The earliest point of a peer's log the friend context reads, or null.
 *
 * Friend events are applied once through the ledger (`federation_applied_events`),
 * which this instance keeps since `instance_settings.ledger_started_at`, the
 * upgrade that created it. A friend event applied before that cannot be
 * recognized, and applied again it acts on the pair's newer state (a declined
 * request returns). So the friend context never reads a peer's log before the
 * ledger start, whatever its cursor: a peer that last synced long before the
 * upgrade, one that never synced, and a peer row created after the upgrade
 * (re-peered after a revoke or a reset) alike, and the first page's overlap
 * stops there too. Once the ledger is older than the log's retention, every
 * row a peer can serve is newer than it and the floor is dropped. Null on an
 * instance that kept the ledger from its first boot.
 *
 * The ledger start is this instance's clock and the log the peer's; a peer
 * clock running ahead lets through friend events up to that lead before the
 * upgrade, which is the same tolerance the overlap gives.
 */
function friendHistoryFloor(now: number): number | null {
  const row = getDb().select({ ledgerStartedAt: schema.instanceSettings.ledgerStartedAt })
    .from(schema.instanceSettings)
    .get();
  const startedAt = row?.ledgerStartedAt ?? null;
  if (startedAt === null || now - startedAt > MUTATION_LOG_RETENTION_MS) return null;
  return startedAt;
}

/** Where a pass of `context` asks from: an overlap before the cursor, never before the context's floor. */
function firstRequestSince(context: SyncContext, position: CursorPosition, now: number): number {
  const since = Math.max(0, position.ts - FIRST_PAGE_OVERLAP_MS);
  if (context !== 'friend') return since;
  const floor = friendHistoryFloor(now);
  return floor === null ? since : Math.max(since, floor);
}

/**
 * Restart every cursor of `peer` at 0, and drop its kept events, when the
 * peer is a new incarnation (its instance id differs from the one the cursors
 * were taken against): its log is a different log, and its kept events were
 * another instance's word. Runs before every pull and every retry run.
 */
function reconcileCursorEpoch(peer: PeerRow): void {
  if (!peer.peerInstanceId) return;
  const db = getDb();
  const stale = db.select({ epoch: schema.federationSyncCursors.peerEpoch })
    .from(schema.federationSyncCursors)
    .where(eq(schema.federationSyncCursors.peerId, peer.id))
    .all()
    .some(row => row.epoch !== null && row.epoch !== peer.peerInstanceId);
  if (stale) {
    console.warn(`[federation-sync] ${peer.origin} is a new incarnation; restarting its sync cursors`);
    db.update(schema.federationSyncCursors)
      .set({ cursorTs: 0, cursorId: null })
      .where(eq(schema.federationSyncCursors.peerId, peer.id))
      .run();
    db.delete(schema.federationSyncRetry)
      .where(eq(schema.federationSyncRetry.peerId, peer.id))
      .run();
  }
  db.update(schema.federationSyncCursors)
    .set({ peerEpoch: peer.peerInstanceId })
    .where(eq(schema.federationSyncCursors.peerId, peer.id))
    .run();
}

function loadCursor(peer: PeerRow, context: SyncContext): CursorPosition {
  const db = getDb();
  const row = db.select()
    .from(schema.federationSyncCursors)
    .where(and(
      eq(schema.federationSyncCursors.peerId, peer.id),
      eq(schema.federationSyncCursors.contextType, context),
    ))
    .get();
  if (row) return { ts: row.cursorTs, id: row.cursorId };
  const ts = INITIAL_CURSOR_TS;
  db.insert(schema.federationSyncCursors)
    .values({ peerId: peer.id, contextType: context, cursorTs: ts, cursorId: null, peerEpoch: peer.peerInstanceId })
    .onConflictDoNothing()
    .run();
  return { ts, id: null };
}

function saveCursor(peerId: string, context: SyncContext, position: CursorPosition): void {
  getDb().update(schema.federationSyncCursors)
    .set({ cursorTs: position.ts, cursorId: position.id })
    .where(and(
      eq(schema.federationSyncCursors.peerId, peerId),
      eq(schema.federationSyncCursors.contextType, context),
    ))
    .run();
}

function markPulled(peerId: string, context: SyncContext, now: number): void {
  getDb().update(schema.federationSyncCursors)
    .set({ lastPulledAt: now })
    .where(and(
      eq(schema.federationSyncCursors.peerId, peerId),
      eq(schema.federationSyncCursors.contextType, context),
    ))
    .run();
}

// ─── Applying a pulled event ────────────────────────────────────────────────

/** An identity as a key part: home user id and normalized home origin. */
function identityKey(identity: { homeUserId?: string; homeInstance?: string } | null | undefined): [string | null, string | null] {
  const home = typeof identity?.homeInstance === 'string' ? normalizeOriginForCompare(identity.homeInstance) ?? identity.homeInstance : null;
  return [identity?.homeUserId ?? null, home];
}

/**
 * The subject a pulled event changes: the unit pulled events are ordered in.
 * Events of one subject are applied in the peer's order; a kept event holds
 * the later events of its subject behind it, and other subjects never wait
 * for it. A member or a friend pair is keyed as its subject clock is
 * (utils/federationSubjectClock.ts); an event too malformed to name its
 * subject is its own.
 */
export function syncSubjectKey(event: FederationRelayEvent): string {
  const own = JSON.stringify(['event', event.eventType, event.messageId]);
  switch (event.eventType) {
    case 'create':
    case 'update':
    case 'delete':
    case 'reaction_add':
    case 'reaction_remove':
      // The peer's id of the message, the same on every event about it.
      return JSON.stringify(['message', event.messageId]);
    case 'file_rejected':
      // A message of this instance's, named by its id here.
      return JSON.stringify(['message_here', event.messageId]);
    case 'member_add':
    case 'member_remove':
      return memberClockSubject(event.federatedId, event.membership?.user) ?? own;
    case 'friend_request_create':
    case 'friend_request_update':
    case 'friend_request_cancel':
    case 'friend_add':
    case 'friend_remove':
      return friendPairClockSubject(event.friendship?.from, event.friendship?.to) ?? own;
    case 'ownership_transfer':
    case 'group_metadata_update':
      return JSON.stringify(['group', event.federatedId ?? event.dmChannelId ?? null]);
    case 'dm_close':
    case 'dm_reopen':
      return JSON.stringify(['closed', event.federatedId ?? event.dmChannelId ?? null, ...identityKey(event.dmCloseReopen)]);
    case 'read_state_update':
      return JSON.stringify(['read', event.federatedId ?? event.dmChannelId ?? null, ...identityKey(event.readState?.user)]);
    case 'profile_update':
      return JSON.stringify(['profile', ...identityKey(event.profileUpdate)]);
    default:
      return own;
  }
}

/** The message a pulled `update` or `reaction_add` names, in its home's coordinates. */
function namedMessage(event: FederationRelayEvent, peerOrigin: string): { messageId: string; homeInstance: string } | null {
  if (event.eventType === 'update') {
    // Without a target, an older server names its own message by its id.
    if (event.target === undefined) return { messageId: event.messageId, homeInstance: peerOrigin };
    return { messageId: event.target.message.messageId, homeInstance: event.target.message.messageHomeInstance };
  }
  if (event.eventType === 'reaction_add' && event.reaction) {
    return {
      messageId: event.reaction.messageId ?? event.messageId,
      homeInstance: event.reaction.messageHomeInstance || peerOrigin,
    };
  }
  return null;
}

/**
 * Whether the message a pulled `update` or `reaction_add` answered
 * `unknown_message` names can no longer arrive here, decided from what this
 * instance knows:
 * - it is homed here: it would be held here if it existed;
 * - it is homed on the peer that served the event: the peer's log holds its
 *   create before the event, and the pull serves the log in order and holds
 *   an event behind a kept event of its message, so that create was applied
 *   (and the message deleted since), refused for good, or lies before this
 *   instance's cursor;
 * - its home's delete of it was recorded (`dmDeleteKey`).
 * A message homed on a third instance may still come from that instance, so
 * the event is kept, for at most `SYNC_RETRY_MAX_AGE_MS`.
 */
function messageCannotArrive(peer: PeerRow, event: FederationRelayEvent): boolean {
  const named = namedMessage(event, peer.origin);
  if (!named) return true;
  const home = normalizeOriginForCompare(named.homeInstance);
  if (home === null) return true;
  if (home === normalizeOriginForCompare(getOurOrigin()) || home === normalizeOriginForCompare(peer.origin)) return true;
  return hasAppliedEvent(named.homeInstance, dmDeleteKey(named.messageId));
}

async function applyPulledEvent(peer: PeerRow, event: FederationRelayEvent): Promise<PulledOutcome> {
  const { processRelayEvents } = await import('../routes/federation.js');
  const result = await processRelayEvents([event], peer.origin, peer.origin, getDb(), { delivery: 'catch_up' });
  const rejection = result.rejected.find(r => r.messageId === event.messageId) ?? result.rejected[0];
  if (!rejection) return { kind: 'applied' };
  const outcome = classifyPulledRejection(event.eventType, rejection.reason);
  if (outcome === 'taken') return { kind: 'taken' };
  if (outcome === 'refused') return { kind: 'refused', reason: rejection.reason, why: 'refused' };
  if (rejection.reason === 'unknown_message' && messageCannotArrive(peer, event)) {
    return { kind: 'refused', reason: rejection.reason, why: 'its message was refused, deleted or never served' };
  }
  return { kind: 'retry', reason: rejection.reason };
}

function hasKeptEvents(peerId: string, subjectKey: string): boolean {
  return getDb().select({ id: schema.federationSyncRetry.id })
    .from(schema.federationSyncRetry)
    .where(and(
      eq(schema.federationSyncRetry.peerId, peerId),
      eq(schema.federationSyncRetry.subjectKey, subjectKey),
    ))
    .limit(1)
    .get() !== undefined;
}

/** `value` as JSON with every object's keys sorted, so equal events serialize alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The identity of a kept event: the sha256 of its canonical JSON. */
export function syncEventHash(event: FederationRelayEvent): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

function keepEvent(
  peerId: string,
  context: SyncContext,
  subjectKey: string,
  event: FederationRelayEvent,
  reason: string,
  nextRetryAt: number,
  now: number,
): void {
  getDb().insert(schema.federationSyncRetry)
    .values({
      id: generateSnowflake(),
      peerId,
      contextType: context,
      subjectKey,
      eventType: event.eventType,
      messageId: event.messageId,
      eventTs: event.timestamp,
      eventHash: syncEventHash(event),
      eventJson: JSON.stringify(event),
      lastReason: reason,
      attempts: 1,
      firstFailedAt: now,
      nextRetryAt,
    })
    .onConflictDoNothing()
    .run();
}

function logDropped(peer: PeerRow, event: FederationRelayEvent, reason: string, why: string): void {
  console.warn(
    '[federation-sync] Dropped %s %s (ts=%s) from %s: %s (%s)',
    event.eventType, event.messageId, event.timestamp, peer.origin, why, reason,
  );
}

async function handlePulledEvent(
  peer: PeerRow,
  context: SyncContext,
  event: FederationRelayEvent,
  stats: SyncPeerResult,
): Promise<void> {
  const now = Date.now();
  const subjectKey = syncSubjectKey(event);
  if (hasKeptEvents(peer.id, subjectKey)) {
    keepEvent(peer.id, context, subjectKey, event, 'held_behind_earlier_event', now, now);
    stats.deferred += 1;
    return;
  }
  const outcome = await applyPulledEvent(peer, event);
  switch (outcome.kind) {
    case 'applied':
      stats.applied += 1;
      break;
    case 'taken':
      stats.duplicates += 1;
      break;
    case 'refused':
      logDropped(peer, event, outcome.reason, outcome.why);
      stats.dropped += 1;
      break;
    case 'retry':
      keepEvent(peer.id, context, subjectKey, event, outcome.reason, now + SYNC_RETRY_BACKOFF_MS[0]!, now);
      stats.deferred += 1;
      break;
  }
}

// ─── Pulling ────────────────────────────────────────────────────────────────

function isSyncResponse(value: unknown): value is FederationSyncResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<FederationSyncResponse>;
  return Array.isArray(v.events) && typeof v.hasMore === 'boolean' && typeof v.checkpoint === 'number'
    && (v.checkpointId === undefined || typeof v.checkpointId === 'string');
}

async function pullContext(
  peer: PeerRow,
  context: SyncContext,
  signingSecret: string,
  stats: SyncPeerResult,
): Promise<'ok' | 'http_error'> {
  const ourOrigin = getOurOrigin();
  let position = loadCursor(peer, context);
  let since = firstRequestSince(context, position, Date.now());
  let afterId: string | undefined;
  let previousRequest: string | null = null;

  for (;;) {
    const request: FederationSyncRequest = {
      sinceTimestamp: since,
      limit: SYNC_PAGE_LIMIT,
      contextType: context,
      ...(afterId !== undefined ? { afterId } : {}),
    };
    const requestKey = `${since}|${afterId ?? ''}`;
    if (requestKey === previousRequest) {
      console.warn(`[federation-sync] ${context} pull from ${peer.origin} did not advance past ${since}; stopping this pass`);
      break;
    }
    previousRequest = requestKey;

    const body = JSON.stringify(request);
    const headers = buildFederationHeaders(body, signingSecret, ourOrigin);
    const resp = await federationFetch(peer.origin, '/api/federation/sync', {
      method: 'POST', headers, body,
      signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
    }, 'approved');
    if (!resp.ok) {
      console.warn(`[federation-sync] ${context} pull from ${peer.origin}: HTTP ${resp.status}`);
      return 'http_error';
    }
    const data: unknown = await resp.json();
    if (!isSyncResponse(data)) {
      console.warn(`[federation-sync] ${context} pull from ${peer.origin}: malformed response`);
      return 'http_error';
    }

    for (const event of data.events) {
      await handlePulledEvent(peer, context, event, stats);
    }

    const pagePosition: CursorPosition = { ts: data.checkpoint, id: data.checkpointId ?? null };
    if (isAfter(pagePosition, position)) {
      position = pagePosition;
      saveCursor(peer.id, context, position);
    }
    if (!data.hasMore) break;

    if (data.checkpointId !== undefined) {
      since = data.checkpoint;
      afterId = data.checkpointId;
    } else {
      // A server without keyset pagination returns rows after `since` by
      // timestamp only. Starting one millisecond back re-reads the rows at
      // the checkpoint (applying them again is harmless) instead of skipping
      // any that fell past the page; a page made entirely of one millisecond
      // can only move on by skipping the rest of it.
      let next = data.checkpoint - 1;
      if (next <= since) {
        next = data.checkpoint;
        console.warn(`[federation-sync] ${context} pull from ${peer.origin}: a full page shares ${data.checkpoint}; this server cannot page within it`);
      }
      since = next;
      afterId = undefined;
    }
  }

  markPulled(peer.id, context, Date.now());
  return 'ok';
}

/**
 * Pull `contexts` from the peer's mutation log and apply them. Null when relay
 * is disabled or the peer is not active. Updates `last_synced_at` (the time of
 * the last pull that completed every context asked for, shown to admins).
 */
export function syncPeerMutationLog(
  peerId: string,
  reason: SyncReason,
  contexts: readonly SyncContext[] = ALL_SYNC_CONTEXTS,
): Promise<SyncPeerResult | null> {
  return runForPeer(peerId, () => pullPeer(peerId, reason, contexts));
}

async function pullPeer(
  peerId: string,
  reason: SyncReason,
  contexts: readonly SyncContext[],
): Promise<SyncPeerResult | null> {
  if (!isFederationRelayEnabled()) return null;
  const db = getDb();
  const peer = db.select().from(schema.federationPeers)
    .where(eq(schema.federationPeers.id, peerId)).get();
  if (!peer || peer.status !== 'active') return null;

  reconcileCursorEpoch(peer);
  const signingSecret = (peer.pendingHmacSecret && peer.secretRotationAt)
    ? peer.pendingHmacSecret
    : peer.hmacSecret;

  const stats: SyncPeerResult = { contexts: {}, applied: 0, duplicates: 0, deferred: 0, dropped: 0 };
  for (const context of contexts) {
    try {
      stats.contexts[context] = await pullContext(peer, context, signingSecret, stats);
    } catch (err) {
      console.error('[federation-sync] %s pull from %s failed:', context, peer.origin, err);
      stats.contexts[context] = 'error';
    }
  }

  if (contexts.every(context => stats.contexts[context] === 'ok')) {
    db.update(schema.federationPeers)
      .set({ lastSyncedAt: Date.now() })
      .where(eq(schema.federationPeers.id, peer.id))
      .run();
  }
  if (stats.applied + stats.deferred + stats.dropped > 0) {
    console.log(
      `[federation-sync] Pulled from ${peer.origin} (${reason}): ${stats.applied} applied, ` +
      `${stats.duplicates} already held, ${stats.deferred} kept for retry, ${stats.dropped} dropped`,
    );
  }
  return stats;
}

// ─── Retrying kept events ───────────────────────────────────────────────────

function retryBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), SYNC_RETRY_BACKOFF_MS.length) - 1;
  return SYNC_RETRY_BACKOFF_MS[index]!;
}

async function retryPeerEvents(peer: PeerRow, now: number): Promise<number> {
  const db = getDb();
  // The peer's order across subjects, so an event a later one needs (the
  // member_add that bootstraps a group before a message in it) goes first.
  const rows = db.select()
    .from(schema.federationSyncRetry)
    .where(eq(schema.federationSyncRetry.peerId, peer.id))
    .orderBy(asc(schema.federationSyncRetry.eventTs), asc(schema.federationSyncRetry.id))
    .all();

  let resolved = 0;
  const seen = new Set<string>();
  const blocked = new Set<string>();
  for (const row of rows) {
    if (blocked.has(row.subjectKey)) continue;
    const isHead = !seen.has(row.subjectKey);
    seen.add(row.subjectKey);
    if (isHead && row.nextRetryAt > now) {
      blocked.add(row.subjectKey);
      continue;
    }

    let event: FederationRelayEvent;
    try {
      event = JSON.parse(row.eventJson) as FederationRelayEvent;
    } catch {
      db.delete(schema.federationSyncRetry).where(eq(schema.federationSyncRetry.id, row.id)).run();
      console.warn('[federation-sync] Dropped unreadable kept event %s from %s', row.id, peer.origin);
      resolved += 1;
      continue;
    }

    if (now - row.firstFailedAt > SYNC_RETRY_MAX_AGE_MS) {
      db.delete(schema.federationSyncRetry).where(eq(schema.federationSyncRetry.id, row.id)).run();
      logDropped(peer, event, row.lastReason, `still refused after ${Math.round(SYNC_RETRY_MAX_AGE_MS / 86_400_000)} days`);
      resolved += 1;
      continue;
    }

    const outcome = await applyPulledEvent(peer, event);
    if (outcome.kind === 'retry') {
      const attempts = row.attempts + 1;
      db.update(schema.federationSyncRetry)
        .set({ attempts, lastReason: outcome.reason, nextRetryAt: now + retryBackoffMs(attempts) })
        .where(eq(schema.federationSyncRetry.id, row.id))
        .run();
      blocked.add(row.subjectKey);
      continue;
    }
    db.delete(schema.federationSyncRetry).where(eq(schema.federationSyncRetry.id, row.id)).run();
    if (outcome.kind === 'refused') logDropped(peer, event, outcome.reason, `${outcome.why} on retry`);
    resolved += 1;
  }
  return resolved;
}

/**
 * Replay every kept event that is due, per peer, in the peer's order; a
 * subject stops at its first event that is still refused for now.
 * Returns how many kept events were resolved (applied, already held, dropped).
 */
export async function processSyncRetryTick(now: number = Date.now()): Promise<number> {
  if (!isFederationRelayEnabled()) return 0;
  const db = getDb();
  const peerIds = db.selectDistinct({ peerId: schema.federationSyncRetry.peerId })
    .from(schema.federationSyncRetry)
    .all()
    .map(r => r.peerId);
  let resolved = 0;
  for (const peerId of peerIds) {
    resolved += await runForPeer(peerId, async () => {
      const peer = getDb().select().from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, peerId)).get();
      if (!peer || peer.status !== 'active') return 0;
      // Kept events belong to the incarnation they were pulled from. A peer
      // row reactivated for a new incarnation (a reset peer that peered
      // again) keeps its id, so its epoch is checked here as before a pull:
      // a different epoch drops them before any is replayed.
      reconcileCursorEpoch(peer);
      return retryPeerEvents(peer, now);
    });
  }
  return resolved;
}

/** Pull `PERIODIC_SYNC_CONTEXTS` from every active peer, one peer at a time, then retry kept events. */
export async function processResyncTick(): Promise<void> {
  if (!isFederationRelayEnabled()) return;
  const peers = getDb().select({ id: schema.federationPeers.id })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'active'))
    .all();
  for (const peer of peers) {
    await syncPeerMutationLog(peer.id, 'periodic', PERIODIC_SYNC_CONTEXTS);
  }
  await processSyncRetryTick();
}

// ─── Timers ─────────────────────────────────────────────────────────────────

let resyncTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleResync(delayMs: number): void {
  resyncTimer = setTimeout(() => {
    processResyncTick()
      .catch(err => console.error('[federation-sync] Periodic pull failed:', err))
      .finally(() => {
        if (resyncTimer !== null) scheduleResync(RESYNC_INTERVAL_MS);
      });
  }, delayMs);
}

function scheduleRetry(): void {
  retryTimer = setTimeout(() => {
    processSyncRetryTick()
      .catch(err => console.error('[federation-sync] Retry tick failed:', err))
      .finally(() => {
        if (retryTimer !== null) scheduleRetry();
      });
  }, SYNC_RETRY_INTERVAL_MS);
}

/** Start the periodic pull (first run `RESYNC_FIRST_DELAY_MS` after boot) and the retry tick. */
export function startPeerSyncWorkers(): void {
  scheduleResync(RESYNC_FIRST_DELAY_MS);
  scheduleRetry();
}

export function stopPeerSyncWorkers(): void {
  if (resyncTimer) clearTimeout(resyncTimer);
  if (retryTimer) clearTimeout(retryTimer);
  resyncTimer = null;
  retryTimer = null;
}
