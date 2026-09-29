import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { FederationRelayEvent, FederationSyncRequest, FederationSyncResponse } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { buildFederationHeaders, getOurOrigin, normalizeOriginForCompare } from './federationAuth.js';
import { federationFetch } from './federationFetch.js';
import { isFederationRelayEnabled } from './federationOutbox.js';
import { classifyRejection } from './federationRejections.js';
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
 *   outcome classified by `classifyRejection`: a `retry` refusal is kept with
 *   the whole event in `federation_sync_retry` and replayed locally with
 *   backoff; the cursor never stops. A conversation (friend pair, profile)
 *   with a kept event holds its later pulled events behind it, so the pull
 *   applies one conversation's events in the peer's order.
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
export const PERIODIC_SYNC_CONTEXTS: readonly SyncContext[] = ['dm', 'profile'];

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
type PulledOutcome = 'applied' | 'taken' | 'refused' | { retry: string };

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
 * Where a context's cursor starts when it has none: the whole log for DM and
 * profile events, whose processors are safe to apply twice; for friend events,
 * the last completed pull (in this instance's clock, as before cursors).
 */
function initialCursorTs(peer: PeerRow, context: SyncContext): number {
  return context === 'friend' ? peer.lastSyncedAt ?? 0 : 0;
}

/**
 * Restart every cursor of `peer` at 0, and drop its kept events, when the
 * peer is a new incarnation (its instance id differs from the one the cursors
 * were taken against): its log is a different log.
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
  const ts = initialCursorTs(peer, context);
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

/**
 * The unit a pulled event is ordered within: its conversation (the peer's id
 * for it), its friend pair, or the profile's user. Events of one unit are
 * applied in the peer's order; different units never wait for each other.
 */
export function syncContextKey(context: SyncContext, event: FederationRelayEvent): string {
  if (context === 'dm' && event.dmChannelId) return `dm:${event.dmChannelId}`;
  if (context === 'friend' && event.friendship) {
    const side = (s: { homeUserId: string; homeInstance: string }) =>
      `${s.homeUserId}@${normalizeOriginForCompare(s.homeInstance) ?? s.homeInstance}`;
    return `friend:${[side(event.friendship.from), side(event.friendship.to)].sort().join('|')}`;
  }
  if (context === 'profile' && event.profileUpdate) {
    return `profile:${event.profileUpdate.homeUserId}@${normalizeOriginForCompare(event.profileUpdate.homeInstance) ?? event.profileUpdate.homeInstance}`;
  }
  return `${context}:${event.messageId}`;
}

async function applyPulledEvent(peer: PeerRow, event: FederationRelayEvent): Promise<PulledOutcome> {
  const { processRelayEvents } = await import('../routes/federation.js');
  const result = await processRelayEvents([event], peer.origin, peer.origin, getDb(), { delivery: 'catch_up' });
  const rejection = result.rejected.find(r => r.messageId === event.messageId) ?? result.rejected[0];
  if (!rejection) return 'applied';
  const outcome = classifyRejection(event.eventType, rejection.reason);
  if (outcome === 'retry') return { retry: rejection.reason };
  return outcome;
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
    `[federation-sync] Dropped ${event.eventType} ${event.messageId} (ts=${event.timestamp}) from ${peer.origin}: ${why} (${reason})`,
  );
}

async function handlePulledEvent(
  peer: PeerRow,
  context: SyncContext,
  event: FederationRelayEvent,
  stats: SyncPeerResult,
): Promise<void> {
  const now = Date.now();
  const contextKey = syncContextKey(context, event);
  if (hasKeptEvents(peer.id, contextKey)) {
    keepEvent(peer.id, context, contextKey, event, 'held_behind_earlier_event', now, now);
    stats.deferred += 1;
    return;
  }
  const outcome = await applyPulledEvent(peer, event);
  if (outcome === 'applied') {
    stats.applied += 1;
  } else if (outcome === 'taken') {
    stats.duplicates += 1;
  } else if (outcome === 'refused') {
    stats.dropped += 1;
  } else {
    keepEvent(peer.id, context, contextKey, event, outcome.retry, now + SYNC_RETRY_BACKOFF_MS[0]!, now);
    stats.deferred += 1;
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
  let since = Math.max(0, position.ts - FIRST_PAGE_OVERLAP_MS);
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
  const rows = db.select()
    .from(schema.federationSyncRetry)
    .where(eq(schema.federationSyncRetry.peerId, peer.id))
    .orderBy(
      asc(schema.federationSyncRetry.subjectKey),
      asc(schema.federationSyncRetry.eventTs),
      asc(schema.federationSyncRetry.id),
    )
    .all();

  let resolved = 0;
  let blockedKey: string | null = null;
  let headKey: string | null = null;
  for (const row of rows) {
    if (row.subjectKey === blockedKey) continue;
    const isHead = row.subjectKey !== headKey;
    headKey = row.subjectKey;
    if (isHead && row.nextRetryAt > now) {
      blockedKey = row.subjectKey;
      continue;
    }

    let event: FederationRelayEvent;
    try {
      event = JSON.parse(row.eventJson) as FederationRelayEvent;
    } catch {
      db.delete(schema.federationSyncRetry).where(eq(schema.federationSyncRetry.id, row.id)).run();
      console.warn(`[federation-sync] Dropped unreadable kept event ${row.id} from ${peer.origin}`);
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
    if (typeof outcome === 'object') {
      const attempts = row.attempts + 1;
      db.update(schema.federationSyncRetry)
        .set({ attempts, lastReason: outcome.retry, nextRetryAt: now + retryBackoffMs(attempts) })
        .where(eq(schema.federationSyncRetry.id, row.id))
        .run();
      blockedKey = row.subjectKey;
      continue;
    }
    db.delete(schema.federationSyncRetry).where(eq(schema.federationSyncRetry.id, row.id)).run();
    if (outcome === 'refused') logDropped(peer, event, row.lastReason, 'refused on retry');
    resolved += 1;
  }
  return resolved;
}

/**
 * Replay every kept event that is due, per peer, per unit, in the peer's
 * order; a unit stops at its first event that is still refused for now.
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
