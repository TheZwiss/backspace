import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq, and, lte, asc, inArray, sql } from 'drizzle-orm';
import { config } from '../config.js';
import {
  isFederationRelayEnabled,
  queueOutboxEvent,
  appendMutationLog,
} from './federationOutbox.js';
import { isOutboxQueueHead, markOutboxOffered, refusalEndsOutboxQueue } from './federationOutboxQueue.js';
import { runFederationJanitor } from './storageJanitor.js';
import { buildFederationHeaders, getOurOrigin, generateHmacSecret, ROTATION_GRACE_PERIOD_MS } from './federationAuth.js';
import { evaluateAuthFailure, AUTH_FAILURE_THRESHOLD } from './federationAuthFailure.js';
import { generateSnowflake } from './snowflake.js';
import { getDmMessageWithUser } from '../routes/dm.js';
import { connectionManager } from '../ws/handler.js';
import { generateThumbnail } from './thumbnail.js';
import { safeFetch } from './ssrf.js';
import { federationFetch } from './federationFetch.js';
import type { FederationRelayCapability, FederationRelayRequest, FederationRelayResponse, FederationRelayEvent } from '@backspace/shared';
import { startupBootstrapSync, onPeerDeactivated } from './federationPeerActivation.js';
import { ensurePeered, isHandshakeInFlight } from './federationPeering.js';
import { probePeerReachable, recoverOrDetectReset, detectResetOnNeedsAttentionPeers, detectResetForPeer } from './federationRecovery.js';
import { backfillReplicatedProfileAssets, sweepDeadIncarnationArtifacts } from '../routes/federation.js';
import { invokePermanentFailureCallback } from './federationRollback.js';
import { refreshPeerEpochs, getInstanceId } from './federationEpoch.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ─── Constants ──────────────────────────────────────────────────────────────

const OUTBOX_INTERVAL_MS = 1_000;         // 1 second (idle polls are no-ops)
const FILE_QUEUE_INTERVAL_MS = 30_000;    // 30 seconds
// Matches ROTATION_GRACE_PERIOD_MS: guarantees a finalization tick fires within
// one grace window on each side, so rotation desync can't outlast the window
// and trip spurious auth failures on the other peer.
const HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const RECOVERY_TICK_INTERVAL_MS = 5_000;   // 5 seconds — demand-driven recovery scan
/**
 * Per-peer attempt backoff (ms), indexed by probe_attempts (0-based). Paces both
 * the recovery probe of an `unreachable` peer and the handshake retry of a
 * `pending` peer; see isPeerAttemptDue.
 */
const RECOVERY_BACKOFF_MS: readonly number[] = [30_000, 60_000, 300_000, 900_000];
const JANITOR_INTERVAL_MS = 3_600_000;     // 1 hour

const OUTBOX_BATCH_LIMIT = 50;
const FILE_QUEUE_BATCH_LIMIT = 5;

const OUTBOX_FETCH_TIMEOUT_MS = 30_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Exponential backoff schedule by attempt number (1-indexed). Values in milliseconds. */
const BACKOFF_SCHEDULE_MS: readonly number[] = [
  30_000,       // attempt 1: 30s
  60_000,       // attempt 2: 1min
  300_000,      // attempt 3: 5min
  900_000,      // attempt 4: 15min
  3_600_000,    // attempt 5: 1hr
  21_600_000,   // attempt 6: 6hr
  86_400_000,   // attempt 7+: 24hr cap
];

const MAX_FILE_ATTEMPTS = 10;
const PEER_UNREACHABLE_THRESHOLD = 10;

/**
 * Outbox rejection reasons that the receiver has acknowledged as permanently
 * undeliverable. These cause the outbox entry to be deleted (no retry) and
 * trigger the registered permanent-failure callback for the eventType.
 *
 * 'duplicate' is treated as terminal-but-no-rollback (the receiver already has
 * the event; nothing to roll back locally).
 *
 * Every other rejection is retryable: the entry stays and waits out the next
 * step of BACKOFF_SCHEDULE_MS, until the janitor drops it at its TTL. That
 * includes `attribution_unproven` (the receiver does not hold the proof that
 * our user has an account here yet; it arrives from the user's client) and
 * reasons such as `channel_not_found` that resolve once an earlier event lands.
 *
 * 5xx responses, network errors, and timeouts are NOT in this set — they are
 * transient and retried via the existing backoff schedule.
 */
const TERMINAL_REJECTION_REASONS = new Set<string>([
  'duplicate',            // peer already has it (existing behavior)
  'recipient_not_found',  // receiver doesn't know the target user
  'attribution_mismatch', // the source can never speak for this actor (third-instance, malformed, or no such user)
  'unknown_event_type',   // peer doesn't understand this eventType — never will
  'self_target_invalid',  // payload's from-identity equals to-identity (sender's self-check should have caught this)
  'not_message_author',   // relayed edit/delete names a message the actor did not write
  'invalid_target',       // edit/delete/reaction target malformed or from a non-peer; 1-on-1 create or reaction by a non-member; group op on a 1-on-1; unacceptable bootstrap; friend_add answering no pending request
]);

/**
 * What this sender tells receivers it handles (`FederationRelayRequest.capabilities`).
 * `attribution_unproven` is listed because the reason is not in
 * TERMINAL_REJECTION_REASONS, so it is retried on the backoff schedule.
 */
const RELAY_CAPABILITIES: FederationRelayCapability[] = ['attribution_unproven'];

// ─── Worker State ───────────────────────────────────────────────────────────

let outboxTimer: ReturnType<typeof setTimeout> | null = null;
let fileQueueTimer: ReturnType<typeof setTimeout> | null = null;
let healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let janitorTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Handshake attempts the outbox worker has started for `pending` peers, keyed by
 * origin. They run detached from the outbox tick, so an origin that never
 * answers cannot hold up delivery to active peers; this map is what keeps a
 * second attempt for the same origin from starting while one is outstanding.
 */
const pendingPeerHandshakes = new Map<string, Promise<void>>();

let outboxAbortController: AbortController | null = null;
let fileQueueAbortController: AbortController | null = null;
let recoveryAbortController: AbortController | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the backoff delay for a given attempt number (1-indexed).
 * Caps at the last entry in BACKOFF_SCHEDULE_MS.
 */
function getBackoffMs(attempt: number): number {
  const index = Math.min(attempt - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return retryWait(BACKOFF_SCHEDULE_MS[Math.max(0, index)] ?? 86_400_000);
}

/**
 * A retry wait from the schedules above, divided by
 * `config.federation.backoffDivisor`. See docs/systems/federation.md,
 * "Retry backoff divisor (test only)".
 */
function retryWait(ms: number): number {
  return Math.ceil(ms / config.federation.backoffDivisor);
}

/**
 * Whether a peer's next attempt is due on the per-peer pacing shared by
 * unreachable-peer recovery and pending-peer handshakes. `last_probe_at` is when
 * the last attempt started and `probe_attempts` counts the failed attempts since
 * the pacing was last reset. A peer with queued outbox mail is paced on
 * RECOVERY_BACKOFF_MS; a silent one falls back to the health-check interval.
 */
function isPeerAttemptDue(
  peer: { probeAttempts: number; lastProbeAt: number | null },
  hasQueuedMail: boolean,
  now: number,
): boolean {
  if (peer.lastProbeAt === null) return true;
  const interval = hasQueuedMail
    ? retryWait(RECOVERY_BACKOFF_MS[Math.min(peer.probeAttempts, RECOVERY_BACKOFF_MS.length - 1)]!)
    : HEALTH_CHECK_INTERVAL_MS;
  return now - peer.lastProbeAt >= interval;
}

/**
 * Get the effective max upload size from instance settings or config fallback.
 */
function getMaxUploadSize(): number {
  try {
    const db = getDb();
    const row = db
      .select({ maxUploadSizeBytes: schema.instanceSettings.maxUploadSizeBytes })
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.id, 1))
      .get();
    return row?.maxUploadSizeBytes ?? config.maxUploadSize;
  } catch {
    return config.maxUploadSize;
  }
}

// ─── Outbox Delivery Worker ─────────────────────────────────────────────────

/** What the worker reads of an outbox row and its peer to send the row. */
const OUTBOX_ENTRY_COLUMNS = {
  outboxId: schema.federationOutbox.id,
  peerId: schema.federationOutbox.peerId,
  contextId: schema.federationOutbox.contextId,
  entityId: schema.federationOutbox.entityId,
  queueKey: schema.federationOutbox.queueKey,
  contextType: schema.federationOutbox.contextType,
  eventType: schema.federationOutbox.eventType,
  payload: schema.federationOutbox.payload,
  encryptionVersion: schema.federationOutbox.encryptionVersion,
  attempts: schema.federationOutbox.attempts,
  createdAt: schema.federationOutbox.createdAt,
  peerOrigin: schema.federationPeers.origin,
  peerHmacSecret: schema.federationPeers.hmacSecret,
  peerPendingHmacSecret: schema.federationPeers.pendingHmacSecret,
  peerSecretRotationAt: schema.federationPeers.secretRotationAt,
  peerStatus: schema.federationPeers.status,
};

function scheduleOutboxTick(): void {
  outboxTimer = setTimeout(() => {
    processOutboxTick().catch((err) => {
      console.error('[federation-worker] Outbox tick error:', err);
    }).finally(() => {
      scheduleOutboxTick();
    });
  }, OUTBOX_INTERVAL_MS);
}

/** One row as `select(OUTBOX_ENTRY_COLUMNS)` returns it: nullable columns may be null. */
type OutboxEntry = {
  [K in keyof typeof OUTBOX_ENTRY_COLUMNS]: (typeof OUTBOX_ENTRY_COLUMNS)[K]['_']['data'] | ((typeof OUTBOX_ENTRY_COLUMNS)[K]['_']['notNull'] extends true ? never : null);
};

/**
 * What the worker learned from one relay POST:
 * - `answered`: the peer's per-event verdicts;
 * - `auth_refused`: 401/403, the peer did not accept our signature or peering;
 * - `failed`: no usable answer (network error, timeout, an HTTP error, an
 *   answer that cannot be read). The peer may have applied the batch;
 * - `aborted`: the worker is stopping.
 * In every case but `answered` the rows are possibly delivered: they stay
 * offered, and anything queued behind them waits for them.
 */
type DeliveryOutcome =
  | { kind: 'answered'; result: FederationRelayResponse }
  | { kind: 'auth_refused'; status: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'aborted' };

/** A relay answer's shape, or null when it is not one. */
function parseRelayResponse(body: unknown): FederationRelayResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const { accepted, rejected, maxUploadSize } = body as Record<string, unknown>;
  if (!Array.isArray(accepted) || !accepted.every((id): id is string => typeof id === 'string')) return null;
  if (!Array.isArray(rejected)) return null;
  const rejections: FederationRelayResponse['rejected'] = [];
  for (const entry of rejected) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { messageId, reason } = entry as Record<string, unknown>;
    if (typeof messageId !== 'string' || typeof reason !== 'string') return null;
    rejections.push({ messageId, reason });
  }
  return {
    accepted,
    rejected: rejections,
    maxUploadSize: typeof maxUploadSize === 'number' ? maxUploadSize : Number.NaN,
  };
}

/** POST one batch and report what came of it. Never throws. */
async function sendOutboxBatch(
  peerOrigin: string,
  body: string,
  headers: Record<string, string>,
): Promise<DeliveryOutcome> {
  outboxAbortController = new AbortController();
  try {
    const response = await federationFetch(peerOrigin, '/api/federation/relay', {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any([
        outboxAbortController.signal,
        AbortSignal.timeout(OUTBOX_FETCH_TIMEOUT_MS),
      ]),
    }, 'approved');

    if (response.status === 401 || response.status === 403) {
      return { kind: 'auth_refused', status: response.status };
    }
    if (!response.ok) {
      return { kind: 'failed', reason: `HTTP ${response.status}` };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { kind: 'failed', reason: 'unreadable answer' };
    }
    const result = parseRelayResponse(parsed);
    return result ? { kind: 'answered', result } : { kind: 'failed', reason: 'unreadable answer' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { kind: 'aborted' };
    }
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What a rejection means for the row. The one place TERMINAL_REJECTION_REASONS
 * is read:
 * - `taken`: the peer already holds the event (`duplicate`);
 * - `refused`: the peer will never take it; the row goes;
 * - `retry`: the row stays and waits out its next backoff step.
 */
function classifyRelayRejection(reason: string): 'taken' | 'refused' | 'retry' {
  if (reason === 'duplicate') return 'taken';
  return TERMINAL_REJECTION_REASONS.has(reason) ? 'refused' : 'retry';
}

/**
 * Read the rows chosen for a peer again, keep one per wire id (the peer's
 * answer names events by it), and mark them offered: from here on the peer
 * may hold them. Runs synchronously, so what is marked is exactly what is sent.
 * A row replaced since the tick chose it is gone and not sent.
 */
function takeOutboxBatch(db: ReturnType<typeof getDb>, outboxIds: string[], now: number): OutboxEntry[] {
  return db.transaction((tx) => {
    const current = tx
      .select(OUTBOX_ENTRY_COLUMNS)
      .from(schema.federationOutbox)
      .innerJoin(
        schema.federationPeers,
        eq(schema.federationOutbox.peerId, schema.federationPeers.id),
      )
      .where(inArray(schema.federationOutbox.id, outboxIds))
      .orderBy(asc(schema.federationOutbox.createdAt), asc(schema.federationOutbox.id))
      .all();
    const wireIds = new Set<string>();
    const batch = current.filter((entry) => {
      if (wireIds.has(entry.entityId)) return false;
      wireIds.add(entry.entityId);
      return true;
    });
    markOutboxOffered(tx, batch.map((entry) => entry.outboxId), now);
    return batch;
  });
}

/** Build the relay events for a batch. */
function buildRelayEvents(entries: OutboxEntry[]): FederationRelayEvent[] {
  return entries.map((entry) => {
    const parsed = JSON.parse(entry.payload) as Partial<FederationRelayEvent>;
    const isDm = entry.contextType === 'dm' || !entry.contextType;
    const evt: FederationRelayEvent = {
      eventType: entry.eventType as FederationRelayEvent['eventType'],
      contextType: (entry.contextType ?? 'dm') as 'dm' | 'friend' | 'profile',
      messageId: entry.entityId ?? '',
      encryptionVersion: (entry.encryptionVersion ?? 0) as 0,
      timestamp: entry.createdAt,
    };
    if (isDm && entry.contextId) evt.dmChannelId = entry.contextId;
    if (parsed.federatedId) evt.federatedId = parsed.federatedId;
    if (parsed.participants) evt.participants = parsed.participants;
    if (parsed.message) evt.message = parsed.message;
    if (parsed.reactions) evt.reactions = parsed.reactions;
    if (parsed.reaction) evt.reaction = parsed.reaction;
    if (parsed.target) evt.target = parsed.target;
    if (parsed.membership) evt.membership = parsed.membership;
    if (parsed.ownership) evt.ownership = parsed.ownership;
    if (parsed.group) evt.group = parsed.group;
    if (parsed.friendship) evt.friendship = parsed.friendship;
    // file_rejected event fields
    if (parsed.attachmentId) evt.attachmentId = parsed.attachmentId;
    if (parsed.sourceFilename) evt.sourceFilename = parsed.sourceFilename;
    if (parsed.rejectionReason) evt.rejectionReason = parsed.rejectionReason;
    if (parsed.rejectionLimit != null) evt.rejectionLimit = parsed.rejectionLimit;
    if (parsed.affectedUserIds) evt.affectedUserIds = parsed.affectedUserIds;
    if (parsed.metadata) evt.metadata = parsed.metadata;
    if (parsed.profileUpdate) evt.profileUpdate = parsed.profileUpdate;
    if (parsed.presenceUpdate) evt.presenceUpdate = parsed.presenceUpdate;
    if (parsed.readState) evt.readState = parsed.readState;
    if (parsed.dmCloseReopen) evt.dmCloseReopen = parsed.dmCloseReopen;
    return evt;
  });
}

export async function processOutboxTick(): Promise<void> {
  if (!isFederationRelayEnabled()) {
    return;
  }

  const db = getDb();
  const now = Date.now();

  // Start any due handshakes for pending peers first. They run detached, so
  // they overlap this tick's delivery instead of delaying it.
  resolvePendingPeers(now);

  // Due rows for active peers that head their queue: a row waits while an
  // older row of its entity is still queued, backing off or not.
  const entries = db
    .select(OUTBOX_ENTRY_COLUMNS)
    .from(schema.federationOutbox)
    .innerJoin(
      schema.federationPeers,
      eq(schema.federationOutbox.peerId, schema.federationPeers.id),
    )
    .where(
      and(
        lte(schema.federationOutbox.nextRetryAt, now),
        eq(schema.federationPeers.status, 'active'),
        isOutboxQueueHead(),
      ),
    )
    .orderBy(asc(schema.federationOutbox.createdAt), asc(schema.federationOutbox.id))
    .limit(OUTBOX_BATCH_LIMIT)
    .all();

  if (entries.length === 0) {
    return;
  }

  const byPeer = new Map<string, string[]>();
  for (const entry of entries) {
    const ids = byPeer.get(entry.peerId);
    if (ids) ids.push(entry.outboxId);
    else byPeer.set(entry.peerId, [entry.outboxId]);
  }

  const ourOrigin = getOurOrigin();

  for (const [peerId, selectedIds] of byPeer) {
    // Read again right before sending: an earlier peer's delivery in this
    // tick may have taken a while, and a row replaced meanwhile goes out as
    // its replacement on a later tick.
    const batch = takeOutboxBatch(db, selectedIds, Date.now());
    const firstEntry = batch[0];
    if (!firstEntry) continue;

    const peerOrigin = firstEntry.peerOrigin;
    const peerHmacSecret = (firstEntry.peerPendingHmacSecret && firstEntry.peerSecretRotationAt)
      ? firstEntry.peerPendingHmacSecret
      : firstEntry.peerHmacSecret;

    const request: FederationRelayRequest = {
      version: 1,
      sourceInstance: ourOrigin,
      // Stamp our current epoch so a verified relay authentically carries this
      // instance's incarnation id — the receiver uses it as the fast-path
      // populate-if-null baseline (design §3.2). A reset instance cannot sign a
      // valid relay, so this never carries a *new* epoch post-reset.
      sourceInstanceId: getInstanceId(),
      capabilities: RELAY_CAPABILITIES,
      events: buildRelayEvents(batch),
    };
    const bodyString = JSON.stringify(request);
    const headers = buildFederationHeaders(bodyString, peerHmacSecret, ourOrigin);

    const outcome = await sendOutboxBatch(peerOrigin, bodyString, headers);
    const settledAt = Date.now();

    switch (outcome.kind) {
      case 'aborted':
        // Worker is stopping: the rows stay offered and due, no failure count.
        return;
      case 'answered':
        settleAnsweredBatch(db, peerId, peerOrigin, batch, outcome.result, settledAt);
        break;
      case 'auth_refused':
        applyOutboxEntryBackoff(db, batch, settledAt);
        handleRelayAuthRefusal(db, peerId, peerOrigin, outcome.status, settledAt);
        break;
      case 'failed':
        console.error(`[federation-worker] Failed to deliver to peer ${peerOrigin}: ${outcome.reason}`);
        handleOutboxDeliveryFailure(db, peerId, batch, settledAt);
        break;
    }
  }
}

/**
 * Apply a peer's answer to the batch it answered, in one transaction: a row
 * the peer took or refused for good is deleted (with the rest of its queue
 * when a refusal ends the entity), any other row moves to its next backoff
 * step. What follows the transaction (rollback callbacks, logging, peer
 * bookkeeping) cannot change the rows, and a failure there is logged without
 * touching them.
 */
function settleAnsweredBatch(
  db: ReturnType<typeof getDb>,
  peerId: string,
  peerOrigin: string,
  batch: OutboxEntry[],
  result: FederationRelayResponse,
  now: number,
): void {
  const accepted = new Set(result.accepted);
  const rejections = new Map(result.rejected.map((rejection) => [rejection.messageId, rejection.reason]));
  const refusals: Array<{ messageId: string; reason: string; eventType: string }> = [];

  db.transaction((tx) => {
    const retry: OutboxEntry[] = [];
    for (const entry of batch) {
      const reason = rejections.get(entry.entityId);
      const verdict = accepted.has(entry.entityId) ? 'taken' : reason === undefined ? 'retry' : classifyRelayRejection(reason);
      if (verdict === 'retry') {
        retry.push(entry);
        continue;
      }
      tx.delete(schema.federationOutbox).where(eq(schema.federationOutbox.id, entry.outboxId)).run();
      if (verdict === 'refused' && reason !== undefined) {
        refusals.push({ messageId: entry.entityId, reason, eventType: entry.eventType });
        if (refusalEndsOutboxQueue(entry.eventType) && entry.queueKey !== null) {
          tx.delete(schema.federationOutbox)
            .where(and(
              eq(schema.federationOutbox.peerId, peerId),
              eq(schema.federationOutbox.queueKey, entry.queueKey),
            ))
            .run();
        }
      }
    }
    // Retried rows (non-terminal rejections, and any row the answer does not
    // mention) move to the next step of the backoff schedule. Leaving them due
    // would resend them on every tick.
    applyOutboxEntryBackoff(tx, retry, now);
  });

  try {
    // Rollback callbacks run after the rows are gone, so the originator can
    // undo its local state (e.g. friend_request_create deletes the local
    // friend_requests row). The registry catches and logs callback errors.
    for (const { messageId, reason, eventType } of refusals) {
      invokePermanentFailureCallback(eventType, messageId, reason);
    }

    for (const rejection of result.rejected) {
      if (classifyRelayRejection(rejection.reason) === 'retry') {
        console.warn(
          `[federation-worker] Peer ${peerOrigin} rejected message ${rejection.messageId}: ${rejection.reason}`,
        );
      } else {
        console.log(
          `[federation-worker] Peer ${peerOrigin} terminal rejection ${rejection.messageId}: ${rejection.reason} — outbox entry removed`,
        );
      }
    }

    // The peer's max upload size, for informational display, and its health.
    db.update(schema.federationPeers)
      .set({
        lastSeenAt: now,
        consecutiveFailures: 0,
        consecutiveAuthFailures: 0,
        ...(Number.isFinite(result.maxUploadSize) ? { remoteMaxUploadSize: result.maxUploadSize } : {}),
      })
      .where(eq(schema.federationPeers.id, peerId))
      .run();
  } catch (err) {
    console.error(`[federation-worker] Bookkeeping after delivery to ${peerOrigin} failed; the batch stays settled:`, err);
  }
}

/**
 * HMAC rejected or remote's peer row non-active. Do NOT re-handshake via the
 * unauthenticated /peer/accept path — the remote's idempotent-200-no-update
 * safeguard would loop forever and, more importantly, re-handshaking in
 * response to a 401 is not how trust gets healed. Persistent auth failures
 * transition to needs_attention; bounded retry (AUTH_FAILURE_THRESHOLD) rides
 * out transient clock skew and rotation-grace edge races. Auth failures do not
 * count toward consecutive_failures, which drives the network-layer
 * `unreachable` transition.
 */
function handleRelayAuthRefusal(
  db: ReturnType<typeof getDb>,
  peerId: string,
  peerOrigin: string,
  status: number,
  now: number,
): void {
  const currentRow = db
    .select({
      consecutiveAuthFailures: schema.federationPeers.consecutiveAuthFailures,
      peerInstanceId: schema.federationPeers.peerInstanceId,
    })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.id, peerId))
    .get();
  const decision = evaluateAuthFailure(currentRow?.consecutiveAuthFailures ?? 0);

  if (decision.kind === 'transition_to_needs_attention') {
    db.update(schema.federationPeers)
      .set({
        status: 'needs_attention',
        consecutiveAuthFailures: decision.newAuthFailures,
        lastFailureAt: now,
      })
      .where(eq(schema.federationPeers.id, peerId))
      .run();
    onPeerDeactivated(peerId, 'auth_threshold').catch(err =>
      console.error('[federation-worker] onPeerDeactivated from auth threshold failed:', err)
    );
    console.warn(
      `[federation-worker] Peer ${peerOrigin} transitioned to needs_attention after ${decision.newAuthFailures} consecutive ${status} responses`,
    );

    // Event-driven reset detection: a genuinely reset peer reaches
    // needs_attention via THIS auth-failure path (HMAC desynced by the new
    // incarnation) without ever passing through `unreachable`, so the
    // 5-second unreachable-only recovery probe never sees it. Probe its
    // epoch NOW — the instant the connection is declared broken — instead of
    // waiting up to a full 15-minute health-check cycle for the backstop
    // sweep. Detection-only (markPeerReset); never flips back to active.
    // Fire-and-forget: a probe failure is a benign no-op the 15-min tick
    // retries, and it must not stall the outbox loop.
    detectResetForPeer({
      id: peerId,
      origin: peerOrigin,
      peerInstanceId: currentRow?.peerInstanceId ?? null,
    }).catch(err =>
      console.error('[federation-worker] reset probe on auth-threshold transition failed:', err)
    );

    const contextMap = buildContextMapForPeer(db, peerId);
    if (contextMap.size > 0) {
      pushPeerRejectedEvent(
        peerOrigin,
        contextMap,
        'Federation trust broken — admin must reset peering',
      );
    }
    connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
  } else {
    console.warn(
      `[federation-worker] Peer ${peerOrigin} returned ${status} (auth failure ${decision.newAuthFailures}/${AUTH_FAILURE_THRESHOLD})`,
    );
    db.update(schema.federationPeers)
      .set({
        consecutiveAuthFailures: decision.newAuthFailures,
        lastFailureAt: now,
      })
      .where(eq(schema.federationPeers.id, peerId))
      .run();
  }
}

function applyOutboxEntryBackoff(
  db: Pick<ReturnType<typeof getDb>, 'update'>,
  entries: Array<{ outboxId: string; attempts: number | null }>,
  now: number,
): void {
  for (const entry of entries) {
    const newAttempts = (entry.attempts ?? 0) + 1;
    const backoffMs = getBackoffMs(newAttempts);

    db.update(schema.federationOutbox)
      .set({
        attempts: newAttempts,
        nextRetryAt: now + backoffMs,
      })
      .where(eq(schema.federationOutbox.id, entry.outboxId))
      .run();
  }
}

/**
 * A batch got no usable answer: back its rows off and count a network-layer
 * failure against the peer (auth failures use consecutive_auth_failures
 * instead). The threshold's status change is `markPeerUnreachable`.
 */
function handleOutboxDeliveryFailure(
  db: ReturnType<typeof getDb>,
  peerId: string,
  entries: Array<{ outboxId: string; attempts: number | null }>,
  now: number,
): void {
  applyOutboxEntryBackoff(db, entries, now);

  const peer = db
    .select({ consecutiveFailures: schema.federationPeers.consecutiveFailures })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.id, peerId))
    .get();

  const newFailures = (peer?.consecutiveFailures ?? 0) + 1;

  db.update(schema.federationPeers)
    .set({
      lastFailureAt: now,
      consecutiveFailures: newFailures,
    })
    .where(eq(schema.federationPeers.id, peerId))
    .run();

  if (newFailures >= PEER_UNREACHABLE_THRESHOLD) {
    markPeerUnreachable(db, peerId, newFailures);
  }
}

/**
 * The outbox's one peer-status write: a peer that failed
 * PEER_UNREACHABLE_THRESHOLD deliveries in a row becomes `unreachable`. On
 * entry, recovery pacing is reset so processRecoveryTick fires an immediate
 * first probe (lastProbeAt = null) with a fresh backoff.
 */
function markPeerUnreachable(db: ReturnType<typeof getDb>, peerId: string, failures: number): void {
  db.update(schema.federationPeers)
    .set({ status: 'unreachable', probeAttempts: 0, lastProbeAt: null })
    .where(eq(schema.federationPeers.id, peerId))
    .run();

  console.warn(
    `[federation-worker] Peer ${peerId} marked unreachable after ${failures} consecutive failures`,
  );
  onPeerDeactivated(peerId, 'network_threshold').catch(err =>
    console.error('[federation-worker] onPeerDeactivated from unreachable threshold failed:', err)
  );
}

// ─── Pending Peer Resolution ───────────────────────────────────────────────

/**
 * Start a handshake for every pending peer that has outbox entries waiting and
 * whose next attempt is due. Does not wait for them: each attempt runs detached
 * (see pendingPeerHandshakes), so a pending origin that never answers costs the
 * outbox tick nothing, and a given origin has at most one attempt outstanding.
 *
 * Attempts are paced like unreachable-peer recovery (isPeerAttemptDue with
 * RECOVERY_BACKOFF_MS, on the same `last_probe_at` / `probe_attempts` columns):
 * the first is immediate, each failure moves the next one further out.
 */
function resolvePendingPeers(now: number): void {
  const db = getDb();

  // Find distinct pending peers with queued outbox entries
  const pendingWithEntries = db
    .selectDistinct({
      peerId: schema.federationPeers.id,
      peerOrigin: schema.federationPeers.origin,
      probeAttempts: schema.federationPeers.probeAttempts,
      lastProbeAt: schema.federationPeers.lastProbeAt,
    })
    .from(schema.federationPeers)
    .innerJoin(
      schema.federationOutbox,
      eq(schema.federationOutbox.peerId, schema.federationPeers.id),
    )
    .where(eq(schema.federationPeers.status, 'pending'))
    .all();

  for (const peer of pendingWithEntries) {
    if (pendingPeerHandshakes.has(peer.peerOrigin)) continue;
    if (!isPeerAttemptDue(peer, true, now)) continue;

    const attempt = resolvePendingPeer(peer.peerId, peer.peerOrigin, now)
      .catch((err) => {
        console.error(`[federation-worker] Auto-peer attempt with ${peer.peerOrigin} failed:`, err);
      })
      .finally(() => {
        pendingPeerHandshakes.delete(peer.peerOrigin);
      });
    pendingPeerHandshakes.set(peer.peerOrigin, attempt);
  }
}

/**
 * One handshake attempt for a pending peer, via ensurePeered(). A transient
 * failure advances the peer's pacing; `startedAt` is recorded as the attempt's
 * time, as the recovery probe records its tick time.
 */
async function resolvePendingPeer(peerId: string, peerOrigin: string, startedAt: number): Promise<void> {
  const db = getDb();

  // Another caller (a DM send, a friend add, an admin's /peer/initiate) is
  // already handshaking with this origin. Its outcome settles the row; starting
  // a second exchange would only race it. Not an attempt, so pacing is untouched.
  if (isHandshakeInFlight(peerOrigin)) return;

  console.log(`[federation-worker] Attempting auto-peer with ${peerOrigin}...`);

  const result = await ensurePeered(peerOrigin, { kind: 'system' });

  switch (result.status) {
    case 'active':
      console.log(`[federation-worker] Auto-peered with ${peerOrigin} — entries will deliver next tick`);
      // Notify admins of peer state change
      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
      break;

    case 'rejected': {
      console.warn(`[federation-worker] Auto-peering rejected by ${peerOrigin}: ${result.error}`);

      const contextMap = buildContextMapForPeer(db, peerId);

      // Purge outbox entries (NOT mutation log)
      db.delete(schema.federationOutbox)
        .where(eq(schema.federationOutbox.peerId, peerId))
        .run();

      onPeerDeactivated(peerId, 'remote_rejected').catch(err =>
        console.error('[federation-worker] onPeerDeactivated from resolvePendingPeers rejected failed:', err)
      );

      // Push federation_peer_rejected WS event to affected users
      pushPeerRejectedEvent(peerOrigin, contextMap);
      // Notify admins of peer state change
      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
      break;
    }

    case 'failed':
      console.warn(`[federation-worker] Auto-peer with ${peerOrigin} failed (transient): ${result.error}`);
      // Leave the entries and advance the pacing; the next attempt waits out
      // the next step of RECOVERY_BACKOFF_MS.
      db.update(schema.federationPeers)
        .set({
          probeAttempts: sql`${schema.federationPeers.probeAttempts} + 1`,
          lastProbeAt: startedAt,
        })
        .where(and(
          eq(schema.federationPeers.id, peerId),
          eq(schema.federationPeers.status, 'pending'),
        ))
        .run();
      break;

    case 'pending':
    case 'admin_required':
      // The row left `pending` (now awaiting_approval) or the outbound gate
      // removed it; either way this worker has nothing further to retry.
      break;
  }
}

/**
 * Build a map of contextId → contextType for all outbox entries targeting
 * a specific peer. Used for surfacing "delivery impossible" via
 * pushPeerRejectedEvent when a peer is rejected or transitioned to
 * needs_attention.
 */
function buildContextMapForPeer(
  db: ReturnType<typeof getDb>,
  peerId: string,
): Map<string, string> {
  const entries = db
    .select({
      contextId: schema.federationOutbox.contextId,
      contextType: schema.federationOutbox.contextType,
    })
    .from(schema.federationOutbox)
    .where(eq(schema.federationOutbox.peerId, peerId))
    .all();

  const contextMap = new Map<string, string>();
  for (const e of entries) {
    if (!contextMap.has(e.contextId)) {
      contextMap.set(e.contextId, e.contextType);
    }
  }
  return contextMap;
}

/**
 * Push a federation_peer_rejected WS event to all local users affected by
 * the rejection. Resolves contextLabel from the database for each context.
 */
export function pushPeerRejectedEvent(
  peerOrigin: string,
  contextMap: Map<string, string>,
  reasonOverride?: string,
): void {
  const db = getDb();

  // Build affected contexts with human-readable labels
  const affectedContexts: Array<{
    contextType: 'dm' | 'friend';
    contextId: string;
    contextLabel: string;
  }> = [];

  const affectedUserIds = new Set<string>();

  for (const [contextId, contextType] of contextMap) {
    if (contextType === 'dm') {
      // Resolve DM member names for the label
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

      const names = members
        .map(m => m.displayName || m.username || 'Unknown')
        .slice(0, 4)
        .join(', ');

      affectedContexts.push({
        contextType: 'dm',
        contextId,
        contextLabel: names,
      });

      // Track local users to notify (non-federated members)
      for (const m of members) {
        if (!m.homeInstance) {
          affectedUserIds.add(m.userId);
        }
      }
    } else if (contextType === 'friend') {
      affectedContexts.push({
        contextType: 'friend',
        contextId,
        contextLabel: contextId, // friend context IDs include usernames
      });
    }
  }

  // Try to get the instance name for a better label
  let peerLabel: string | undefined;
  const peerRow = db
    .select({ instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, peerOrigin))
    .get();
  if (peerRow?.instanceName) {
    peerLabel = peerRow.instanceName;
  }

  const event = {
    type: 'federation_peer_rejected' as const,
    peerOrigin,
    peerLabel,
    reason: reasonOverride || 'Remote instance requires manual peering approval',
    affectedContexts,
  };

  for (const userId of affectedUserIds) {
    connectionManager.sendToUser(userId, event);
  }
}

// ─── File Queue Download Worker ─────────────────────────────────────────────

function scheduleFileQueueTick(): void {
  fileQueueTimer = setTimeout(() => {
    processFileQueueTick().catch((err) => {
      console.error('[federation-worker] File queue tick error:', err);
    }).finally(() => {
      scheduleFileQueueTick();
    });
  }, FILE_QUEUE_INTERVAL_MS);
}

async function processFileQueueTick(): Promise<void> {
  if (!isFederationRelayEnabled()) {
    return;
  }

  const db = getDb();
  const now = Date.now();

  const pending = db
    .select()
    .from(schema.federationFileQueue)
    .where(
      and(
        eq(schema.federationFileQueue.status, 'pending'),
        lte(schema.federationFileQueue.nextRetryAt, now),
      ),
    )
    .limit(FILE_QUEUE_BATCH_LIMIT)
    .all();

  if (pending.length === 0) {
    return;
  }

  const maxUploadSize = getMaxUploadSize();

  for (const entry of pending) {
    await processFileQueueEntry(db, entry, maxUploadSize, now);
  }
}

function handleSizeRejection(
  db: ReturnType<typeof getDb>,
  entry: typeof schema.federationFileQueue.$inferSelect,
  maxUploadSize: number,
  now: number,
): void {
  // Look up the local DM message to find the sender and channel info
  const localMsg = db.select()
    .from(schema.dmMessages)
    .where(eq(schema.dmMessages.id, entry.dmMessageId))
    .get();

  if (!localMsg || !localMsg.sourceInstance || !localMsg.sourceMessageId) return;

  // Find the attachment row to get its ID
  const att = db.select()
    .from(schema.attachments)
    .where(
      and(
        eq(schema.attachments.dmMessageId, entry.dmMessageId),
        eq(schema.attachments.sourceUrl, entry.sourceUrl),
      ),
    )
    .get();

  // Resolve the sender's username from their local replicated user stub
  const senderUser = db.select()
    .from(schema.users)
    .where(eq(schema.users.id, localMsg.userId))
    .get();
  const sourceUsername = senderUser?.displayName || senderUser?.username || 'unknown';

  // Update attachment federation status
  if (att) {
    db.update(schema.attachments)
      .set({
        federationStatus: 'remote',
        federationMeta: JSON.stringify({
          sourceInstance: localMsg.sourceInstance,
          sourceUserId: localMsg.userId,
          sourceUsername,
        }),
      })
      .where(eq(schema.attachments.id, att.id))
      .run();
  }

  // Find local DM members native to THIS instance
  const ourOrigin = getOurOrigin();
  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, localMsg.dmChannelId))
    .all();
  const affectedUserIds: string[] = [];
  for (const member of dmMembers) {
    const user = db.select()
      .from(schema.users)
      .where(eq(schema.users.id, member.userId))
      .get();
    const userHome = user?.homeInstance?.startsWith('http') ? user.homeInstance : user?.homeInstance ? `https://${user.homeInstance}` : null;
    if (user && (!user.homeInstance || userHome === ourOrigin)) {
      affectedUserIds.push(user.homeUserId || user.id);
    }
  }

  // Queue a file_rejected reverse relay event to the sender's instance
  // Extract the filename from the sourceUrl (e.g., "https://sender/api/uploads/12345.png" → "12345.png")
  const sourceFilename = entry.sourceUrl.split('/').pop() ?? entry.sourceUrl;

  const event: FederationRelayEvent = {
    eventType: 'file_rejected',
    messageId: localMsg.sourceMessageId,
    encryptionVersion: 0,
    timestamp: now,
    attachmentId: att?.id ?? entry.sourceUrl,
    sourceFilename,
    rejectionReason: 'size_limit_exceeded',
    rejectionLimit: maxUploadSize,
    affectedUserIds,
  };

  appendMutationLog(
    localMsg.sourceMessageId,
    localMsg.dmChannelId,
    'file_rejected',
    JSON.stringify({
      attachmentId: att?.id ?? entry.sourceUrl,
      sourceFilename,
      rejectionReason: 'size_limit_exceeded',
      rejectionLimit: maxUploadSize,
      affectedUserIds,
    }),
  );
  queueOutboxEvent(
    localMsg.sourceMessageId,
    localMsg.dmChannelId,
    'file_rejected',
    JSON.stringify(event),
    [localMsg.sourceInstance],
  );

  // Broadcast updated message to local clients so they see the 'remote' badge
  const updatedMsg = getDmMessageWithUser(entry.dmMessageId);
  if (updatedMsg) {
    connectionManager.sendToDmMembers(updatedMsg.dmChannelId, {
      type: 'dm_message_updated',
      message: updatedMsg,
    });
  }
}

async function processFileQueueEntry(
  db: ReturnType<typeof getDb>,
  entry: typeof schema.federationFileQueue.$inferSelect,
  maxUploadSize: number,
  now: number,
): Promise<void> {
  // SSRF protection: sourceUrl must start at the peer host; safeFetch below
  // re-validates DNS and every redirect hop before downloading bytes.
  try {
    const sourceHostname = new URL(entry.sourceUrl).hostname;
    const peerHostname = new URL(entry.peerOrigin).hostname;
    if (sourceHostname !== peerHostname) {
      console.warn(
        `[federation-worker] SSRF blocked: sourceUrl hostname "${sourceHostname}" does not match peer origin "${peerHostname}" for file queue entry ${entry.id}`,
      );
      db.update(schema.federationFileQueue)
        .set({
          status: 'rejected',
          rejectionReason: 'ssrf_hostname_mismatch',
        })
        .where(eq(schema.federationFileQueue.id, entry.id))
        .run();
      return;
    }
  } catch {
    db.update(schema.federationFileQueue)
      .set({
        status: 'rejected',
        rejectionReason: 'invalid_url',
      })
      .where(eq(schema.federationFileQueue.id, entry.id))
      .run();
    return;
  }

  // Check file size against limit
  if (entry.size > maxUploadSize) {
    db.update(schema.federationFileQueue)
      .set({
        status: 'rejected',
        rejectionReason: 'size_limit_exceeded',
      })
      .where(eq(schema.federationFileQueue.id, entry.id))
      .run();
    handleSizeRejection(db, entry, maxUploadSize, now);
    return;
  }

  // Create abort controller for this download
  fileQueueAbortController = new AbortController();

  try {
    const response = await safeFetch(entry.sourceUrl, {
      signal: AbortSignal.any([
        fileQueueAbortController.signal,
        AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
      ]),
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} downloading file from ${entry.sourceUrl}`);
    }

    // Generate a unique local filename using the same pattern as the upload route
    const ext = path.extname(entry.originalName) || '';
    const localId = generateSnowflake();
    const localFilename = `${localId}${ext}`;
    const localPath = path.join(config.uploadDir, localFilename);

    // Ensure upload directory exists
    fs.mkdirSync(config.uploadDir, { recursive: true });

    // Stream the response body to disk
    const nodeStream = Readable.fromWeb(response.body as ReadableStream);
    const writeStream = fs.createWriteStream(localPath);

    try {
      await pipeline(nodeStream, writeStream);
    } catch (pipeErr) {
      // Clean up partial file on failure
      try { fs.unlinkSync(localPath); } catch { /* ignore cleanup errors */ }
      throw pipeErr;
    }

    // Verify file was written and get actual size
    const stat = fs.statSync(localPath);

    // Check actual downloaded size against limit (defense in depth)
    if (stat.size > maxUploadSize) {
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      db.update(schema.federationFileQueue)
        .set({
          status: 'rejected',
          rejectionReason: 'size_limit_exceeded',
        })
        .where(eq(schema.federationFileQueue.id, entry.id))
        .run();
      handleSizeRejection(db, entry, maxUploadSize, now);
      return;
    }

    // Generate thumbnail for images (same as local upload flow)
    let thumbnailFilename: string | null = null;
    try {
      thumbnailFilename = await generateThumbnail(localPath, entry.mimetype, config.uploadDir);
    } catch {
      // Non-fatal — full image will be used instead
    }

    // Update the existing attachment row (created by processCreateEvent with
    // sourceUrl as interim filename) to point to the local file
    const updated = db.update(schema.attachments)
      .set({
        filename: localFilename,
        size: stat.size,
        thumbnailFilename,
      })
      .where(
        and(
          eq(schema.attachments.dmMessageId, entry.dmMessageId),
          eq(schema.attachments.sourceUrl, entry.sourceUrl),
        ),
      )
      .run();

    // Fallback: if no existing row was found (e.g., legacy queue entry from
    // before processCreateEvent created rows), insert a new one
    if (updated.changes === 0) {
      db.insert(schema.attachments)
        .values({
          id: generateSnowflake(),
          dmMessageId: entry.dmMessageId,
          uploaderId: null,
          filename: localFilename,
          originalName: entry.originalName,
          mimetype: entry.mimetype,
          size: stat.size,
          thumbnailFilename,
          sourceUrl: entry.sourceUrl,
          createdAt: now,
        })
        .run();
    }

    // Mark file queue entry as completed
    db.update(schema.federationFileQueue)
      .set({
        status: 'completed',
        targetFilename: localFilename,
      })
      .where(eq(schema.federationFileQueue.id, entry.id))
      .run();

    console.log(
      `[federation-worker] Downloaded federated file: ${entry.originalName} -> ${localFilename}`,
    );

    // Notify connected clients that the attachment is now available locally
    const updatedMsg = getDmMessageWithUser(entry.dmMessageId);
    if (updatedMsg) {
      connectionManager.sendToDmMembers(updatedMsg.dmChannelId, {
        type: 'dm_message_updated',
        message: updatedMsg,
      });
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Worker is stopping — leave entry as pending for next tick
      return;
    }

    console.error(
      `[federation-worker] Failed to download file ${entry.originalName} from ${entry.peerOrigin}:`,
      err instanceof Error ? err.message : err,
    );

    const newAttempts = (entry.attempts ?? 0) + 1;

    if (newAttempts > MAX_FILE_ATTEMPTS) {
      db.update(schema.federationFileQueue)
        .set({
          status: 'failed',
          attempts: newAttempts,
          rejectionReason: 'max_attempts_exceeded',
        })
        .where(eq(schema.federationFileQueue.id, entry.id))
        .run();
    } else {
      const backoffMs = getBackoffMs(newAttempts);
      db.update(schema.federationFileQueue)
        .set({
          attempts: newAttempts,
          nextRetryAt: now + backoffMs,
        })
        .where(eq(schema.federationFileQueue.id, entry.id))
        .run();
    }
  }
}

// ─── Recovery Worker (demand-driven) ─────────────────────────────────────────

function scheduleRecoveryTick(): void {
  recoveryTimer = setTimeout(() => {
    processRecoveryTick().catch((err) => {
      console.error('[federation-worker] Recovery tick error:', err);
    }).finally(() => {
      scheduleRecoveryTick();
    });
  }, RECOVERY_TICK_INTERVAL_MS);
}

/**
 * Probe unreachable peers and recover them. Cadence is demand-driven: peers with
 * queued outbox mail are probed on RECOVERY_BACKOFF_MS (indexed by probe_attempts);
 * silent peers fall back to the HEALTH_CHECK_INTERVAL_MS backstop. Probes run
 * sequentially to bound outbound concurrency; the candidate set is small.
 */
export async function processRecoveryTick(): Promise<void> {
  const db = getDb();
  const now = Date.now();

  const unreachablePeers = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.status, 'unreachable'))
    .all();

  for (const peer of unreachablePeers) {
    const pending = db
      .select({ id: schema.federationOutbox.id })
      .from(schema.federationOutbox)
      .where(eq(schema.federationOutbox.peerId, peer.id))
      .limit(1)
      .get();

    if (!isPeerAttemptDue(peer, pending !== undefined, now)) continue;

    recoveryAbortController = new AbortController();
    const probe = await probePeerReachable(peer.origin, recoveryAbortController.signal);

    if (probe.reachable) {
      const outcome = await recoverOrDetectReset(peer, probe);
      if (outcome === 'reset_detected') {
        console.warn(`[federation-worker] Peer ${peer.origin} reset detected (new instance epoch) — routed to needs_attention`);
      } else {
        console.log(`[federation-worker] Peer ${peer.origin} recovered — marked active`);
      }
    } else {
      db.update(schema.federationPeers)
        .set({ probeAttempts: peer.probeAttempts + 1, lastProbeAt: now })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();
    }
  }
}

// ─── Health Check Worker ────────────────────────────────────────────────────

function scheduleHealthCheckTick(): void {
  healthCheckTimer = setTimeout(() => {
    processHealthCheckTick().catch((err) => {
      console.error('[federation-worker] Health check tick error:', err);
    }).finally(() => {
      scheduleHealthCheckTick();
    });
  }, HEALTH_CHECK_INTERVAL_MS);
}

async function processHealthCheckTick(): Promise<void> {
  const db = getDb();

  // ── Grace period finalization ──────────────────────────────────────────────
  // Promote pending secrets that have completed their grace period.
  const rotatingPeers = db
    .select()
    .from(schema.federationPeers)
    .where(
      and(
        sql`${schema.federationPeers.pendingHmacSecret} IS NOT NULL`,
        sql`${schema.federationPeers.secretRotationAt} IS NOT NULL`,
      ),
    )
    .all();

  for (const peer of rotatingPeers) {
    const elapsed = Date.now() - (peer.secretRotationAt ?? 0);
    if (elapsed > ROTATION_GRACE_PERIOD_MS) {
      db.update(schema.federationPeers)
        .set({
          hmacSecret: peer.pendingHmacSecret!,
          pendingHmacSecret: null,
          secretRotationAt: null,
          secretRotatedAt: Date.now(),
        })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();
      console.log(`[federation-worker] Secret rotation finalized for peer ${peer.origin}`);
    }
  }

  // ── Auto-rotation ──────────────────────────────────────────────────────────
  // Initiate rotation for active peers whose secret has aged past the threshold.
  const autoRotateCandidates = db
    .select()
    .from(schema.federationPeers)
    .where(
      and(
        eq(schema.federationPeers.status, 'active'),
        sql`${schema.federationPeers.pendingHmacSecret} IS NULL`,
        sql`${schema.federationPeers.autoRotateIntervalDays} > 0`,
      ),
    )
    .all();

  const ourOrigin = getOurOrigin();

  for (const peer of autoRotateCandidates) {
    const lastRotation = peer.secretRotatedAt ?? peer.createdAt;
    const intervalMs = peer.autoRotateIntervalDays * 86_400_000;
    if (Date.now() - lastRotation < intervalMs) continue;

    // Time to rotate
    const newSecret = generateHmacSecret();

    try {
      const rotateBody = JSON.stringify({ newSecret });
      const headers = buildFederationHeaders(rotateBody, peer.hmacSecret, ourOrigin);

      const response = await federationFetch(peer.origin, '/api/federation/peer/rotate', {
        method: 'POST',
        headers,
        body: rotateBody,
        signal: AbortSignal.timeout(10_000),
      }, 'approved');

      if (response.ok) {
        // Store pending locally AFTER remote peer confirms acceptance
        db.update(schema.federationPeers)
          .set({
            pendingHmacSecret: newSecret,
            secretRotationAt: Date.now(),
          })
          .where(eq(schema.federationPeers.id, peer.id))
          .run();
        console.log(`[federation-worker] Auto-rotation initiated with peer ${peer.origin}`);
      } else {
        console.warn(`[federation-worker] Auto-rotation rejected by peer ${peer.origin} (HTTP ${response.status})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[federation-worker] Auto-rotation failed for peer ${peer.origin}: ${message}`);
    }
  }

  // ── Deterministic baseline epoch-refresh ────────────────────────────────────
  // Populate-if-null, self-terminating: fill peer_instance_id for active peers
  // whose baseline is still NULL (design §3.2). Runs every tick so the baseline
  // is established within one 15-minute cycle of an upgrade, independent of any
  // relay/user activity. Best-effort — a failed fetch is a benign no-op retried
  // next tick, so it never disturbs the rest of the health-check work.
  await refreshPeerEpochs().catch(() => {});

  // ── Reset detection for needs_attention peers (design §4.1) ─────────────────
  // A reset peer can land in `needs_attention` via the auth-failure path (HTTP
  // up, 401/403 from a new incarnation) WITHOUT ever passing through
  // `unreachable`, so the unreachable-only recovery probe never observes its
  // epoch change. Probe those peers here so a reset journal is created at
  // detection time (otherwise a later manual Re-peer heals nothing). Detection
  // ONLY — never flips a needs_attention peer to active. Best-effort: a failure
  // is a benign no-op retried next tick and must not disturb the rest of the tick.
  // No shared abort signal — probePeerReachable carries its own 10s timeout.
  await detectResetOnNeedsAttentionPeers().catch(() => {});
}

// ─── Federated Call Health Sweep ────────────────────────────────────────────
//
// Periodic backstop: iterate active FederatedCallEntry objects, look up each
// distinct host's peer status, and evict entries whose host is non-active.
// Covers the gap where a peer transitioned to non-active outside of any hook
// site, or was already non-active when the entry was created.
//
// Latency note: real eviction = peer-status-update-lag + tick-period (≤30s).
// Worst case 15.5min for idle instances with no outbox traffic (health-check
// worker is the only status source). Documented in the design spec.

export const FEDERATED_CALL_SENTINEL_MS = 30_000;

export async function runFederatedCallSentinelTick(): Promise<void> {
  const calls = connectionManager.getAllFederatedCalls();
  if (calls.size === 0) return;

  const distinctHosts = new Set<string>();
  for (const entry of calls.values()) {
    distinctHosts.add(entry.federatedCallHost);
  }

  const db = getDb();
  for (const host of distinctHosts) {
    const row = db
      .select({
        status: schema.federationPeers.status,
        instanceName: schema.federationPeers.instanceName,
      })
      .from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, host))
      .get();

    if (row && row.status === 'active') continue;

    const isRejectedLike = row?.status === 'rejected' || row?.status === 'revoked';
    const reason: 'peer_rejected' | 'peer_transient_failure' =
      isRejectedLike ? 'peer_rejected' : 'peer_transient_failure';

    connectionManager.evictFederatedCallsForHost(host, {
      reason,
      peerLabel: row?.instanceName ?? undefined,
    });
  }
}

let federatedCallSentinelTimer: ReturnType<typeof setInterval> | null = null;

// ─── Janitor Worker ──────────────────────────────────────────────────────────

function scheduleJanitorTick(): void {
  janitorTimer = setTimeout(() => {
    runFederationJanitor();
    scheduleJanitorTick();
  }, JANITOR_INTERVAL_MS);
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export function startFederationWorkers(): void {
  console.log('[federation-worker] Federation workers started');
  scheduleOutboxTick();
  scheduleFileQueueTick();
  scheduleHealthCheckTick();
  scheduleRecoveryTick();
  scheduleJanitorTick();
  federatedCallSentinelTimer = setInterval(() => {
    runFederatedCallSentinelTick().catch(err =>
      console.error('[federation-worker] federatedCallSentinel tick failed:', err)
    );
  }, FEDERATED_CALL_SENTINEL_MS);
  // Deterministic baseline epoch-refresh at startup (design §3.2): populate
  // peer_instance_id for any active peer whose baseline is still NULL, so an
  // instance that upgrades sees its peers' epochs within one cycle regardless of
  // traffic. Best-effort, self-terminating (populate-if-null).
  refreshPeerEpochs().catch(() => {});

  // Bootstrap sync for freshly-peered rows (async, non-blocking)
  startupBootstrapSync().catch((err) => {
    console.error('[federation-worker] Startup bootstrap sync error:', err);
  });

  // Startup reset-detection sweep: probe every peer already parked in
  // `needs_attention` for an epoch change. This catches a peer that was reset
  // while this instance was down (so no live transition fired) AND any peer that
  // crossed into needs_attention before this build shipped the event-driven
  // probe — surfacing "Re-peer & heal" immediately on boot instead of on the
  // next 15-minute health-check cycle. Best-effort, detection-only.
  detectResetOnNeedsAttentionPeers().catch((err) => {
    console.error('[federation-worker] Startup reset-detection sweep error:', err);
  });

  // Remove dead-incarnation artifacts left by pre-fix initial syncs (spec §3.4).
  try {
    sweepDeadIncarnationArtifacts();
  } catch (err) {
    console.error('[federation-worker] Dead-incarnation sweep error:', err);
  }

  // Backfill any replicated user avatars/banners still stored as absolute URLs
  // (legacy data from before file replication, or rows whose home was offline
  // on a previous attempt). Best-effort and idempotent — safe to re-run.
  backfillReplicatedProfileAssets().catch((err) => {
    console.error('[federation-worker] Replicated profile asset backfill error:', err);
  });
}

export function stopFederationWorkers(): void {
  if (outboxTimer) {
    clearTimeout(outboxTimer);
    outboxTimer = null;
  }
  if (fileQueueTimer) {
    clearTimeout(fileQueueTimer);
    fileQueueTimer = null;
  }
  if (healthCheckTimer) {
    clearTimeout(healthCheckTimer);
    healthCheckTimer = null;
  }
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }

  if (janitorTimer) {
    clearTimeout(janitorTimer);
    janitorTimer = null;
  }

  if (federatedCallSentinelTimer) {
    clearInterval(federatedCallSentinelTimer);
    federatedCallSentinelTimer = null;
  }

  outboxAbortController?.abort();
  outboxAbortController = null;

  fileQueueAbortController?.abort();
  fileQueueAbortController = null;

  recoveryAbortController?.abort();
  recoveryAbortController = null;

  console.log('[federation-worker] Federation workers stopped');
}
