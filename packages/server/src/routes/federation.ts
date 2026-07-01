import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { eq, and, or, isNull, inArray, sql, desc } from 'drizzle-orm';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { generateHmacSecret, getOurOrigin, parseFederationHeaders, verifySignature, verifyPeerSignature, buildFederationHeaders, normalizeOriginForCompare, canonicalizeHomeInstance } from '../utils/federationAuth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { getDb, getRawDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { connectionManager } from '../ws/handler.js';
import type { FederatedCallEntry, DmRoomMeta } from '../ws/handler.js';
import { mapCallReasonToEventReason, type CallFanoutFailure } from '../utils/federationOutbox.js';
import type { DmCallUndeliverableFailure } from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';
import { deleteAttachmentFiles, deleteUploadFile } from '../utils/fileCleanup.js';
import { tombstoneUser, collectDeletionBroadcastTargets, collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';
import { computeFederatedId, getDmParticipants, sendCallRelay } from '../utils/federationOutbox.js';
import { onPeerActivated, onPeerDeactivated } from '../utils/federationPeerActivation.js';
import { getInstanceId } from '../utils/federationEpoch.js';
import { probePeerReachable, recoverOrDetectReset } from '../utils/federationRecovery.js';
import { markPeerReset } from '../utils/federationReset.js';
import { getDmMessageWithUser } from './dm.js';
import type { FederationRelayRequest, FederationRelayResponse, FederationRelayEvent, FederationRelayAttachment, FederationSyncRequest, FederationSyncResponse, DmMessageWithUser, DmChannel, FederationRelayProfileSnapshot, FederationIdentityDeleteS2SRequest, FederationProfileUpdatePayload, ServerEvent, ApprovalRequestSubscriberSummary, PeeringTriggerReason } from '@backspace/shared';
import { GROUP_DM_NAME_MIN_LENGTH, GROUP_DM_NAME_MAX_LENGTH } from '@backspace/shared/src/constants.js';

/** Fields safe to expose to admin callers (everything except hmacSecret). */
interface SanitizedPeer {
  id: string;
  origin: string;
  instanceName: string | null;
  status: string;
  lastSeenAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  lastSyncedAt: number | null;
  createdAt: number;
  rotationInProgress: boolean;
  secretRotatedAt: number | null;
  autoRotateIntervalDays: number;
}

function sanitizePeer(row: typeof schema.federationPeers.$inferSelect): SanitizedPeer {
  return {
    id: row.id,
    origin: row.origin,
    instanceName: row.instanceName,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    lastFailureAt: row.lastFailureAt,
    consecutiveFailures: row.consecutiveFailures,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    rotationInProgress: row.pendingHmacSecret !== null,
    secretRotatedAt: row.secretRotatedAt,
    autoRotateIntervalDays: row.autoRotateIntervalDays,
  };
}

/**
 * Determine this instance's public origin.
 * Prefer the explicit DOMAIN env var; fall back to the request Host header.
 */
function resolveLocalOrigin(request: { headers: Record<string, string | string[] | undefined> }): string {
  if (config.domain) {
    return `https://${config.domain}`;
  }
  const hostHeader = request.headers.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host) {
    throw new Error('Cannot determine local origin: no DOMAIN configured and no Host header');
  }
  const protocol = (request as Record<string, unknown>).protocol === 'https' ? 'https' : 'http';
  return `${protocol}://${host}`;
}

/**
 * Validate that a string is a well-formed HTTP(S) URL origin.
 * Returns the normalized origin (no trailing slash) or null if invalid.
 */
export function validateOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

// ─── In-memory rate limiter for the accept endpoint ──────────────────────────
const acceptRateBuckets = new Map<string, number[]>();
const ACCEPT_RATE_WINDOW_MS = 60_000;
const ACCEPT_RATE_MAX = 10;

function isAcceptRateLimited(ip: string): boolean {
  const now = Date.now();
  let timestamps = acceptRateBuckets.get(ip);
  if (!timestamps) {
    timestamps = [];
    acceptRateBuckets.set(ip, timestamps);
  }
  // Prune entries outside the window
  const cutoff = now - ACCEPT_RATE_WINDOW_MS;
  while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= ACCEPT_RATE_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

// ─── In-memory rate limiter for the relay endpoint (per-peer) ────────────────
const relayRateBuckets = new Map<string, number[]>();
const RELAY_RATE_WINDOW_MS = 60_000;
const RELAY_RATE_MAX = 90;

function isRelayRateLimited(peerOrigin: string): boolean {
  const now = Date.now();
  let timestamps = relayRateBuckets.get(peerOrigin);
  if (!timestamps) {
    timestamps = [];
    relayRateBuckets.set(peerOrigin, timestamps);
  }
  const cutoff = now - RELAY_RATE_WINDOW_MS;
  while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= RELAY_RATE_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

// ─── In-memory rate limiter for the user-lookup endpoint (per-peer) ──────────
const lookupRateBuckets = new Map<string, number[]>();
const LOOKUP_RATE_WINDOW_MS = 60_000;
const LOOKUP_RATE_MAX = 60;

function isLookupRateLimited(peerOrigin: string): boolean {
  const now = Date.now();
  let timestamps = lookupRateBuckets.get(peerOrigin);
  if (!timestamps) {
    timestamps = [];
    lookupRateBuckets.set(peerOrigin, timestamps);
  }
  const cutoff = now - LOOKUP_RATE_WINDOW_MS;
  while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= LOOKUP_RATE_MAX) return true;
  timestamps.push(now);
  return false;
}

// Test-only export — used by federation.userLookup.test.ts to reset between cases.
export function _resetLookupRateBuckets(): void {
  lookupRateBuckets.clear();
}

// ─── In-memory rate limiter for the ensure endpoint (per-user) ─────────────
const ensureRateBuckets = new Map<string, number[]>();
const ENSURE_RATE_WINDOW_MS = 15 * 60_000; // 15 minutes
const ENSURE_RATE_MAX = 3;

function isEnsureRateLimited(userId: string): boolean {
  const now = Date.now();
  let timestamps = ensureRateBuckets.get(userId);
  if (!timestamps) {
    timestamps = [];
    ensureRateBuckets.set(userId, timestamps);
  }
  const cutoff = now - ENSURE_RATE_WINDOW_MS;
  while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= ENSURE_RATE_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

// Clean up stale ensure rate limit buckets every 15 minutes
setInterval(() => {
  const cutoff = Date.now() - ENSURE_RATE_WINDOW_MS;
  for (const [userId, timestamps] of ensureRateBuckets) {
    while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) {
      ensureRateBuckets.delete(userId);
    }
  }
}, ENSURE_RATE_WINDOW_MS).unref();

// ─── In-memory nonce store for replay protection (per-peer) ──────────────────
// Maps peerOrigin → (nonce → insertion timestamp). Nonces are evicted after
// NONCE_MAX_AGE_MS (15 min) to match the HMAC timestamp window.
const NONCE_MAX_AGE_MS = 15 * 60 * 1000;
const nonceStore = new Map<string, Map<string, number>>();

/** Returns true if the nonce is a duplicate (already seen for this peer). */
function isNonceDuplicate(peerOrigin: string, nonce: string): boolean {
  let peerNonces = nonceStore.get(peerOrigin);
  if (!peerNonces) {
    peerNonces = new Map();
    nonceStore.set(peerOrigin, peerNonces);
  }
  if (peerNonces.has(nonce)) return true;
  peerNonces.set(nonce, Date.now());
  return false;
}

// Periodically clean stale buckets to prevent unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - ACCEPT_RATE_WINDOW_MS;
  for (const [ip, timestamps] of acceptRateBuckets) {
    while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) {
      acceptRateBuckets.delete(ip);
    }
  }
  const relayCutoff = Date.now() - RELAY_RATE_WINDOW_MS;
  for (const [origin, timestamps] of relayRateBuckets) {
    while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < relayCutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) {
      relayRateBuckets.delete(origin);
    }
  }
  // Evict expired nonces
  const nonceCutoff = Date.now() - NONCE_MAX_AGE_MS;
  for (const [origin, nonces] of nonceStore) {
    for (const [nonce, ts] of nonces) {
      if (ts < nonceCutoff) nonces.delete(nonce);
    }
    if (nonces.size === 0) nonceStore.delete(origin);
  }
}, ACCEPT_RATE_WINDOW_MS).unref();

/**
 * Queue an inbound peer/accept request for local-admin approval.
 *
 * Called from `/peer/accept` when:
 *   (a) `autoAcceptPeering=0` and no `pending`/`awaiting_approval` peer row
 *       exists for the source origin (first-contact request from remote), OR
 *   (b) the receiver is in `awaiting_approval` for this origin but the
 *       inbound `/peer/accept` cannot be cryptographically verified
 *       (token absent or mismatched) — see spec §3.5.
 *
 * Generates a fresh single-use approval token, upserts the
 * `peer_approval_requests` row, notifies admins, and returns 202 with the
 * token in the body. The initiator stores the token alongside its
 * `awaiting_approval` row so a future `/peer/accept` from this side's
 * `/approve` endpoint can verify mutual admin approval.
 */
function queueApprovalRequest(
  db: ReturnType<typeof getDb>,
  reply: FastifyReply,
  sourceOrigin: string,
  hmacSecret: string,
  reqInstanceName: string | null,
): FastifyReply {
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const approvalToken = randomBytes(32).toString('hex');

  const existingRequest = db
    .select({ id: schema.peerApprovalRequests.id })
    .from(schema.peerApprovalRequests)
    .where(eq(schema.peerApprovalRequests.origin, sourceOrigin))
    .get();

  if (existingRequest) {
    db.update(schema.peerApprovalRequests)
      .set({
        instanceName: reqInstanceName,
        hmacSecret,
        requestedAt: now,
        expiresAt: now + THIRTY_DAYS_MS,
        approvalToken,
      })
      .where(eq(schema.peerApprovalRequests.id, existingRequest.id))
      .run();
  } else {
    db.insert(schema.peerApprovalRequests)
      .values({
        id: generateSnowflake(),
        origin: sourceOrigin,
        instanceName: reqInstanceName,
        hmacSecret,
        requestedAt: now,
        expiresAt: now + THIRTY_DAYS_MS,
        approvalToken,
      })
      .run();
  }

  connectionManager.sendToAdmins({
    type: 'federation_approval_request_received' as const,
    origin: sourceOrigin,
    instanceName: reqInstanceName ?? undefined,
  });

  return reply.code(202).send({
    queued: true,
    message: 'Request queued for admin approval',
    approvalToken,
  });
}

/**
 * Inbound approve — admin accepts a remote instance's peering request.
 * Generates fresh HMAC, sends `/peer/accept` to the remote, and on success
 * activates the peer locally. Preserves the historical behavior verbatim;
 * extracted from the route handler so the dispatcher can branch on direction.
 */
async function handleInboundApprove(
  approvalReq: typeof schema.peerApprovalRequests.$inferSelect,
  localOrigin: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const db = getDb();
  const id = approvalReq.id;

  const existingPeer = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, approvalReq.origin))
    .get();

  if (existingPeer && existingPeer.status === 'active') {
    db.delete(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, id))
      .run();
    return reply.code(200).send({ success: true, peer: sanitizePeer(existingPeer) });
  }

  if (existingPeer) {
    db.delete(schema.federationPeers)
      .where(eq(schema.federationPeers.id, existingPeer.id))
      .run();
  }

  const hmacSecret = generateHmacSecret();
  const peerId = generateSnowflake();
  const now = Date.now();

  db.insert(schema.federationPeers).values({
    id: peerId,
    origin: approvalReq.origin,
    instanceName: approvalReq.instanceName,
    hmacSecret,
    status: 'pending',
    createdAt: now,
  }).run();

  try {
    const instanceName = db
      .select({ name: schema.instanceSettings.instanceName })
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.id, 1))
      .get()?.name ?? undefined;

    const response = await fetch(`${approvalReq.origin}/api/federation/peer/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceOrigin: localOrigin,
        hmacSecret,
        instanceName,
        instanceId: getInstanceId(),
        // Forward the stored token (issued in our 202 response when the
        // remote first sent /peer/accept). Lets the remote verify mutual
        // admin approval. Spec §3.7.
        ...(approvalReq.approvalToken ? { approvalToken: approvalReq.approvalToken } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 202) {
      // Remote instance also has autoAcceptPeering off — they queued our request.
      // Don't activate our peer. Set to awaiting_approval until their admin also approves.
      // Capture the approval token they returned so the next inbound
      // /peer/accept (when their admin approves) can be verified. §3.7.
      let returnedToken: string | null = null;
      try {
        const body = (await response.json()) as { approvalToken?: string };
        if (typeof body?.approvalToken === 'string' && body.approvalToken.length > 0) {
          returnedToken = body.approvalToken;
        }
      } catch {
        // Non-JSON / empty body — legacy peer.
      }

      db.update(schema.federationPeers)
        .set({ status: 'awaiting_approval', approvalToken: returnedToken })
        .where(eq(schema.federationPeers.id, peerId))
        .run();
      // Delete the approval request since we already acted on it
      db.delete(schema.peerApprovalRequests)
        .where(eq(schema.peerApprovalRequests.id, id))
        .run();
      return reply.code(200).send({
        success: true,
        awaitingRemoteApproval: true,
        message: 'Remote instance also requires admin approval. Your request has been queued on their side.',
      });
    }

    if (!response.ok) {
      let errorMessage = `Remote instance rejected handshake (HTTP ${response.status})`;
      try {
        const body = await response.json() as { error?: string };
        if (body.error) errorMessage = body.error;
      } catch { /* ignore */ }

      db.delete(schema.federationPeers)
        .where(eq(schema.federationPeers.id, peerId))
        .run();
      return reply.code(502).send({ error: errorMessage, statusCode: 502 });
    }

    // Parse the remote's instanceName and instanceId (epoch) from the response
    // body so the federation panel renders a friendly label and we record the
    // peer's authenticated epoch baseline. Tolerate omission and non-JSON
    // bodies — same pattern as performHandshake and /peer/initiate.
    let remoteInstanceName: string | null = null;
    let remoteInstanceId: string | null = null;
    try {
      const body = (await response.json()) as { instanceName?: string | null; instanceId?: string | null };
      if (typeof body?.instanceName === 'string' && body.instanceName.length > 0) {
        remoteInstanceName = body.instanceName;
      }
      if (typeof body?.instanceId === 'string' && body.instanceId.length > 0) {
        remoteInstanceId = body.instanceId;
      }
    } catch {
      // Non-JSON body — leave null.
    }

    db.update(schema.federationPeers)
      .set({ status: 'active', lastSeenAt: now, instanceName: remoteInstanceName, peerInstanceId: remoteInstanceId, approvalToken: null })
      .where(eq(schema.federationPeers.id, peerId))
      .run();

    db.delete(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, id))
      .run();

    connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
    onPeerActivated(peerId, 'approval_handshake').catch(err =>
      console.error('[federation] onPeerActivated from /approval-requests/:id/approve failed:', err)
    );

    const peer = db
      .select()
      .from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, peerId))
      .get();

    return reply.code(200).send({ success: true, peer: peer ? sanitizePeer(peer) : undefined });
  } catch (err: unknown) {
    db.delete(schema.federationPeers)
      .where(eq(schema.federationPeers.id, peerId))
      .run();

    const message = err instanceof Error ? err.message : 'Unknown error';
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return reply.code(504).send({
        error: 'Remote instance did not respond within 10 seconds',
        statusCode: 504,
      });
    }
    return reply.code(502).send({
      error: `Failed to reach remote instance: ${message}`,
      statusCode: 502,
    });
  }
}

/**
 * Outbound approve — admin authorizes the local instance to peer with a
 * remote that one or more of its users have requested. Generates fresh HMAC,
 * sends `/peer/accept` to the remote, and:
 *   - 200 → activate peer; `onPeerActivated` runs and (per Task 6) fans out
 *     approved-notifications to outbound subscribers and cascade-deletes the
 *     queue row. The handler MUST NOT duplicate that cleanup.
 *   - 202 → remote also gates; transition to `awaiting_approval`, capture
 *     the returned token, leave the queue row + subscribers untouched (they
 *     wait for the remote admin to approve and the eventual full activation
 *     to fan out via `onPeerActivated`).
 *   - 4xx/5xx/network → clean up the peer row we created; leave the queue
 *     row alone so the admin can retry.
 */
async function handleOutboundApprove(
  approvalReq: typeof schema.peerApprovalRequests.$inferSelect,
  localOrigin: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const db = getDb();
  const hmacSecret = generateHmacSecret();
  const peerId = generateSnowflake();
  const now = Date.now();

  // Insert the peer row in 'pending' so failure paths roll back cleanly.
  db.insert(schema.federationPeers).values({
    id: peerId,
    origin: approvalReq.origin,
    instanceName: approvalReq.instanceName,
    hmacSecret,
    status: 'pending',
    createdAt: now,
  }).run();

  const instanceName = db
    .select({ name: schema.instanceSettings.instanceName })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.id, 1))
    .get()?.name ?? undefined;

  let response: Response;
  try {
    response = await fetch(`${approvalReq.origin}/api/federation/peer/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceOrigin: localOrigin,
        hmacSecret,
        instanceName,
        instanceId: getInstanceId(),
        // No approvalToken — outbound rows are admin-initiated locally; we
        // hold no prior token from the remote and rely on the remote's own
        // autoAcceptPeering setting to decide 200 vs 202.
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    db.delete(schema.federationPeers)
      .where(eq(schema.federationPeers.id, peerId))
      .run();
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return reply.code(504).send({
        error: 'Remote instance did not respond within 10 seconds',
        statusCode: 504,
      });
    }
    return reply.code(503).send({
      error: `Remote instance unreachable: ${message}`,
      statusCode: 503,
    });
  }

  if (response.status === 202) {
    // Remote also gates new peers. Capture the approval token they returned
    // so the next inbound /peer/accept (when the remote admin approves) can
    // verify mutual admin approval. The outbound queue row and its
    // subscribers REMAIN — `onPeerActivated` is NOT called here; subscribers
    // wait for the eventual activation (fanout happens then).
    let returnedToken: string | null = null;
    try {
      const body = (await response.json()) as { approvalToken?: string };
      if (typeof body?.approvalToken === 'string' && body.approvalToken.length > 0) {
        returnedToken = body.approvalToken;
      }
    } catch {
      // Non-JSON / empty body — legacy peer with no token to capture.
    }

    db.update(schema.federationPeers)
      .set({ status: 'awaiting_approval', approvalToken: returnedToken })
      .where(eq(schema.federationPeers.id, peerId))
      .run();

    connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });

    const peer = db
      .select()
      .from(schema.federationPeers)
      .where(eq(schema.federationPeers.id, peerId))
      .get();

    return reply.code(200).send({
      success: true,
      peerStatus: 'awaiting_approval' as const,
      awaitingRemoteApproval: true,
      message: 'Remote instance also requires admin approval. Your request has been queued on their side.',
      peer: peer ? sanitizePeer(peer) : undefined,
    });
  }

  if (!response.ok) {
    let errorMessage = `Remote instance rejected handshake (HTTP ${response.status})`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) errorMessage = body.error;
    } catch { /* ignore */ }

    // Clean up the peer row we created. Leave the outbound queue row alone
    // so the admin can retry without re-collecting subscribers.
    db.delete(schema.federationPeers)
      .where(eq(schema.federationPeers.id, peerId))
      .run();
    return reply.code(502).send({
      error: errorMessage,
      statusCode: 502,
      remoteStatus: response.status,
    });
  }

  // 200 — peer activated. Capture remote's instanceName for the friendly label
  // and instanceId (epoch) for the authenticated baseline.
  let remoteInstanceName: string | null = approvalReq.instanceName;
  let remoteInstanceId: string | null = null;
  try {
    const body = (await response.json()) as { instanceName?: string | null; instanceId?: string | null };
    if (typeof body?.instanceName === 'string' && body.instanceName.length > 0) {
      remoteInstanceName = body.instanceName;
    }
    if (typeof body?.instanceId === 'string' && body.instanceId.length > 0) {
      remoteInstanceId = body.instanceId;
    }
  } catch {
    // Non-JSON body — keep approvalReq.instanceName (may be null).
  }

  db.update(schema.federationPeers)
    .set({
      status: 'active',
      lastSeenAt: now,
      instanceName: remoteInstanceName,
      peerInstanceId: remoteInstanceId,
      approvalToken: null,
    })
    .where(eq(schema.federationPeers.id, peerId))
    .run();

  connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });

  // onPeerActivated runs fanoutOutboundSubscribers (Task 6) which:
  //   - inserts kind='approved' notifications for each subscriber,
  //   - sends `peering_notification_received` WS to each subscriber,
  //   - cascade-deletes the parent + subscriber rows.
  // Do NOT duplicate any of that here — it would double-notify and corrupt
  // the queue.
  onPeerActivated(peerId, 'approval_handshake').catch(err =>
    console.error('[federation] onPeerActivated from outbound /approval-requests/:id/approve failed:', err)
  );

  const peer = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.id, peerId))
    .get();

  return reply.code(200).send({
    success: true,
    peerStatus: 'active' as const,
    peer: peer ? sanitizePeer(peer) : undefined,
  });
}

/**
 * Inbound deny — admin rejects a remote instance's peering request. Fires
 * the existing /peer/denied notification to the remote, marks any local
 * peer row as `rejected`, and clears the queue row. Preserves historical
 * behavior verbatim.
 */
async function handleInboundDeny(
  approvalReq: typeof schema.peerApprovalRequests.$inferSelect,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const db = getDb();
  const id = approvalReq.id;

  // Inbound rows always carry hmacSecret (CHECK constraint enforces this).
  // If it's somehow null, we cannot sign /peer/denied — surface clearly.
  if (!approvalReq.hmacSecret) {
    return reply.code(500).send({
      error: 'Inbound approval request is missing hmacSecret — cannot deliver /peer/denied notification.',
      statusCode: 500,
    });
  }

  const ourOrigin = getOurOrigin();
  const denialBody = JSON.stringify({
    origin: ourOrigin,
    reason: 'denied_by_admin' as const,
    message: 'Request denied by admin',
  });

  const headers = buildFederationHeaders(denialBody, approvalReq.hmacSecret, ourOrigin);

  let notificationSent = false;
  try {
    const response = await fetch(`${approvalReq.origin}/api/federation/peer/denied`, {
      method: 'POST',
      headers,
      body: denialBody,
      signal: AbortSignal.timeout(10_000),
    });
    notificationSent = response.ok;
  } catch {
    // Network error
  }

  if (!notificationSent) {
    return reply.code(502).send({
      error: 'Denial notification could not be delivered to the remote instance. The request is still pending — you can retry or wait for it to expire.',
      statusCode: 502,
    });
  }

  const existingPeer = db
    .select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, approvalReq.origin))
    .get();

  if (!existingPeer) {
    db.insert(schema.federationPeers).values({
      id: generateSnowflake(),
      origin: approvalReq.origin,
      instanceName: approvalReq.instanceName,
      hmacSecret: approvalReq.hmacSecret,
      status: 'rejected',
      createdAt: Date.now(),
    }).run();
  } else if (existingPeer.status !== 'active') {
    db.update(schema.federationPeers)
      .set({ status: 'rejected' })
      .where(eq(schema.federationPeers.id, existingPeer.id))
      .run();
  }

  connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });

  db.delete(schema.peerApprovalRequests)
    .where(eq(schema.peerApprovalRequests.id, id))
    .run();

  return reply.code(200).send({ success: true });
}

/**
 * Outbound deny — admin refuses local users' peering request. Fans out
 * `kind='denied'` notifications to each subscriber and cascade-deletes the
 * parent (which clears subscribers via FK cascade). No remote network call
 * — outbound rows have no /peer/denied counterpart on the wire (the remote
 * never knew we were considering this).
 */
async function handleOutboundDeny(
  approvalReq: typeof schema.peerApprovalRequests.$inferSelect,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const db = getDb();
  const subscribers = db
    .select()
    .from(schema.peerApprovalSubscribers)
    .where(eq(schema.peerApprovalSubscribers.requestId, approvalReq.id))
    .all();

  const now = Date.now();
  for (const sub of subscribers) {
    db.insert(schema.peerApprovalNotifications)
      .values({
        id: generateSnowflake(),
        userId: sub.userId,
        kind: 'denied',
        peerOrigin: approvalReq.origin,
        triggerReason: sub.triggerReason,
        triggerTarget: sub.triggerTarget,
        createdAt: now,
        readAt: null,
      })
      .run();

    connectionManager.sendToUser(sub.userId, {
      type: 'peering_notification_received' as const,
      kind: 'denied',
    });
    // Subscriber row is about to cascade-delete; refresh the user's pending list.
    connectionManager.sendToUser(sub.userId, {
      type: 'peering_subscription_changed' as const,
    });
  }

  // Cascade-delete clears subscribers via onDelete: 'cascade'.
  db.delete(schema.peerApprovalRequests)
    .where(eq(schema.peerApprovalRequests.id, approvalReq.id))
    .run();

  // Tell admins the queue changed.
  connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });

  if (subscribers.length > 0) {
    console.log(
      `[federation] handleOutboundDeny denied ${subscribers.length} subscriber notification${subscribers.length === 1 ? '' : 's'} for ${approvalReq.origin}`,
    );
  }

  return reply.code(200).send({ success: true });
}

export async function federationRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /api/federation/peer/initiate ────────────────────────────────────
  // Admin-only: start a peering handshake with a remote instance.
  app.post<{ Body: { remoteOrigin: string } }>(
    '/api/federation/peer/initiate',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { remoteOrigin: rawOrigin } = request.body ?? {};
      if (!rawOrigin || typeof rawOrigin !== 'string') {
        return reply.code(400).send({ error: 'remoteOrigin is required', statusCode: 400 });
      }

      const remoteOrigin = validateOrigin(rawOrigin);
      if (!remoteOrigin) {
        return reply.code(400).send({ error: 'remoteOrigin must be a valid HTTPS URL (HTTP is only allowed for localhost)', statusCode: 400 });
      }

      const db = getDb();

      // Check if a peer already exists for this origin
      const existing = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, remoteOrigin))
        .get();

      if (existing) {
        if (existing.status === 'active') {
          return reply.code(200).send({ peer: sanitizePeer(existing) });
        }
        if (existing.status === 'pending') {
          return reply.code(409).send({
            error: 'A peering handshake with this instance is already in progress',
            statusCode: 409,
          });
        }
        // If revoked, allow re-initiation by removing the old record
        if (existing.status === 'revoked') {
          db.delete(schema.federationPeers).where(eq(schema.federationPeers.id, existing.id)).run();
        }
      }

      let localOrigin: string;
      try {
        localOrigin = resolveLocalOrigin(request);
      } catch {
        return reply.code(500).send({
          error: 'Cannot determine local instance origin. Set the DOMAIN environment variable.',
          statusCode: 500,
        });
      }

      // Prevent self-peering
      if (localOrigin === remoteOrigin) {
        return reply.code(400).send({ error: 'Cannot peer with yourself', statusCode: 400 });
      }

      const hmacSecret = generateHmacSecret();
      const peerId = generateSnowflake();
      const now = Date.now();

      // Store peer as pending
      db.insert(schema.federationPeers).values({
        id: peerId,
        origin: remoteOrigin,
        hmacSecret,
        status: 'pending',
        createdAt: now,
      }).run();

      // Initiate the server-to-server handshake
      try {
        const response = await fetch(`${remoteOrigin}/api/federation/peer/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceOrigin: localOrigin,
            hmacSecret,
            instanceName: db
              .select({ name: schema.instanceSettings.instanceName })
              .from(schema.instanceSettings)
              .where(eq(schema.instanceSettings.id, 1))
              .get()?.name ?? undefined,
            instanceId: getInstanceId(),
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 202) {
          // Remote instance queued our request for admin approval
          // (autoAcceptPeering is off on their side). Do NOT activate the
          // local peer — mirror the auto-peer flow in federationPeering.ts
          // by transitioning the pending record to awaiting_approval.
          // Capture the approval token they returned so the next inbound
          // /peer/accept (when their admin approves) can be verified. §3.7.
          let returnedToken: string | null = null;
          try {
            const body = (await response.json()) as { approvalToken?: string };
            if (typeof body?.approvalToken === 'string' && body.approvalToken.length > 0) {
              returnedToken = body.approvalToken;
            }
          } catch {
            // Non-JSON / empty body — legacy peer.
          }

          db.update(schema.federationPeers)
            .set({ status: 'awaiting_approval', approvalToken: returnedToken })
            .where(eq(schema.federationPeers.id, peerId))
            .run();
          connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });

          const peer = db
            .select()
            .from(schema.federationPeers)
            .where(eq(schema.federationPeers.id, peerId))
            .get();

          if (!peer) {
            return reply.code(500).send({ error: 'Failed to read peer after queuing', statusCode: 500 });
          }

          return reply.code(202).send({ peer: sanitizePeer(peer) });
        }

        if (!response.ok) {
          let errorMessage = `Remote instance rejected peering (HTTP ${response.status})`;
          try {
            const body = await response.json() as { error?: string };
            if (body.error) {
              errorMessage = body.error;
            }
          } catch {
            // Ignore parse failures — use the default error message
          }

          // Clean up the pending peer
          db.delete(schema.federationPeers).where(eq(schema.federationPeers.id, peerId)).run();
          return reply.code(502).send({ error: errorMessage, statusCode: 502 });
        }

        // Remote accepted — activate the peer. Parse the remote's instanceName
        // and instanceId (epoch) from the response body so the federation panel
        // renders a friendly label and we record the peer's authenticated
        // epoch baseline. Tolerate omission and non-JSON bodies.
        let remoteInstanceName: string | null = null;
        let remoteInstanceId: string | null = null;
        try {
          const body = (await response.json()) as { instanceName?: string | null; instanceId?: string | null };
          if (typeof body?.instanceName === 'string' && body.instanceName.length > 0) {
            remoteInstanceName = body.instanceName;
          }
          if (typeof body?.instanceId === 'string' && body.instanceId.length > 0) {
            remoteInstanceId = body.instanceId;
          }
        } catch {
          // Non-JSON body — leave null.
        }

        db.update(schema.federationPeers)
          .set({ status: 'active', lastSeenAt: Date.now(), instanceName: remoteInstanceName, peerInstanceId: remoteInstanceId, approvalToken: null })
          .where(eq(schema.federationPeers.id, peerId))
          .run();
        connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
        onPeerActivated(peerId, 'initiate_accepted').catch(err =>
          console.error('[federation] onPeerActivated from /peer/initiate failed:', err)
        );

        const peer = db
          .select()
          .from(schema.federationPeers)
          .where(eq(schema.federationPeers.id, peerId))
          .get();

        if (!peer) {
          return reply.code(500).send({ error: 'Failed to read peer after activation', statusCode: 500 });
        }

        return reply.code(200).send({ peer: sanitizePeer(peer) });
      } catch (err: unknown) {
        // Clean up the pending peer on network/timeout errors
        db.delete(schema.federationPeers).where(eq(schema.federationPeers.id, peerId)).run();

        const message = err instanceof Error ? err.message : 'Unknown error';
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          return reply.code(504).send({
            error: 'Remote instance did not respond within 10 seconds',
            statusCode: 504,
          });
        }
        return reply.code(502).send({
          error: `Failed to reach remote instance: ${message}`,
          statusCode: 502,
        });
      }
    },
  );

  // ─── POST /api/federation/peer/accept ──────────────────────────────────────
  // Server-to-server: accept a peering request from a remote instance.
  // No JWT auth — this is first contact. Rate-limited by IP.
  app.post<{ Body: { sourceOrigin: string; challenge?: string; hmacSecret: string; instanceName?: string; instanceId?: string; approvalToken?: string } }>(
    '/api/federation/peer/accept',
    async (request, reply) => {
      const clientIp = request.ip;
      if (isAcceptRateLimited(clientIp)) {
        return reply.code(429).send({
          error: 'Too many peering requests — try again later',
          statusCode: 429,
        });
      }

      const { sourceOrigin: rawOrigin, hmacSecret, instanceName: reqInstanceName, instanceId: reqInstanceId, approvalToken: inboundToken } = request.body ?? {};

      if (!rawOrigin || typeof rawOrigin !== 'string') {
        return reply.code(400).send({ error: 'sourceOrigin is required', statusCode: 400 });
      }
      if (!hmacSecret || typeof hmacSecret !== 'string') {
        return reply.code(400).send({ error: 'hmacSecret is required', statusCode: 400 });
      }

      const sourceOrigin = validateOrigin(rawOrigin);
      if (!sourceOrigin) {
        return reply.code(400).send({ error: 'sourceOrigin must be a valid HTTPS URL (HTTP is only allowed for localhost)', statusCode: 400 });
      }

      const db = getDb();

      const settings = db
        .select({
          instanceName: schema.instanceSettings.instanceName,
          autoAcceptPeering: schema.instanceSettings.autoAcceptPeering,
        })
        .from(schema.instanceSettings)
        .where(eq(schema.instanceSettings.id, 1))
        .get();

      const ourInstanceName = settings?.instanceName ?? null;
      const ourInstanceId = getInstanceId();
      const autoAccept = settings?.autoAcceptPeering ?? 1;

      // ── autoAcceptPeering gate ──────────────────────────────────────────
      // When auto-accept is disabled, only allow incoming accept requests
      // that correspond to a local pending peer (i.e., a local admin
      // initiated the handshake). Unsolicited requests are rejected.

      if (autoAccept === 0) {
        // Check if the local admin already initiated or approved peering with this origin.
        // 'pending' = admin used peer/initiate (handshake in progress)
        // 'awaiting_approval' = admin approved an earlier request, handshake was sent,
        //   remote queued it (202). Now the remote admin approved too and is handshaking
        //   back to us. We should accept — both admins have approved.
        const localPending = db
          .select({ id: schema.federationPeers.id })
          .from(schema.federationPeers)
          .where(
            and(
              eq(schema.federationPeers.origin, sourceOrigin),
              inArray(schema.federationPeers.status, ['pending', 'awaiting_approval']),
            ),
          )
          .get();

        if (!localPending) {
          // Check if this origin is blocked (previously denied)
          const blockedPeer = db
            .select({ id: schema.federationPeers.id })
            .from(schema.federationPeers)
            .where(
              and(
                eq(schema.federationPeers.origin, sourceOrigin),
                eq(schema.federationPeers.status, 'rejected'),
              ),
            )
            .get();

          if (blockedPeer) {
            return reply.code(403).send({
              error: 'This instance requires manual peering approval',
              code: 'PEERING_REQUIRES_APPROVAL',
              statusCode: 403,
            });
          }

          return queueApprovalRequest(db, reply, sourceOrigin, hmacSecret, reqInstanceName ?? null);
        }
      }

      // Check if peer already exists
      const existing = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, sourceOrigin))
        .get();

      if (existing) {
        if (existing.status === 'active' || existing.status === 'needs_attention') {
          // Idempotent — already peered (or peering is in needs_attention state).
          // In both cases we refuse to overwrite hmac_secret via this
          // unauthenticated endpoint. An unauthenticated caller cannot
          // prove prior trust, and needs_attention means "we don't know
          // why this broke" — letting an unauthenticated request flip it
          // to active with a new secret defeats the purpose.
          //
          // Legitimate recovery path: local admin clicks "Reset peering" →
          // row is deleted → remote's /peer/accept then lands on a
          // non-existent row and the normal handshake path runs.
          //
          // Detection-only: if the inbound epoch differs from our trusted
          // baseline, the peer is a NEW incarnation on the same domain (a
          // wipe-and-reinstall). Route it to needs_attention + snapshot +
          // journal — but STILL return 200 and STILL do not rekey. The
          // anti-hijack guard above is preserved verbatim; detection never
          // grants capability.
          if (reqInstanceId && existing.peerInstanceId && reqInstanceId !== existing.peerInstanceId) {
            markPeerReset(existing.id, sourceOrigin, existing.peerInstanceId, reqInstanceId);
          }
          return reply.code(200).send({ accepted: true, instanceName: ourInstanceName, instanceId: ourInstanceId });
        }
        if (existing.status === 'revoked') {
          return reply.code(403).send({
            error: 'Peering with this instance has been revoked',
            statusCode: 403,
          });
        }
        if (existing.status === 'rejected') {
          // A remote admin manually initiated peering with us after we
          // previously auto-rejected them. Override rejected → active.
          db.update(schema.federationPeers)
            .set({
              hmacSecret,
              instanceName: reqInstanceName ?? null,
              peerInstanceId: reqInstanceId ?? null,
              status: 'active',
              lastSeenAt: Date.now(),
            })
            .where(eq(schema.federationPeers.id, existing.id))
            .run();

          // Broadcast activation to all connected local users
          for (const uid of connectionManager.getAllOnlineUserIds()) {
            connectionManager.sendToUser(uid, {
              type: 'federation_peer_active' as const,
              peerOrigin: sourceOrigin,
            });
          }

          connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
          onPeerActivated(existing.id, 'accept_rejected_override').catch(err =>
            console.error('[federation] onPeerActivated from /peer/accept (rejected override) failed:', err)
          );

          return reply.code(200).send({ accepted: true, instanceName: ourInstanceName, instanceId: ourInstanceId });
        }
        if (existing.status === 'awaiting_approval') {
          // Spec §3.5: token verification gates the awaiting_approval → active
          // promotion. Without proof the inbound came from the remote's
          // /approve endpoint, an adversarial timing-knowledge attack or a
          // bug-prone background code path could falsely flip this row to
          // active. The token is single-use entropy issued in the 202 we
          // returned when the remote's outbound /peer/accept first hit our
          // queue — only their /approve endpoint forwards it.
          const tokenValid =
            typeof existing.approvalToken === 'string' &&
            existing.approvalToken.length > 0 &&
            existing.approvalToken === inboundToken;

          if (tokenValid) {
            db.update(schema.federationPeers)
              .set({
                hmacSecret,
                instanceName: reqInstanceName ?? null,
                peerInstanceId: reqInstanceId ?? null,
                status: 'active',
                lastSeenAt: Date.now(),
                approvalToken: null,
              })
              .where(eq(schema.federationPeers.id, existing.id))
              .run();

            // Clean up any stale approval-request row for this origin (e.g.,
            // queued debris from a prior bypass attempt that did not promote).
            db.delete(schema.peerApprovalRequests)
              .where(eq(schema.peerApprovalRequests.origin, sourceOrigin))
              .run();

            for (const uid of connectionManager.getAllOnlineUserIds()) {
              connectionManager.sendToUser(uid, {
                type: 'federation_peer_active' as const,
                peerOrigin: sourceOrigin,
              });
            }
            connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
            onPeerActivated(existing.id, 'accept_awaiting_approval').catch(err =>
              console.error('[federation] onPeerActivated from /peer/accept (awaiting_approval) failed:', err)
            );
            return reply.code(200).send({ accepted: true, instanceName: ourInstanceName, instanceId: ourInstanceId });
          }

          // Token absent or mismatched. Cannot prove mutual approval.
          if (autoAccept === 1) {
            // We accept any inbound anyway — promoting here is no weaker than
            // accepting a fresh handshake from a new peer. Clear the stored
            // token (moot now) and proceed.
            db.update(schema.federationPeers)
              .set({
                hmacSecret,
                instanceName: reqInstanceName ?? null,
                peerInstanceId: reqInstanceId ?? null,
                status: 'active',
                lastSeenAt: Date.now(),
                approvalToken: null,
              })
              .where(eq(schema.federationPeers.id, existing.id))
              .run();

            for (const uid of connectionManager.getAllOnlineUserIds()) {
              connectionManager.sendToUser(uid, {
                type: 'federation_peer_active' as const,
                peerOrigin: sourceOrigin,
              });
            }
            connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
            onPeerActivated(existing.id, 'accept_awaiting_approval_fallback').catch(err =>
              console.error('[federation] onPeerActivated from /peer/accept (awaiting_approval fallback) failed:', err)
            );
            return reply.code(200).send({ accepted: true, instanceName: ourInstanceName, instanceId: ourInstanceId });
          }

          // autoAccept=0 + unverifiable inbound → queue as new approval-request.
          // Existing awaiting_approval row stays untouched; the new approval-
          // request lets the local admin decide whether to honor this inbound.
          return queueApprovalRequest(db, reply, sourceOrigin, hmacSecret, reqInstanceName ?? null);
        }
        // Pending — update with new secret and activate
        db.update(schema.federationPeers)
          .set({
            hmacSecret,
            instanceName: reqInstanceName ?? null,
            peerInstanceId: reqInstanceId ?? null,
            status: 'active',
            lastSeenAt: Date.now(),
          })
          .where(eq(schema.federationPeers.id, existing.id))
          .run();

        connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
        onPeerActivated(existing.id, 'accept_pending').catch(err =>
          console.error('[federation] onPeerActivated from /peer/accept (pending) failed:', err)
        );

        return reply.code(200).send({ accepted: true, instanceName: ourInstanceName, instanceId: ourInstanceId });
      }

      // New peer — create and activate
      const peerId = generateSnowflake();
      db.insert(schema.federationPeers).values({
        id: peerId,
        origin: sourceOrigin,
        hmacSecret,
        instanceName: reqInstanceName ?? null,
        peerInstanceId: reqInstanceId ?? null,
        status: 'active',
        lastSeenAt: Date.now(),
        createdAt: Date.now(),
      }).run();

      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
      onPeerActivated(peerId, 'accept_new').catch(err =>
        console.error('[federation] onPeerActivated from /peer/accept (new) failed:', err)
      );

      return reply.code(200).send({ accepted: true, instanceName: ourInstanceName, instanceId: ourInstanceId });
    },
  );

  // ─── POST /api/federation/peer/ensure ──────────────────────────────────────
  // JWT-authenticated (any user): trigger auto-peering with a remote instance.
  // Rate-limited per user (3 requests per 15 minutes).
  app.post<{ Body: { remoteOrigin: string } }>(
    '/api/federation/peer/ensure',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { remoteOrigin: rawOrigin } = request.body ?? {};
      if (!rawOrigin || typeof rawOrigin !== 'string') {
        return reply.code(400).send({ error: 'remoteOrigin is required', statusCode: 400 });
      }

      const remoteOrigin = validateOrigin(rawOrigin);
      if (!remoteOrigin) {
        return reply.code(400).send({
          error: 'remoteOrigin must be a valid HTTPS URL (HTTP is only allowed for localhost)',
          statusCode: 400,
        });
      }

      if (isEnsureRateLimited(request.userId)) {
        return reply.code(429).send({
          error: 'Too many peering requests — try again later',
          statusCode: 429,
        });
      }

      const { ensurePeered } = await import('../utils/federationPeering.js');
      // NOTE: /peer/ensure is currently only invoked from friend-add client paths
      // (see packages/web/src/stores/instanceStore.ts ensurePeered references).
      // The hardcoded reason here is correct TODAY but will become wrong when
      // DM-to-stranger or space-join grow into the gate. When that happens,
      // surface the reason and target through the request body instead. Do NOT
      // silently leave the hardcoding in place when adding a new caller.
      const result = await ensurePeered(remoteOrigin, {
        kind: 'user_action',
        userId: request.userId,
        reason: 'friend_add',
        target: remoteOrigin,
      });

      // NOTE: The internal EnsurePeeredResult status names differ from the client-facing
      // peeringStatus values. The mapping:
      //   'active'         → 'active'            (peer is live)
      //   'rejected'       → 'rejected'          (permanently blocked)
      //   'pending'        → 'awaiting_approval' (queued on remote, waiting for admin)
      //   'failed'         → 'pending'           (transient error, will retry automatically)
      //   'admin_required' → 'admin_required'    (local outbound gate fired — our admin must approve)
      // The internal 'pending' means "we got a 202 from the remote — admin hasn't acted yet",
      // while 'failed' means "network/timeout — the outbox worker will retry next tick".
      // The client sees 'awaiting_approval' (actionable info) vs 'pending' (transient, will resolve).
      switch (result.status) {
        case 'active':
          return reply.code(200).send({ peeringStatus: 'active', peerId: result.peerId });
        case 'rejected':
          return reply.code(200).send({ peeringStatus: 'rejected', error: result.error });
        case 'pending':
          return reply.code(200).send({ peeringStatus: 'awaiting_approval', error: result.error });
        case 'failed':
          return reply.code(200).send({ peeringStatus: 'pending', error: result.error });
        case 'admin_required':
          return reply.code(200).send({ peeringStatus: 'admin_required' });
        default:
          return reply.code(200).send({ peeringStatus: 'pending', error: 'Unknown peering result' });
      }
    },
  );

  // ─── POST /api/federation/peer/rotate ───────────────────────────────────────
  // Server-to-server: accept a secret rotation request from a peer instance.
  // Authenticated via HMAC-SHA256 signature (current secret), NOT JWT.
  app.post<{ Body: { newSecret: string } }>(
    '/api/federation/peer/rotate',
    async (request, reply) => {
      const db = getDb();

      // 1. Verify HMAC signature
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
      }

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, fedHeaders.origin))
        .get();

      if (!peer || peer.status !== 'active') {
        return reply.code(403).send({ error: 'Unknown or inactive peer', statusCode: 403 });
      }

      const bodyString = JSON.stringify(request.body);
      if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // 2. Validate request body
      const { newSecret } = request.body ?? {};
      if (!newSecret || typeof newSecret !== 'string' || newSecret.length !== 64 || !/^[0-9a-f]+$/.test(newSecret)) {
        return reply.code(400).send({ error: 'newSecret must be a 64-character hex string', statusCode: 400 });
      }

      // 3. Reject if rotation already in progress
      if (peer.pendingHmacSecret) {
        return reply.code(409).send({
          error: 'A secret rotation is already in progress — wait for it to complete',
          statusCode: 409,
        });
      }

      // 4. Store pending secret and activate grace period
      db.update(schema.federationPeers)
        .set({
          pendingHmacSecret: newSecret,
          secretRotationAt: Date.now(),
        })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();

      console.log(`[federation] Secret rotation accepted from peer ${peer.origin}`);

      return reply.code(200).send({ accepted: true, gracePeriodMs: 900_000 });
    },
  );

  // ─── POST /api/federation/peer/denied ─────────────────────────────────────
  // Server-to-server: receive a denial notification from a remote instance.
  // Authenticated via HMAC-SHA256 signature (the secret we sent in our original
  // peer/accept request, which the remote stored in their approval queue).
  app.post<{ Body: { origin: string; reason: 'denied_by_admin' | 'expired'; message?: string } }>(
    '/api/federation/peer/denied',
    async (request, reply) => {
      const db = getDb();

      // Verify HMAC signature
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
      }

      const { origin: senderOrigin, signature, timestamp, nonce } = fedHeaders;

      // Find the local peer for this origin
      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, senderOrigin))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'No peer record for this origin', statusCode: 404 });
      }

      // Only accept denial for awaiting_approval peers
      if (peer.status !== 'awaiting_approval') {
        return reply.code(409).send({
          error: `Peer is in '${peer.status}' state, not awaiting_approval`,
          statusCode: 409,
        });
      }

      // Verify signature using our stored hmacSecret (the one we sent in the original request)
      const rawBody = JSON.stringify(request.body);
      const isValid = verifyPeerSignature(rawBody, signature, timestamp, nonce, {
        hmacSecret: peer.hmacSecret,
        pendingHmacSecret: null,
        secretRotationAt: null,
      });

      if (!isValid) {
        return reply.code(401).send({ error: 'Invalid HMAC signature', statusCode: 401 });
      }

      const { reason, message } = request.body;

      // Transition to rejected
      db.update(schema.federationPeers)
        .set({ status: 'rejected' })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();

      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });

      // Push federation_peer_rejected WS event to affected users
      const entries = db
        .select({
          contextId: schema.federationOutbox.contextId,
          contextType: schema.federationOutbox.contextType,
        })
        .from(schema.federationOutbox)
        .where(eq(schema.federationOutbox.peerId, peer.id))
        .all();

      const contextMap = new Map<string, string>();
      for (const entry of entries) {
        contextMap.set(entry.contextId, entry.contextType);
      }

      // Purge outbox entries
      db.delete(schema.federationOutbox)
        .where(eq(schema.federationOutbox.peerId, peer.id))
        .run();

      // Build and send WS event
      if (contextMap.size > 0) {
        const { pushPeerRejectedEvent } = await import('../utils/federationWorker.js');
        pushPeerRejectedEvent(
          senderOrigin,
          contextMap,
          message || (reason === 'expired'
            ? 'Request expired — no response from admin within 30 days'
            : 'Request denied by admin'),
        );
      }

      return reply.code(200).send({ acknowledged: true });
    },
  );

  // ─── GET /api/federation/peers ─────────────────────────────────────────────
  // Admin-only: list all federation peers (hmacSecret excluded).
  app.get(
    '/api/federation/peers',
    { preHandler: [authenticate, requireAdmin] },
    async (_request, reply) => {
      const db = getDb();
      const peers = db
        .select()
        .from(schema.federationPeers)
        .all();

      return reply.code(200).send({ peers: peers.map(sanitizePeer) });
    },
  );

  // ─── DELETE /api/federation/peers/:id ──────────────────────────────────────
  // Admin-only: revoke a federation peer and clean up its outbox.
  app.delete<{ Params: { id: string } }>(
    '/api/federation/peers/:id',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      // Revoke the peer
      db.update(schema.federationPeers)
        .set({ status: 'revoked' })
        .where(eq(schema.federationPeers.id, id))
        .run();

      onPeerDeactivated(id, 'admin_revoked').catch(err =>
        console.error('[federation] onPeerDeactivated from admin revoke failed:', err),
      );

      // Delete all outbox entries for this peer
      db.delete(schema.federationOutbox)
        .where(eq(schema.federationOutbox.peerId, id))
        .run();

      return reply.code(200).send({ success: true });
    },
  );

  // ─── POST /api/federation/peers/:id/reset ──────────────────────────────────
  // Admin-only: reset a peer that has transitioned to needs_attention.
  // Deletes the local peer row (cascade-deletes outbox entries via FK).
  // Admin must re-initiate peering out of band after reset.
  app.post<{ Params: { id: string } }>(
    '/api/federation/peers/:id/reset',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      if (peer.status !== 'needs_attention') {
        return reply.code(400).send({
          error: 'Reset is only available for peers in the needs_attention state. Use revoke for active peers.',
          statusCode: 400,
        });
      }

      // Cascade-delete handles federation_outbox entries (FK onDelete: 'cascade').
      db.delete(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .run();

      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });

      return reply.code(200).send({ success: true });
    },
  );

  // ─── POST /api/federation/peers/:id/recheck ────────────────────────────────
  // Admin-only: run an immediate reachability probe on an unreachable peer.
  // On success the peer transitions to active (outbox flushes on the next tick).
  app.post<{ Params: { id: string } }>(
    '/api/federation/peers/:id/recheck',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      if (peer.status !== 'unreachable') {
        return reply.code(400).send({
          error: 'Recheck is only available for unreachable peers.',
          statusCode: 400,
        });
      }

      const probe = await probePeerReachable(peer.origin);

      if (probe.reachable) {
        const outcome = await recoverOrDetectReset(peer, probe);
        if (outcome === 'reset_detected') {
          // The peer is a new incarnation on the same domain. It was routed to
          // needs_attention (detection-only, no rekey) and must NOT be recovered
          // to active until an admin re-peers through the authenticated path.
          return reply.code(200).send({ recovered: false, status: 'needs_attention' });
        }
        return reply.code(200).send({ recovered: true, status: 'active' });
      }

      // Probe failed — advance pacing so a manual attempt stays consistent with
      // the recovery worker's schedule.
      db.update(schema.federationPeers)
        .set({ probeAttempts: peer.probeAttempts + 1, lastProbeAt: Date.now() })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();

      return reply.code(200).send({ recovered: false, status: 'unreachable' });
    },
  );

  // ─── PATCH /api/federation/peers/:id ────────────────────────────────────────
  // Admin-only: update peer settings (e.g. auto-rotation interval).
  app.patch<{ Params: { id: string }; Body: { autoRotateIntervalDays?: number } }>(
    '/api/federation/peers/:id',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      const updateData: Record<string, number> = {};

      if (request.body.autoRotateIntervalDays !== undefined) {
        const interval = Number(request.body.autoRotateIntervalDays);
        if (isNaN(interval) || !Number.isInteger(interval) || interval < 1 || interval > 365) {
          return reply.code(400).send({ error: 'autoRotateIntervalDays must be an integer between 1 and 365', statusCode: 400 });
        }
        updateData.autoRotateIntervalDays = interval;
      }

      if (Object.keys(updateData).length === 0) {
        return reply.code(400).send({ error: 'No valid fields to update', statusCode: 400 });
      }

      db.update(schema.federationPeers)
        .set(updateData)
        .where(eq(schema.federationPeers.id, id))
        .run();

      const updated = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      return reply.code(200).send({ peer: sanitizePeer(updated!) });
    },
  );

  // ─── DELETE /api/federation/peers/:id/permanent ─────────────────────────────
  // Admin-only: permanently delete a revoked peer record.
  app.delete<{ Params: { id: string } }>(
    '/api/federation/peers/:id/permanent',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      if (peer.status !== 'revoked') {
        return reply.code(400).send({
          error: 'Only revoked peers can be permanently deleted. Revoke the peer first.',
          statusCode: 400,
        });
      }

      db.delete(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .run();

      return reply.code(200).send({ success: true });
    },
  );

  // ─── GET /api/federation/approval-requests ─────────────────────────────────
  app.get(
    '/api/federation/approval-requests',
    { preHandler: [authenticate, requireAdmin] },
    async (_request, reply) => {
      const db = getDb();
      const requests = db
        .select({
          id: schema.peerApprovalRequests.id,
          origin: schema.peerApprovalRequests.origin,
          direction: schema.peerApprovalRequests.direction,
          instanceName: schema.peerApprovalRequests.instanceName,
          requestedAt: schema.peerApprovalRequests.requestedAt,
          expiresAt: schema.peerApprovalRequests.expiresAt,
        })
        .from(schema.peerApprovalRequests)
        .orderBy(desc(schema.peerApprovalRequests.requestedAt))
        .all();

      // For outbound rows, fetch subscriber summaries (joined with users for username).
      // Inbound rows have no subscriber concept; field is omitted in their response.
      const outboundIds = requests.filter(r => r.direction === 'outbound').map(r => r.id);
      const subscribersByRequestId = new Map<string, ApprovalRequestSubscriberSummary[]>();
      if (outboundIds.length > 0) {
        const rows = db
          .select({
            requestId: schema.peerApprovalSubscribers.requestId,
            userId: schema.peerApprovalSubscribers.userId,
            username: schema.users.username,
            triggerReason: schema.peerApprovalSubscribers.triggerReason,
            triggerTarget: schema.peerApprovalSubscribers.triggerTarget,
          })
          .from(schema.peerApprovalSubscribers)
          .innerJoin(schema.users, eq(schema.users.id, schema.peerApprovalSubscribers.userId))
          .where(inArray(schema.peerApprovalSubscribers.requestId, outboundIds))
          .all();
        for (const row of rows) {
          const arr = subscribersByRequestId.get(row.requestId) ?? [];
          arr.push({
            userId: row.userId,
            username: row.username,
            triggerReason: row.triggerReason as PeeringTriggerReason,
            triggerTarget: row.triggerTarget,
          });
          subscribersByRequestId.set(row.requestId, arr);
        }
      }

      return reply.code(200).send({
        requests: requests.map(r =>
          r.direction === 'outbound'
            ? { ...r, subscribers: subscribersByRequestId.get(r.id) ?? [] }
            : r,
        ),
      });
    },
  );

  // ─── POST /api/federation/approval-requests/:id/approve ───────────────────
  // Direction-branched: inbound rows complete the existing accept-handshake
  // path (preserved verbatim); outbound rows initiate /peer/accept against
  // the remote, capturing 200/202 outcomes and leaving the queue intact on
  // failure so the admin can retry.
  app.post<{ Params: { id: string } }>(
    '/api/federation/approval-requests/:id/approve',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const db = getDb();
      const { id } = request.params;

      const approvalReq = db
        .select()
        .from(schema.peerApprovalRequests)
        .where(eq(schema.peerApprovalRequests.id, id))
        .get();

      if (!approvalReq) {
        return reply.code(404).send({ error: 'Approval request not found', statusCode: 404 });
      }

      let localOrigin: string;
      try {
        localOrigin = resolveLocalOrigin(request);
      } catch {
        return reply.code(500).send({
          error: 'Cannot determine local instance origin. Set the DOMAIN environment variable.',
          statusCode: 500,
        });
      }

      if (approvalReq.direction === 'outbound') {
        return await handleOutboundApprove(approvalReq, localOrigin, reply);
      }

      return await handleInboundApprove(approvalReq, localOrigin, reply);
    },
  );

  // ─── POST /api/federation/approval-requests/:id/deny ───────────────────────
  // Direction-branched: inbound rows hit the remote's /peer/denied endpoint
  // (existing behavior preserved); outbound rows fan out denied notifications
  // to subscribers and cascade-delete the queue row.
  app.post<{ Params: { id: string } }>(
    '/api/federation/approval-requests/:id/deny',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const db = getDb();
      const { id } = request.params;

      const approvalReq = db
        .select()
        .from(schema.peerApprovalRequests)
        .where(eq(schema.peerApprovalRequests.id, id))
        .get();

      if (!approvalReq) {
        return reply.code(404).send({ error: 'Approval request not found', statusCode: 404 });
      }

      if (approvalReq.direction === 'outbound') {
        return await handleOutboundDeny(approvalReq, reply);
      }

      return await handleInboundDeny(approvalReq, reply);
    },
  );

  // ─── GET /api/federation/peering-subscriptions ─────────────────────────────
  // User-facing: list the requesting user's pending outbound peering
  // subscriber rows joined to their parent peer_approval_requests. Used by the
  // pending-peering UI surface to show "you have a peering with X waiting on
  // your admin's approval" rows.
  app.get(
    '/api/federation/peering-subscriptions',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const db = getDb();
      const userId = request.userId;
      const rows = db
        .select({
          id: schema.peerApprovalSubscribers.id,
          requestId: schema.peerApprovalSubscribers.requestId,
          peerOrigin: schema.peerApprovalRequests.origin,
          peerInstanceName: schema.peerApprovalRequests.instanceName,
          triggerReason: schema.peerApprovalSubscribers.triggerReason,
          triggerTarget: schema.peerApprovalSubscribers.triggerTarget,
          createdAt: schema.peerApprovalSubscribers.createdAt,
        })
        .from(schema.peerApprovalSubscribers)
        .innerJoin(
          schema.peerApprovalRequests,
          eq(schema.peerApprovalRequests.id, schema.peerApprovalSubscribers.requestId),
        )
        .where(eq(schema.peerApprovalSubscribers.userId, userId))
        .orderBy(desc(schema.peerApprovalSubscribers.createdAt))
        .all();
      return reply.send({ subscriptions: rows });
    },
  );

  // ─── DELETE /api/federation/peering-subscriptions/:id ──────────────────────
  // User-facing: cancel one of the requesting user's pending peering
  // subscriptions. Authorization: subscriber.userId must match request.userId.
  // If this was the last subscriber for its parent request, the parent
  // cascade-deletes too (avoids zombie outbound rows in the admin queue).
  // No notification is created for the canceller (per spec §4.3 (iii)).
  app.delete<{ Params: { id: string } }>(
    '/api/federation/peering-subscriptions/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const db = getDb();
      const { id } = request.params;
      const userId = request.userId;

      const sub = db
        .select()
        .from(schema.peerApprovalSubscribers)
        .where(eq(schema.peerApprovalSubscribers.id, id))
        .get();
      if (!sub) {
        return reply.code(404).send({ error: 'subscription_not_found', statusCode: 404 });
      }
      if (sub.userId !== userId) {
        return reply.code(403).send({ error: 'forbidden', statusCode: 403 });
      }

      db.delete(schema.peerApprovalSubscribers)
        .where(eq(schema.peerApprovalSubscribers.id, id))
        .run();

      // If the row we just removed was the last subscriber on its parent
      // peer_approval_request, cascade-delete the parent. The admin queue
      // refreshes via federation_peers_changed.
      const remaining = db
        .select({ id: schema.peerApprovalSubscribers.id })
        .from(schema.peerApprovalSubscribers)
        .where(eq(schema.peerApprovalSubscribers.requestId, sub.requestId))
        .all();
      if (remaining.length === 0) {
        db.delete(schema.peerApprovalRequests)
          .where(eq(schema.peerApprovalRequests.id, sub.requestId))
          .run();
        connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
      }

      connectionManager.sendToUser(userId, { type: 'peering_subscription_changed' as const });
      return reply.send({ success: true });
    },
  );

  // ─── GET /api/federation/peering-notifications ─────────────────────────────
  // User-facing: list the requesting user's terminal-state peering
  // notifications (kind='approved'|'denied'|'expired'). Optional ?unread=1
  // filter narrows to rows where readAt IS NULL. Ordered DESC by createdAt
  // (newest first).
  app.get<{ Querystring: { unread?: string } }>(
    '/api/federation/peering-notifications',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const db = getDb();
      const userId = request.userId;
      const unread = request.query?.unread === '1';

      const whereClause = unread
        ? and(
            eq(schema.peerApprovalNotifications.userId, userId),
            isNull(schema.peerApprovalNotifications.readAt),
          )
        : eq(schema.peerApprovalNotifications.userId, userId);

      const notifications = db
        .select({
          id: schema.peerApprovalNotifications.id,
          kind: schema.peerApprovalNotifications.kind,
          peerOrigin: schema.peerApprovalNotifications.peerOrigin,
          triggerReason: schema.peerApprovalNotifications.triggerReason,
          triggerTarget: schema.peerApprovalNotifications.triggerTarget,
          createdAt: schema.peerApprovalNotifications.createdAt,
          readAt: schema.peerApprovalNotifications.readAt,
        })
        .from(schema.peerApprovalNotifications)
        .where(whereClause)
        .orderBy(desc(schema.peerApprovalNotifications.createdAt))
        .all();

      return reply.send({ notifications });
    },
  );

  // ─── POST /api/federation/peering-notifications/:id/read ───────────────────
  // User-facing: mark a single peering notification as read. Authorization:
  // notification.userId must match request.userId.
  app.post<{ Params: { id: string } }>(
    '/api/federation/peering-notifications/:id/read',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const db = getDb();
      const { id } = request.params;
      const userId = request.userId;

      const notif = db
        .select()
        .from(schema.peerApprovalNotifications)
        .where(eq(schema.peerApprovalNotifications.id, id))
        .get();
      if (!notif) {
        return reply.code(404).send({ error: 'notification_not_found', statusCode: 404 });
      }
      if (notif.userId !== userId) {
        return reply.code(403).send({ error: 'forbidden', statusCode: 403 });
      }

      db.update(schema.peerApprovalNotifications)
        .set({ readAt: Date.now() })
        .where(eq(schema.peerApprovalNotifications.id, id))
        .run();
      return reply.send({ success: true });
    },
  );

  // ─── POST /api/federation/peering-notifications/read-all ───────────────────
  // User-facing: mark all the requesting user's unread peering notifications
  // as read. Already-read rows are NOT touched (their readAt is preserved).
  // Returns the count of rows affected for UI feedback.
  app.post(
    '/api/federation/peering-notifications/read-all',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const db = getDb();
      const userId = request.userId;
      const result = db
        .update(schema.peerApprovalNotifications)
        .set({ readAt: Date.now() })
        .where(
          and(
            eq(schema.peerApprovalNotifications.userId, userId),
            isNull(schema.peerApprovalNotifications.readAt),
          ),
        )
        .run();
      return reply.send({ success: true, count: result.changes });
    },
  );

  // ─── POST /api/federation/peers/:id/rotate ──────────────────────────────────
  // Admin-only: trigger immediate secret rotation for a peer.
  app.post<{ Params: { id: string } }>(
    '/api/federation/peers/:id/rotate',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      if (peer.status !== 'active') {
        return reply.code(400).send({ error: 'Can only rotate secrets for active peers', statusCode: 400 });
      }

      if (peer.pendingHmacSecret) {
        return reply.code(409).send({
          error: 'A secret rotation is already in progress — wait for it to complete',
          statusCode: 409,
        });
      }

      const newSecret = generateHmacSecret();
      let localOrigin: string;
      try {
        localOrigin = resolveLocalOrigin(request);
      } catch {
        return reply.code(500).send({
          error: 'Cannot determine local instance origin. Set the DOMAIN environment variable.',
          statusCode: 500,
        });
      }

      // Send rotation request to peer, signed with the CURRENT (old) secret
      try {
        const rotateBody = JSON.stringify({ newSecret });
        const headers = buildFederationHeaders(rotateBody, peer.hmacSecret, localOrigin);

        const response = await fetch(`${peer.origin}/api/federation/peer/rotate`, {
          method: 'POST',
          headers,
          body: rotateBody,
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          let errorMessage = `Remote instance rejected rotation (HTTP ${response.status})`;
          try {
            const body = await response.json() as { error?: string };
            if (body.error) errorMessage = body.error;
          } catch { /* ignore parse failures */ }

          return reply.code(502).send({ error: errorMessage, statusCode: 502 });
        }

        // Store pending secret locally AFTER remote peer confirms acceptance
        db.update(schema.federationPeers)
          .set({
            pendingHmacSecret: newSecret,
            secretRotationAt: Date.now(),
          })
          .where(eq(schema.federationPeers.id, peer.id))
          .run();

        console.log(`[federation] Secret rotation initiated with peer ${peer.origin}`);

        return reply.code(200).send({ success: true, gracePeriodMs: 900_000 });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          return reply.code(504).send({
            error: 'Remote instance did not respond within 10 seconds',
            statusCode: 504,
          });
        }
        return reply.code(502).send({
          error: `Failed to reach remote instance: ${message}`,
          statusCode: 502,
        });
      }
    },
  );

  // ─── DELETE /api/federation/identity ──────────────────────────────────────
  // S2S endpoint: delete a federated user's identity on this instance.
  // Called by the user's home instance via HMAC-signed request.
  app.delete<{ Body: FederationIdentityDeleteS2SRequest }>(
    '/api/federation/identity',
    async (request, reply) => {
      const db = getDb();

      // 1. Verify HMAC signature (same pattern as relay endpoint)
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
      }

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, fedHeaders.origin))
        .get();

      if (!peer || peer.status !== 'active') {
        return reply.code(403).send({ error: 'Unknown or inactive peer', statusCode: 403 });
      }

      const bodyString = JSON.stringify(request.body);
      if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // Nonce-based replay protection
      if (fedHeaders.nonce) {
        if (isNonceDuplicate(peer.origin, fedHeaders.nonce)) {
          return reply.code(409).send({ error: 'Duplicate nonce — possible replay', statusCode: 409 });
        }
      } else if (peer.nonceSupported) {
        return reply.code(401).send({ error: 'Nonce required — peer previously supported nonces', statusCode: 401 });
      } else {
        console.warn(`[federation] Peer ${peer.origin} does not support replay protection (no nonce)`);
      }

      // 2. Validate body
      const { homeUserId, homeInstance, mode } = request.body;
      if (!homeUserId || !homeInstance || !['soft', 'full'].includes(mode)) {
        return reply.code(400).send({ error: 'Invalid request: homeUserId, homeInstance, and mode (soft|full) required', statusCode: 400 });
      }

      // 3. Resolve the live (non-deleted) federated user.
      // Must filter isDeleted=0: after a prior deletion + re-federation,
      // multiple records share the same homeUserId (one deleted, one live).
      const user = db.select().from(schema.users)
        .where(and(eq(schema.users.homeUserId, homeUserId), eq(schema.users.isDeleted, 0)))
        .get();

      // Idempotent: no live user means already deleted or never existed
      if (!user) {
        return reply.code(200).send({ success: true });
      }

      // 4. Attribution guard: only the user's home instance can delete them
      if (!user.homeInstance || extractDomain(user.homeInstance) !== extractDomain(fedHeaders.origin)) {
        return reply.code(403).send({ error: 'Attribution mismatch: you can only delete users from your own instance', statusCode: 403 });
      }

      // 5. Check for owned spaces
      const ownedSpaces = db.select({ id: schema.spaces.id, name: schema.spaces.name })
        .from(schema.spaces)
        .where(eq(schema.spaces.ownerId, user.id))
        .all();
      if (ownedSpaces.length > 0) {
        return reply.code(409).send({ error: 'owns_spaces', ownedSpaces, statusCode: 409 });
      }

      // 6. Collect broadcast targets BEFORE deletion removes memberships
      const { memberSpaceIds, targetUserIds } = collectDeletionBroadcastTargets(user.id);

      // 7. Execute deletion
      const filesToDelete = tombstoneUser(user.id, { purgeContent: mode === 'full' });

      // 8. Clean up files from disk
      deleteAttachmentFiles(filesToDelete.map(f => ({ filename: f })));

      // 9. Broadcast member_left to other connected clients for each space
      for (const spaceId of memberSpaceIds) {
        connectionManager.sendToSpace(spaceId, {
          type: 'member_left',
          spaceId,
          userId: user.id,
        });
      }

      // 10. Broadcast user_updated with sanitized deleted user data
      const deletedRow = db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
      if (deletedRow) {
        const deletedUser = sanitizeUser(deletedRow);
        const userUpdatedEvent = { type: 'user_updated' as const, user: deletedUser };
        for (const uid of targetUserIds) {
          connectionManager.sendToUser(uid, userUpdatedEvent);
        }
      }

      // 11. Force-disconnect WS if somehow still connected (unlikely but safe)
      connectionManager.forceDisconnectUser(user.id);

      console.log(`[federation] Identity deleted for user ${user.id} (${user.username}) via S2S from ${fedHeaders.origin}, mode=${mode}`);

      return reply.code(200).send({ success: true });
    },
  );

  // ─── POST /api/federation/relay ────────────────────────────────────────────
  // Server-to-server: receive relayed DM events from a peer instance.
  // Authenticated via HMAC-SHA256 signature, NOT JWT.
  app.post<{ Body: FederationRelayRequest }>(
    '/api/federation/relay',
    { bodyLimit: 10 * 1024 * 1024 },
    async (request, reply) => {
      const db = getDb();

      // 1. Verify HMAC signature
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
      }

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, fedHeaders.origin))
        .get();

      if (!peer || peer.status !== 'active') {
        return reply.code(403).send({ error: 'Unknown or inactive peer', statusCode: 403 });
      }

      // 1b. Per-peer rate limiting (before expensive HMAC verification)
      if (isRelayRateLimited(peer.origin)) {
        return reply.code(429).send({ error: 'Rate limit exceeded', statusCode: 429 });
      }

      // Serialize body back to JSON for HMAC verification (we control both sides)
      const bodyString = JSON.stringify(request.body);
      if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // 1b-epoch. Fast-path baseline population (design §3.2). The signature just
      // verified proves the peer holds the current shared secret, so the epoch it
      // carries in `sourceInstanceId` is authentic. Populate-if-null ONLY: a valid
      // relay can never carry an epoch differing from a non-null baseline (a
      // different incarnation implies a different secret that fails HMAC), so we
      // only ever fill a NULL — never overwrite. This is independent of per-event
      // processing and does not affect relay accept/reject in any way. Old peers
      // omit the field → skip (backward-compatible no-op).
      const claimedEpoch = request.body.sourceInstanceId;
      if (claimedEpoch && !peer.peerInstanceId) {
        db.update(schema.federationPeers)
          .set({ peerInstanceId: claimedEpoch })
          .where(and(
            eq(schema.federationPeers.id, peer.id),
            isNull(schema.federationPeers.peerInstanceId),
          ))
          .run();
      }

      // 1c. Nonce-based replay protection
      if (fedHeaders.nonce) {
        if (isNonceDuplicate(peer.origin, fedHeaders.nonce)) {
          return reply.code(409).send({ error: 'Duplicate nonce — possible replay', statusCode: 409 });
        }
      } else if (peer.nonceSupported) {
        // Peer previously sent nonces but this request doesn't have one — reject
        return reply.code(401).send({ error: 'Nonce required — peer previously supported nonces', statusCode: 401 });
      } else {
        console.warn(`[federation] Peer ${peer.origin} does not support replay protection (no nonce)`);
      }

      // 2. Validate request body shape
      const body = request.body;
      if (!body || body.version !== 1 || !Array.isArray(body.events)) {
        return reply.code(400).send({ error: 'Invalid relay request format', statusCode: 400 });
      }

      if (body.events.length > 50) {
        return reply.code(400).send({ error: 'Maximum 50 events per batch', statusCode: 400 });
      }

      const sourceInstance = body.sourceInstance;
      if (!sourceInstance || typeof sourceInstance !== 'string') {
        return reply.code(400).send({ error: 'sourceInstance is required', statusCode: 400 });
      }

      // 3. Process each event
      const { accepted, rejected, undeliverable } = await processRelayEvents(body.events, sourceInstance, peer.origin, db);

      // 4. Update peer status
      db.update(schema.federationPeers)
        .set({
          lastSeenAt: Date.now(),
          consecutiveFailures: 0,
          ...(fedHeaders.nonce && !peer.nonceSupported ? { nonceSupported: 1 } : {}),
        })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();

      // 5. Return response with max upload size info
      const settings = db
        .select({ maxUploadSizeBytes: schema.instanceSettings.maxUploadSizeBytes })
        .from(schema.instanceSettings)
        .where(eq(schema.instanceSettings.id, 1))
        .get();

      const response: FederationRelayResponse = {
        accepted,
        rejected,
        maxUploadSize: settings?.maxUploadSizeBytes ?? config.maxUploadSize,
        ...(undeliverable.length > 0 ? { undeliverable } : {}),
      };

      return reply.code(200).send(response);
    },
  );

  // ─── POST /api/federation/epoch ────────────────────────────────────────────
  // Server-to-server: return this instance's persistent epoch (instance_id).
  // Authenticated via HMAC-SHA256 signature on the REQUEST (only a peer holding
  // the shared secret may call it), and the RESPONSE body is HMAC-SIGNED with
  // the same secret so the caller can verify the epoch it newly trusts before
  // writing it as the peer's baseline (design §3.2 / §9). The value itself
  // (instanceId) is already public via /instance/info; signing is for
  // baseline-integrity, not confidentiality.
  app.post(
    '/api/federation/epoch',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const db = getDb();

      // 1. Parse and require federation headers (mirror relay/users-lookup).
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(400).send({ error: 'Missing or malformed federation headers', statusCode: 400 });
      }

      // 2. Resolve the peer by origin. Reject unknown or revoked peers.
      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, fedHeaders.origin))
        .get();
      if (!peer || peer.status === 'revoked') {
        return reply.code(403).send({ error: 'Not peered', statusCode: 403 });
      }

      // 3. Verify the inbound request signature (honours rotation grace).
      const bodyString = JSON.stringify(request.body ?? {});
      if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // 4. Sign the response body with the peer's shared secret and return it.
      const responseBody = JSON.stringify({ instanceId: getInstanceId() });
      const sigHeaders = buildFederationHeaders(responseBody, peer.hmacSecret, getOurOrigin());
      reply.headers({
        'X-Federation-Signature': sigHeaders['X-Federation-Signature'],
        'X-Federation-Timestamp': sigHeaders['X-Federation-Timestamp'],
        'X-Federation-Nonce': sigHeaders['X-Federation-Nonce'],
        'Content-Type': 'application/json',
      });
      return reply.code(200).send(responseBody);
    },
  );

  // ─── POST /api/federation/users/lookup ─────────────────────────────────────
  // Server-to-server: resolve a username on this instance to its canonical
  // (homeUserId, profile snapshot). Used by another instance to construct a
  // friend_request_create event without requiring a federated user account.
  //
  // Returns 200 with profile snapshot for native users (regardless of the
  // user's `discoverable` setting — exact-handle resolution).
  // Returns 404 for tombstoned users, replicated stubs, or unknown usernames.
  app.post<{ Body: { username?: unknown } }>(
    '/api/federation/users/lookup',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const db = getDb();

      // 1. Verify HMAC (mirror relay endpoint)
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
      }

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, fedHeaders.origin))
        .get();

      if (!peer || peer.status !== 'active') {
        return reply.code(403).send({ error: 'Unknown or inactive peer', statusCode: 403 });
      }

      if (isLookupRateLimited(peer.origin)) {
        return reply.code(429).header('Retry-After', '60').send({ error: 'Rate limit exceeded', statusCode: 429 });
      }

      const bodyString = JSON.stringify(request.body);
      if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // 1b. Nonce-based replay protection
      if (fedHeaders.nonce) {
        if (isNonceDuplicate(peer.origin, fedHeaders.nonce)) {
          return reply.code(409).send({ error: 'Duplicate nonce — possible replay', statusCode: 409 });
        }
      } else if (peer.nonceSupported) {
        return reply.code(401).send({ error: 'Nonce required — peer previously supported nonces', statusCode: 401 });
      }

      // 2. Validate body
      const rawUsername = (request.body as { username?: unknown } | null)?.username;
      if (typeof rawUsername !== 'string') {
        return reply.code(400).send({ error: 'username is required (string)', statusCode: 400 });
      }
      const username = rawUsername.trim().toLowerCase();
      if (!username) {
        return reply.code(400).send({ error: 'username is required', statusCode: 400 });
      }

      // 3. Native-only lookup with isDeleted filter; discoverable is NOT consulted.
      const user = db
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.username, username),
            eq(schema.users.isDeleted, 0),
            isNull(schema.users.homeInstance),
          ),
        )
        .get();

      if (!user) {
        return reply.code(404).send({ found: false, code: 'user_not_found' });
      }

      return reply.code(200).send({
        found: true,
        user: {
          homeUserId: user.id,
          username: user.username,
          profile: {
            displayName: user.displayName,
            avatar: user.avatar,
            avatarColor: user.avatarColor,
            banner: user.banner,
            bio: user.bio,
            status: user.status as 'online' | 'idle' | 'dnd' | 'offline' | null,
          },
        },
      });
    },
  );

  // ─── POST /api/federation/users/by-home-id ──────────────────────────────────
  // Server-to-server: reverse-lookup a homeUserId to its canonical username +
  // profile snapshot. Used by the stub-username backfill worker on peers that
  // hold legacy snowflake-named replicas of users now visible by their real
  // handle. Same auth+rate-limit shape as /users/lookup.
  app.post<{ Body: { homeUserId?: unknown } }>(
    '/api/federation/users/by-home-id',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const db = getDb();

      // 1. Verify HMAC headers
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
      }

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, fedHeaders.origin))
        .get();

      if (!peer || peer.status !== 'active') {
        return reply.code(403).send({ error: 'Unknown or inactive peer', statusCode: 403 });
      }

      if (isLookupRateLimited(peer.origin)) {
        return reply.code(429).header('Retry-After', '60').send({ error: 'Rate limit exceeded', statusCode: 429 });
      }

      const bodyString = JSON.stringify(request.body);
      if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // Replay protection
      if (fedHeaders.nonce) {
        if (isNonceDuplicate(peer.origin, fedHeaders.nonce)) {
          return reply.code(409).send({ error: 'Duplicate nonce — possible replay', statusCode: 409 });
        }
      } else if (peer.nonceSupported) {
        return reply.code(401).send({ error: 'Nonce required — peer previously supported nonces', statusCode: 401 });
      }

      // 2. Validate body
      const rawId = (request.body as { homeUserId?: unknown } | null)?.homeUserId;
      if (typeof rawId !== 'string' || rawId.trim().length === 0) {
        return reply.code(400).send({ error: 'homeUserId is required (string)', statusCode: 400 });
      }
      const homeUserId = rawId.trim();

      // 3. Native-only lookup. Match by id (canonical native id) OR home_user_id
      // (backfilled column natives carry to satisfy tier-1 lookups). Excludes
      // tombstoned and replicated stubs.
      const user = db
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.isDeleted, 0),
            isNull(schema.users.homeInstance),
            or(eq(schema.users.id, homeUserId), eq(schema.users.homeUserId, homeUserId)),
          ),
        )
        .get();

      if (!user) {
        return reply.code(200).send({ found: false });
      }

      return reply.code(200).send({
        found: true,
        user: {
          homeUserId: user.homeUserId ?? user.id,
          username: user.username,
          profile: {
            displayName: user.displayName,
            avatar: user.avatar,
            avatarColor: user.avatarColor,
            status: user.status as 'online' | 'idle' | 'dnd' | 'offline' | null,
            banner: user.banner,
            bio: user.bio,
          },
        },
      });
    },
  );

  // ─── POST /api/federation/sync ──────────────────────────────────────────────
  // Server-to-server: checkpoint catch-up sync. A peer calls this after downtime
  // to retrieve missed DM mutations from the mutation log.
  // Authenticated via HMAC-SHA256 signature, same as /relay.
  app.post<{ Body: FederationSyncRequest }>(
    '/api/federation/sync',
    { bodyLimit: 1024 * 64 },
    async (request, reply) => {
      const db = getDb();
      const rawDb = getRawDb();

      // 1. Verify HMAC signature
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
      }

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, fedHeaders.origin))
        .get();

      if (!peer || peer.status !== 'active') {
        return reply.code(403).send({ error: 'Unknown or inactive peer', statusCode: 403 });
      }

      const bodyString = JSON.stringify(request.body);
      if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // 1b. Nonce-based replay protection
      if (fedHeaders.nonce) {
        if (isNonceDuplicate(peer.origin, fedHeaders.nonce)) {
          return reply.code(409).send({ error: 'Duplicate nonce — possible replay', statusCode: 409 });
        }
      } else if (peer.nonceSupported) {
        return reply.code(401).send({ error: 'Nonce required — peer previously supported nonces', statusCode: 401 });
      } else {
        console.warn(`[federation] Peer ${peer.origin} does not support replay protection (no nonce) [sync]`);
      }

      // Ratchet: mark peer as nonce-supporting if this is the first nonce we've seen
      if (fedHeaders.nonce && !peer.nonceSupported) {
        db.update(schema.federationPeers)
          .set({ nonceSupported: 1 })
          .where(eq(schema.federationPeers.id, peer.id))
          .run();
      }

      // 2. Validate & normalize request body
      const body = request.body;
      if (!body || typeof body.sinceTimestamp !== 'number' || body.sinceTimestamp < 0) {
        return reply.code(400).send({ error: 'sinceTimestamp must be a non-negative number', statusCode: 400 });
      }

      const sinceTimestamp = body.sinceTimestamp;
      const dmChannelIdFilter = body.dmChannelId && typeof body.dmChannelId === 'string' ? body.dmChannelId : null;
      const federatedIdFilter = body.federatedId && typeof body.federatedId === 'string' ? body.federatedId : null;
      const contextTypeFilter = body.contextType && typeof body.contextType === 'string'
        ? body.contextType as 'dm' | 'friend' | 'profile'
        : null;

      // Clamp limit: min 1, max 500, default 100
      let limit = typeof body.limit === 'number' ? body.limit : 100;
      limit = Math.max(1, Math.min(500, Math.floor(limit)));

      // 3. Query mutation log — branch by contextType
      let mutationRows: Array<{
        id: string;
        entity_id: string;
        context_id: string;
        context_type: string;
        mutation_type: string;
        mutated_at: number;
        payload: string | null;
      }>;

      // Maps local DM channel ID → federatedId for O(1) lookup in serializers.
      // Only populated in the DM branch (friend/profile branches don't need it).
      let channelFederatedIdMap = new Map<string, string>();

      if (contextTypeFilter === 'friend') {
        // ── Friend event sync: no DM channel logic needed ──
        mutationRows = rawDb.prepare(`
          SELECT id, entity_id, context_id, context_type, mutation_type, mutated_at, payload
          FROM federation_mutation_log
          WHERE context_type = 'friend' AND mutated_at > ?
          ORDER BY mutated_at ASC
          LIMIT ?
        `).all(sinceTimestamp, limit) as typeof mutationRows;
      } else if (contextTypeFilter === 'profile') {
        // ── Profile event sync: no DM channel logic needed ──
        mutationRows = rawDb.prepare(`
          SELECT id, entity_id, context_id, context_type, mutation_type, mutated_at, payload
          FROM federation_mutation_log
          WHERE context_type = 'profile' AND mutated_at > ?
          ORDER BY mutated_at ASC
          LIMIT ?
        `).all(sinceTimestamp, limit) as typeof mutationRows;
      } else {
        // ── DM sync path ──
        // Determine which DM channels to sync.
        // Use federated_id: any channel with a federated ID is a federated DM
        // that should be synced. The peer's relay endpoint will create the channel
        // if it doesn't exist, or match by federated_id if it does.
        const sharedChannelRows = rawDb.prepare(`
          SELECT id as dm_channel_id, federated_id FROM dm_channels
          WHERE federated_id IS NOT NULL AND deleted_at IS NULL
        `).all() as Array<{ dm_channel_id: string; federated_id: string }>;

        const sharedChannelIds = sharedChannelRows.map(r => r.dm_channel_id);
        channelFederatedIdMap = new Map<string, string>(
          sharedChannelRows.map(r => [r.dm_channel_id, r.federated_id])
        );

        // If filtering by federatedId, resolve to local channel ID
        let effectiveChannelFilter = dmChannelIdFilter;
        if (federatedIdFilter && !effectiveChannelFilter) {
          const fedChannel = rawDb.prepare(`
            SELECT id FROM dm_channels WHERE federated_id = ?
          `).get(federatedIdFilter) as { id: string } | undefined;
          if (fedChannel) {
            effectiveChannelFilter = fedChannel.id;
          }
        }

        if (sharedChannelIds.length === 0) {
          const syncResponse: FederationSyncResponse = {
            events: [],
            hasMore: false,
            checkpoint: sinceTimestamp,
          };
          return reply.code(200).send(syncResponse);
        }

        // 4. Query mutation log for the relevant channels
        //    Return mutations for ALL locally-created messages (source_instance IS NULL).
        //    This includes messages by replicated users (e.g., Heidi browsing orbit)
        //    because they were created on THIS instance and need to be synced to the peer.
        if (effectiveChannelFilter) {
          // Validate that the requested channel is actually shared with this peer
          if (!sharedChannelIds.includes(effectiveChannelFilter)) {
            const syncResponse: FederationSyncResponse = {
              events: [],
              hasMore: false,
              checkpoint: sinceTimestamp,
            };
            return reply.code(200).send(syncResponse);
          }

          mutationRows = rawDb.prepare(`
            SELECT ml.id, ml.entity_id, ml.context_id, ml.context_type, ml.mutation_type, ml.mutated_at, ml.payload
            FROM federation_mutation_log ml
            LEFT JOIN dm_messages dm ON ml.entity_id = dm.id
            WHERE ml.context_id = ?
              AND ml.context_type = 'dm'
              AND ml.mutated_at > ?
              AND (dm.id IS NOT NULL OR ml.mutation_type IN (
                'delete', 'member_add', 'member_remove', 'ownership_transfer',
                'dm_close', 'dm_reopen', 'read_state_update', 'file_rejected'
              ))
            ORDER BY ml.mutated_at ASC
            LIMIT ?
          `).all(effectiveChannelFilter, sinceTimestamp, limit) as typeof mutationRows;

          // For delete mutations, the dm_messages row won't exist — handle separately
          const deleteMutations = rawDb.prepare(`
            SELECT ml.id, ml.entity_id, ml.context_id, ml.context_type, ml.mutation_type, ml.mutated_at, ml.payload
            FROM federation_mutation_log ml
            WHERE ml.context_id = ?
              AND ml.context_type = 'dm'
              AND ml.mutated_at > ?
              AND ml.mutation_type = 'delete'
              AND ml.entity_id NOT IN (SELECT dm.id FROM dm_messages dm WHERE dm.id = ml.entity_id)
            ORDER BY ml.mutated_at ASC
            LIMIT ?
          `).all(effectiveChannelFilter, sinceTimestamp, limit) as typeof mutationRows;

          // Merge, deduplicate, sort, and re-limit
          const seen = new Set(mutationRows.map(r => r.id));
          for (const row of deleteMutations) {
            if (!seen.has(row.id)) {
              mutationRows.push(row);
              seen.add(row.id);
            }
          }
          mutationRows.sort((a, b) => a.mutated_at - b.mutated_at);
          if (mutationRows.length > limit) {
            mutationRows = mutationRows.slice(0, limit);
          }
        } else {
          // All shared channels — build IN clause with placeholders
          const placeholders = sharedChannelIds.map(() => '?').join(',');

          mutationRows = rawDb.prepare(`
            SELECT ml.id, ml.entity_id, ml.context_id, ml.context_type, ml.mutation_type, ml.mutated_at, ml.payload
            FROM federation_mutation_log ml
            LEFT JOIN dm_messages dm ON ml.entity_id = dm.id
            WHERE ml.context_id IN (${placeholders})
              AND ml.context_type = 'dm'
              AND ml.mutated_at > ?
              AND (dm.id IS NOT NULL OR ml.mutation_type IN (
                'delete', 'member_add', 'member_remove', 'ownership_transfer',
                'dm_close', 'dm_reopen', 'read_state_update', 'file_rejected'
              ))
            ORDER BY ml.mutated_at ASC
            LIMIT ?
          `).all(...sharedChannelIds, sinceTimestamp, limit) as typeof mutationRows;

          // For delete mutations, the dm_messages row won't exist — handle separately
          const deleteMutations = rawDb.prepare(`
            SELECT ml.id, ml.entity_id, ml.context_id, ml.context_type, ml.mutation_type, ml.mutated_at, ml.payload
            FROM federation_mutation_log ml
            WHERE ml.context_id IN (${placeholders})
              AND ml.context_type = 'dm'
              AND ml.mutated_at > ?
              AND ml.mutation_type = 'delete'
              AND ml.entity_id NOT IN (SELECT dm.id FROM dm_messages dm WHERE dm.id = ml.entity_id)
            ORDER BY ml.mutated_at ASC
            LIMIT ?
          `).all(...sharedChannelIds, sinceTimestamp, limit) as typeof mutationRows;

          // Merge, deduplicate, sort, and re-limit
          const seen = new Set(mutationRows.map(r => r.id));
          for (const row of deleteMutations) {
            if (!seen.has(row.id)) {
              mutationRows.push(row);
              seen.add(row.id);
            }
          }
          mutationRows.sort((a, b) => a.mutated_at - b.mutated_at);
          if (mutationRows.length > limit) {
            mutationRows = mutationRows.slice(0, limit);
          }
        }
      }

      // 5. Build response events from mutation log entries
      const events: FederationRelayEvent[] = [];

      for (const mutation of mutationRows) {
        const mutationType = mutation.mutation_type as 'create' | 'update' | 'delete' | 'reaction_add' | 'reaction_remove'
          | 'member_add' | 'member_remove' | 'ownership_transfer'
          | 'friend_request_create' | 'friend_request_update' | 'friend_request_cancel'
          | 'friend_add' | 'friend_remove'
          | 'dm_close' | 'dm_reopen' | 'read_state_update' | 'file_rejected'
          | 'profile_update';

        if (['member_add', 'member_remove', 'ownership_transfer',
             'friend_request_create', 'friend_request_update', 'friend_request_cancel',
             'friend_add', 'friend_remove'].includes(mutationType)) {
          // Membership and friend mutations store the full event in the payload
          const payload = mutation.payload ? JSON.parse(mutation.payload) : {};
          events.push({
            eventType: mutationType as FederationRelayEvent['eventType'],
            contextType: (mutation.context_type ?? 'dm') as 'dm' | 'friend' | 'profile',
            ...(mutation.context_type === 'dm' || !mutation.context_type ? { dmChannelId: mutation.context_id } : {}),
            messageId: mutation.entity_id,
            encryptionVersion: 0,
            timestamp: mutation.mutated_at,
            ...payload,
          });
          continue;
        }

        if (mutationType === 'delete') {
          // For deletes, we don't need the message content — just the ID and channel
          events.push({
            eventType: 'delete',
            dmChannelId: mutation.context_id,
            messageId: mutation.entity_id,
            encryptionVersion: 0,
            timestamp: mutation.mutated_at,
          });
          continue;
        }

        if (mutationType === 'reaction_add' || mutationType === 'reaction_remove') {
          // Use the stored payload from the mutation log
          if (mutation.payload) {
            let reactionData: { userId: string; homeUserId: string; homeInstance?: string; emoji: string; createdAt?: number } | null = null;
            try {
              reactionData = JSON.parse(mutation.payload) as { userId: string; homeUserId: string; homeInstance?: string; emoji: string; createdAt?: number };
            } catch {
              // Skip malformed payload
              continue;
            }

            events.push({
              eventType: mutationType,
              dmChannelId: mutation.context_id,
              messageId: mutation.entity_id,
              encryptionVersion: 0,
              timestamp: mutation.mutated_at,
              reaction: {
                userId: reactionData.userId,
                homeUserId: reactionData.homeUserId,
                homeInstance: reactionData.homeInstance || getOurOrigin(),
                emoji: reactionData.emoji,
                createdAt: reactionData.createdAt ?? mutation.mutated_at,
              },
            });
          }
          continue;
        }

        if (mutationType === 'dm_close' || mutationType === 'dm_reopen') {
          if (!mutation.payload) continue;
          let dmCloseReopenPayload: { homeUserId: string; homeInstance: string } | null = null;
          try { dmCloseReopenPayload = JSON.parse(mutation.payload); } catch { continue; }
          if (!dmCloseReopenPayload) continue;
          const fedIdCloseReopen = channelFederatedIdMap.get(mutation.context_id);
          if (!fedIdCloseReopen) continue;
          events.push({
            eventType: mutationType,
            dmChannelId: mutation.context_id,
            messageId: mutation.entity_id,
            federatedId: fedIdCloseReopen,
            encryptionVersion: 0,
            timestamp: mutation.mutated_at,
            dmCloseReopen: dmCloseReopenPayload,
          });
          continue;
        }

        if (mutationType === 'read_state_update') {
          if (!mutation.payload) continue;
          let readState: NonNullable<FederationRelayEvent['readState']> | null = null;
          try { readState = JSON.parse(mutation.payload) as NonNullable<FederationRelayEvent['readState']>; } catch { continue; }
          if (!readState) continue;
          const fedIdReadState = channelFederatedIdMap.get(mutation.context_id);
          if (!fedIdReadState) continue;
          events.push({
            eventType: 'read_state_update',
            dmChannelId: mutation.context_id,
            messageId: mutation.entity_id,
            federatedId: fedIdReadState,
            encryptionVersion: 0,
            timestamp: mutation.mutated_at,
            readState,
          });
          continue;
        }

        if (mutationType === 'file_rejected') {
          if (!mutation.payload) continue;
          let fileRejectedPayload: {
            attachmentId: string;
            sourceFilename: string;
            rejectionReason: string;
            rejectionLimit: number;
            affectedUserIds: string[];
          } | null = null;
          try { fileRejectedPayload = JSON.parse(mutation.payload); } catch { continue; }
          if (!fileRejectedPayload) continue;
          events.push({
            eventType: 'file_rejected',
            dmChannelId: mutation.context_id,
            messageId: mutation.entity_id,
            encryptionVersion: 0,
            timestamp: mutation.mutated_at,
            attachmentId: fileRejectedPayload.attachmentId,
            sourceFilename: fileRejectedPayload.sourceFilename,
            rejectionReason: fileRejectedPayload.rejectionReason,
            rejectionLimit: fileRejectedPayload.rejectionLimit,
            affectedUserIds: fileRejectedPayload.affectedUserIds,
          });
          continue;
        }

        if (mutationType === 'profile_update') {
          if (!mutation.payload) continue;
          let profileOuter: { profileUpdate?: NonNullable<FederationRelayEvent['profileUpdate']> } | null = null;
          try { profileOuter = JSON.parse(mutation.payload); } catch { continue; }
          if (!profileOuter?.profileUpdate) continue;
          events.push({
            eventType: 'profile_update',
            contextType: 'profile',
            messageId: mutation.entity_id,
            encryptionVersion: 0,
            timestamp: mutation.mutated_at,
            profileUpdate: profileOuter.profileUpdate,
          });
          continue;
        }

        // For create and update: fetch the current message state
        const message = db
          .select()
          .from(schema.dmMessages)
          .where(eq(schema.dmMessages.id, mutation.entity_id))
          .get();

        if (!message) {
          // Message was deleted after this create/update mutation was logged — skip it.
          // The delete mutation will handle the cleanup on the peer side.
          continue;
        }

        // Resolve the author user to get homeUserId and homeInstance
        const authorUser = db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, message.userId))
          .get();

        if (!authorUser) {
          continue;
        }

        const homeUserId = authorUser.homeUserId || authorUser.id;
        const homeInstance = authorUser.homeInstance || (config.domain ? `https://${config.domain}` : '');

        // Fetch attachments for the message
        const attachmentRows = db
          .select()
          .from(schema.attachments)
          .where(eq(schema.attachments.dmMessageId, message.id))
          .all();

        let localOrigin: string;
        try {
          localOrigin = resolveLocalOrigin(request);
        } catch {
          localOrigin = config.domain ? `https://${config.domain}` : '';
        }

        const attachments: FederationRelayAttachment[] = attachmentRows.map(a => ({
          id: a.id,
          filename: a.filename,
          originalName: a.originalName,
          mimetype: a.mimetype,
          size: a.size,
          width: a.width ?? undefined,
          height: a.height ?? undefined,
          duration: a.duration ?? undefined,
          playable: a.playable ?? null,
          thumbnailFilename: a.thumbnailFilename ?? undefined,
          sourceUrl: `${localOrigin}/api/uploads/${a.filename}`,
        }));

        // Include federatedId for group DMs so the peer uses the correct
        // channel lookup path instead of computing a 1-on-1 pair hash.
        const syncChannel = db
          .select({ federatedId: schema.dmChannels.federatedId, ownerId: schema.dmChannels.ownerId })
          .from(schema.dmChannels)
          .where(eq(schema.dmChannels.id, mutation.context_id))
          .get();

        events.push({
          eventType: mutationType,
          ...(syncChannel?.federatedId && syncChannel.ownerId ? { federatedId: syncChannel.federatedId } : {}),
          dmChannelId: mutation.context_id,
          messageId: message.id,
          encryptionVersion: 0,
          timestamp: mutation.mutated_at,
          participants: getDmParticipants(mutation.context_id),
          message: {
            userId: message.userId,
            homeUserId,
            homeInstance,
            content: message.content,
            replyToId: message.replyToId ?? null,
            editedAt: message.editedAt ?? null,
            createdAt: message.createdAt,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
        });
      }

      // 6. Compute pagination metadata
      const hasMore = mutationRows.length >= limit;
      const checkpoint = mutationRows.length > 0
        ? mutationRows[mutationRows.length - 1]!.mutated_at
        : sinceTimestamp;

      // 7. Update peer last-seen timestamp
      db.update(schema.federationPeers)
        .set({ lastSeenAt: Date.now() })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();

      const syncResponse: FederationSyncResponse = {
        events,
        hasMore,
        checkpoint,
      };

      return reply.code(200).send(syncResponse);
    },
  );
}

// ─── Relay Event Processing (shared by HTTP handler and initial sync) ────────

/**
 * Process an array of federation relay events. Used by the HTTP relay endpoint
 * and directly by the initial-sync worker (which skips the HTTP round-trip).
 */
export async function processRelayEvents(
  events: FederationRelayEvent[],
  sourceInstance: string,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
): Promise<{
  accepted: string[];
  rejected: Array<{ messageId: string; reason: string }>;
  undeliverable: Array<{ messageId: string; reason: string }>;
}> {
  const accepted: string[] = [];
  const rejected: Array<{ messageId: string; reason: string }> = [];
  const undeliverable: Array<{ messageId: string; reason: string }> = [];

  for (const event of events) {
    try {
      switch (event.eventType) {
        case 'create':
          await processCreateEvent(event, sourceInstance, peerOrigin, db, accepted, rejected);
          break;
        case 'update':
          processUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'delete':
          processDeleteEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'reaction_add':
          processReactionAddEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'reaction_remove':
          processReactionRemoveEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'member_add':
          await processMemberAddEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'member_remove':
          processMemberRemoveEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'ownership_transfer':
          processOwnershipTransferEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_request_create':
          await processFriendRequestCreateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_request_update':
          processFriendRequestUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_request_cancel':
          processFriendRequestCancelEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_add':
          await processFriendAddEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_remove':
          processFriendRemoveEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'file_rejected':
          processFileRejectedEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_call_start':
          processDmCallStartEvent(event, sourceInstance, db, accepted, rejected, undeliverable);
          break;
        case 'dm_call_accept':
          processDmCallAcceptEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_call_reject':
          processDmCallRejectEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_call_end':
          processDmCallEndEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_typing_start':
          processDmTypingStartEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_typing_stop':
          processDmTypingStopEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'profile_update':
          await processProfileUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'group_metadata_update':
          await processGroupMetadataUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'presence_update':
          processPresenceUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'read_state_update':
          processReadStateUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_close':
          processDmCloseEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_reopen':
          processDmReopenEvent(event, sourceInstance, db, accepted, rejected);
          break;
        default:
          rejected.push({ messageId: event.messageId, reason: 'unknown_event_type' });
          break;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'unknown_error';
      console.error(`[federation-relay] Error processing event ${event.messageId}:`, errMsg);
      rejected.push({ messageId: event.messageId, reason: 'processing_error' });
    }
  }

  return { accepted, rejected, undeliverable };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build the full DM channel payload used by `dm_channel_created` events.
 * Hydrates members, fetches the last message, and returns a `DmChannel`-shaped
 * object — or `null` when the channel row doesn't exist / is deleted.
 *
 * An optional `lastMessageOverride` lets callers supply the message object
 * directly (e.g. the just-relayed message) instead of querying the DB.
 */
function buildDmChannelPayload(
  channelId: string,
  db: ReturnType<typeof getDb>,
  lastMessageOverride?: DmMessageWithUser | null,
): DmChannel | null {
  const dmChannel = db.select()
    .from(schema.dmChannels)
    .where(and(eq(schema.dmChannels.id, channelId), isNull(schema.dmChannels.deletedAt)))
    .get();
  if (!dmChannel) return null;

  const allMemberRows = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channelId))
    .all();
  const memberUserIds = allMemberRows.map(m => m.userId);
  const users = memberUserIds.length > 0
    ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
    : [];

  let lastMessage: DmMessageWithUser | null = lastMessageOverride ?? null;
  if (!lastMessageOverride) {
    const lastMsgRow = db.select({ id: schema.dmMessages.id })
      .from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, channelId))
      .orderBy(desc(schema.dmMessages.createdAt))
      .limit(1)
      .get();
    if (lastMsgRow) {
      lastMessage = getDmMessageWithUser(lastMsgRow.id);
    }
  }

  return {
    id: dmChannel.id,
    ownerId: dmChannel.ownerId ?? null,
    federatedId: dmChannel.federatedId ?? null,
    createdAt: dmChannel.createdAt,
    members: users.map(u => sanitizeUser(u)),
    lastMessage,
  };
}

// ─── Relay Event Processors ──────────────────────────────────────────────────

/**
 * Extract bare domain from a homeInstance value.
 * Handles both full URLs ("https://nova.ddns.net") and bare domains ("nova.ddns.net").
 * Used to normalize homeInstance to a canonical format for identity matching.
 */
export function extractDomain(homeInstance: string): string {
  try {
    return new URL(homeInstance).hostname;
  } catch {
    // Already a bare domain or malformed — strip protocol manually
    return homeInstance.replace(/^https?:\/\//, '').split('/')[0] ?? homeInstance;
  }
}

/**
 * Verify that an acting user's homeInstance is legitimate for this relay.
 *
 * Two valid cases:
 * 1. **Direct**: author is from the source instance (standard S2S — peer sends events for its own users).
 * 2. **Homeward relay**: author is from the *receiving* instance. This happens when a client-federation
 *    user (e.g., erin@nova logged into orbit) sends a message on a remote server, and the
 *    S2S relay forwards it back to the author's home instance. The trusted peer is just the messenger.
 *
 * Both sides are normalized to bare domain before comparison.
 */
export function verifyAttribution(actingUserHomeInstance: string, sourceInstance: string): boolean {
  const authorDomain = extractDomain(actingUserHomeInstance);
  // Case 1: author belongs to the source peer
  if (authorDomain === extractDomain(sourceInstance)) return true;
  // Case 2: homeward relay — author belongs to THIS (receiving) instance
  if (authorDomain === extractDomain(getOurOrigin())) return true;
  return false;
}

/**
 * Resolve a home user ID to a local user.
 * Matches users where home_user_id = homeUserId, or where
 * the user's own id equals homeUserId and they have no home_instance set (local user).
 */
export function resolveLocalUser(
  homeUserId: string,
  db: ReturnType<typeof getDb>,
): typeof schema.users.$inferSelect | undefined {
  const candidates = db
    .select()
    .from(schema.users)
    .where(
      and(
        or(
          eq(schema.users.homeUserId, homeUserId),
          and(eq(schema.users.id, homeUserId), isNull(schema.users.homeInstance)),
        ),
        eq(schema.users.isDeleted, 0),
      ),
    )
    .all();

  // Prefer non-deleted active users; if multiple, prefer the one with homeUserId set
  // (replicated user) over a local user match
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  return candidates.find(u => u.homeUserId === homeUserId) ?? candidates[0];
}

/**
 * Unified federated user lookup — finds a user regardless of which code path
 * created them (auth registration vs S2S relay stub).
 *
 * Three-tier matching:
 * 1. Fast path: homeUserId column match (existing resolveLocalUser logic)
 * 2. Domain + username hint: normalized homeInstance domain + username base match
 * 3. Not found: returns undefined
 *
 * Does NOT perform side effects (backfill). See `backfillHomeUserId` for that.
 */
export function findFederatedUser(
  homeUserId: string,
  homeInstance: string,
  db: ReturnType<typeof getDb>,
  hints?: { username?: string | null },
): typeof schema.users.$inferSelect | undefined {
  // Tier 1: fast path — existing resolveLocalUser logic
  const fastMatch = resolveLocalUser(homeUserId, db);
  if (fastMatch) return fastMatch;

  // Tier 2: domain + username hint match
  if (!hints?.username) return undefined;

  const domain = extractDomain(homeInstance);
  const hintLower = hints.username.toLowerCase();

  // Scoped SQL query: match on homeInstance domain + username base
  // Username base is the part before '@'. We use SQL LIKE to match
  // '{hint}@%' pattern, plus an exact match for users without '@'.
  const candidates = db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.homeInstance, domain),
        eq(schema.users.isDeleted, 0),
        or(
          sql`lower(substr(${schema.users.username}, 1, instr(${schema.users.username}, '@') - 1)) = ${hintLower}`,
          and(
            sql`instr(${schema.users.username}, '@') = 0`,
            sql`lower(${schema.users.username}) = ${hintLower}`,
          ),
        ),
      ),
    )
    .all();

  if (candidates.length === 0) return undefined;

  // Pick best candidate: prefer real accounts over stubs, then most profile data
  if (candidates.length === 1) return candidates[0]!;

  return candidates.sort((a, b) => {
    // Real account (not federation-replicated) wins
    const aReal = a.passwordHash !== '!federation-replicated' ? 1 : 0;
    const bReal = b.passwordHash !== '!federation-replicated' ? 1 : 0;
    if (aReal !== bReal) return bReal - aReal;
    // More profile data wins
    const profileCount = (u: typeof a) =>
      [u.displayName, u.avatar, u.banner, u.bio].filter(Boolean).length;
    return profileCount(b) - profileCount(a);
  })[0]!;
}

/**
 * Backfill homeUserId on an existing user record so future lookups
 * use the fast path (tier 1). Called by resolveOrCreateReplicatedUser
 * after findFederatedUser matches via tier 2.
 */
function backfillHomeUserId(
  user: typeof schema.users.$inferSelect,
  homeUserId: string,
  db: ReturnType<typeof getDb>,
): typeof schema.users.$inferSelect {
  if (user.homeUserId === homeUserId) return user;
  // Only backfill if the user has no homeUserId yet. If they already have a
  // DIFFERENT non-null homeUserId, this means the wrong user was matched —
  // overwriting would corrupt their identity.
  if (user.homeUserId) {
    console.warn(`[federation] Refusing to overwrite homeUserId on user ${user.id} (${user.username}): existing=${user.homeUserId}, incoming=${homeUserId}`);
    return user;
  }
  db.update(schema.users)
    .set({ homeUserId })
    .where(eq(schema.users.id, user.id))
    .run();
  console.log(`[federation] Backfilled homeUserId=${homeUserId} on user ${user.id} (${user.username})`);
  return { ...user, homeUserId };
}

/**
 * Resolve a federated participant to a local user, creating a minimal
 * replicated user stub if one doesn't already exist.  This is needed
 * for the group-DM bootstrap path: when Instance C receives a
 * member_add event whose roster includes users that only live on
 * Instance A or B, those users won't have been pre-replicated via the
 * friend-connect flow.  We create a bare-bones row so the local DB
 * can reference them in dm_members / dm_messages.
 */
export function resolveOrCreateReplicatedUser(
  homeUserId: string,
  homeInstance: string,
  db: ReturnType<typeof getDb>,
  hints?: { username?: string | null; status?: 'online' | 'idle' | 'dnd' | 'offline' | null },
): typeof schema.users.$inferSelect | null {
  const existing = findFederatedUser(homeUserId, homeInstance, db, hints);
  if (existing) return backfillHomeUserId(existing, homeUserId, db);

  // Check if this identity was previously deleted — don't resurrect a tombstoned
  // user by creating a new stub. The isDeleted=0 filter in findFederatedUser
  // already hides the deleted row, so we must query without that filter here.
  const domain = extractDomain(homeInstance);
  const deletedMatch = db
    .select({ id: schema.users.id, isDeleted: schema.users.isDeleted })
    .from(schema.users)
    .where(and(eq(schema.users.homeUserId, homeUserId), eq(schema.users.homeInstance, domain)))
    .get();
  if (deletedMatch?.isDeleted) {
    console.log(`[federation] Skipping stub creation for deleted identity homeUserId=${homeUserId} (tombstoned)`);
    return null;
  }

  // Use the home user's real username when the caller passes a hint (the wire
  // profile snapshot from friend_request_create / friend_add / DM relay carries
  // it). This makes the local stub's `username` human-readable, so client-side
  // `parseFederatedUsername(username).baseName` returns the real handle. Falls
  // back to the snowflake-id scheme when no hint is available (legacy paths).
  const localPart = (hints?.username ?? homeUserId).toLowerCase();
  const baseUsername = `${localPart}@${domain}`.toLowerCase();

  // Guard against the (unlikely) case where this username already
  // exists — e.g. a prior partial replication or manual creation.
  let username = baseUsername;
  let collision = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  let attempt = 0;
  while (collision) {
    attempt++;
    username = `${localPart}_${attempt}@${domain}`.toLowerCase();
    collision = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    if (attempt > 10) {
      // Extremely unlikely; use a random suffix to break out
      username = `${localPart}_${randomBytes(4).toString('hex')}@${domain}`.toLowerCase();
      break;
    }
  }

  const userId = generateSnowflake();
  const now = Date.now();

  // Seed status from the wire snapshot when available — without this, a
  // freshly-created stub for an already-online remote sticks at 'offline'
  // until the home next emits a presence transition (presence_update only
  // fires on changes, not on stub creation). Falls back to 'offline'.
  const initialStatus = hints?.status ?? 'offline';

  db.insert(schema.users).values({
    id: userId,
    username,
    displayName: null,
    passwordHash: '!federation-replicated',  // Cannot be used to log in (bcrypt never produces this)
    status: initialStatus,
    isAdmin: 0,
    homeInstance: domain,  // Normalized to bare domain
    homeUserId,
    createdAt: now,
  }).run();

  const created = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!created) {
    throw new Error(`Failed to create replicated user for homeUserId=${homeUserId}`);
  }

  console.log(`[federation] Auto-created replicated user ${userId} (${username}) for homeUserId=${homeUserId} from ${domain}`);
  return created;
}

/**
 * Find or create a local DM channel for a federated DM.
 * Uses federated_id for deterministic cross-instance lookup.
 */
function findOrCreateDmChannel(
  federatedId: string,
  localUserIds: string[],
  db: ReturnType<typeof getDb>,
): string {
  // Try to find existing channel by federated ID
  const existing = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, federatedId))
    .get();

  if (existing) {
    // Ensure all users are members (they might have been removed)
    for (const userId of localUserIds) {
      const member = db
        .select()
        .from(schema.dmMembers)
        .where(
          and(
            eq(schema.dmMembers.dmChannelId, existing.id),
            eq(schema.dmMembers.userId, userId),
          ),
        )
        .get();

      if (!member) {
        db.insert(schema.dmMembers)
          .values({
            dmChannelId: existing.id,
            userId,
            closed: 0,
          })
          .run();
      }
    }
    // Late-bind: if a FederatedCallEntry exists for this federatedId with null dmChannelId,
    // update it now that we have a local channel
    connectionManager.lateBindFederatedCall(federatedId, existing.id);
    return existing.id;
  }

  // Create new DM channel with federated ID
  const channelId = generateSnowflake();
  const now = Date.now();

  db.insert(schema.dmChannels)
    .values({
      id: channelId,
      federatedId,
      createdAt: now,
    })
    .run();

  for (const userId of localUserIds) {
    db.insert(schema.dmMembers)
      .values({
        dmChannelId: channelId,
        userId,
        closed: 0,
      })
      .run();
  }

  // Late-bind: if a FederatedCallEntry exists for this federatedId with null dmChannelId,
  // update it now that we have a local channel
  connectionManager.lateBindFederatedCall(federatedId, channelId);

  return channelId;
}

/**
 * Build a DmMessageWithUser payload for WebSocket broadcasting.
 */
function buildDmMessagePayload(
  messageRow: {
    id: string;
    dmChannelId: string;
    userId: string;
    content: string | null;
    replyToId: string | null;
    editedAt: number | null;
    createdAt: number;
  },
  userRow: typeof schema.users.$inferSelect,
): DmMessageWithUser {
  return {
    id: messageRow.id,
    dmChannelId: messageRow.dmChannelId,
    channelId: messageRow.dmChannelId,
    userId: messageRow.userId,
    content: messageRow.content,
    replyToId: messageRow.replyToId,
    editedAt: messageRow.editedAt,
    createdAt: messageRow.createdAt,
    user: sanitizeUser(userRow),
    attachments: [],
    embeds: [],
    reactions: [],
  };
}

/**
 * Validate that a URL's hostname matches the peer origin's hostname (SSRF protection).
 */
function isUrlFromPeer(sourceUrl: string, peerOrigin: string): boolean {
  try {
    const sourceHost = new URL(sourceUrl).hostname;
    const peerHost = new URL(peerOrigin).hostname;
    return sourceHost === peerHost;
  } catch {
    return false;
  }
}

async function processCreateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.message) {
    rejected.push({ messageId: event.messageId, reason: 'missing_message_payload' });
    return;
  }

  if (!event.participants || event.participants.length < 2) {
    rejected.push({ messageId: event.messageId, reason: 'missing_participants' });
    return;
  }

  // Attribution: message author must belong to source instance (FED-010)
  if (!verifyAttribution(event.message.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in create: message homeInstance=${extractDomain(event.message.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Dedup: check for existing message with same source
  const existingMsg = db
    .select()
    .from(schema.dmMessages)
    .where(
      and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, event.messageId),
      ),
    )
    .get();

  if (existingMsg) {
    rejected.push({ messageId: event.messageId, reason: 'duplicate' });
    return;
  }

  // Resolve ALL participants to local users, auto-creating replicated stubs
  // for remote users that don't have a local record yet. This ensures 1-on-1
  // federated DMs work even when the remote user hasn't connected or friended.
  const resolvedParticipants: Array<{
    localUser: typeof schema.users.$inferSelect;
    homeUserId: string;
  }> = [];

  for (const p of event.participants) {
    let localUser = resolveOrCreateReplicatedUser(p.homeUserId, p.homeInstance, db, { username: p.profile?.username, status: p.profile?.status });
    // Skip deleted identities — don't include tombstoned users in the DM
    if (!localUser) continue;
    // Hydrate with profile data from the relay event (displayName, avatar, etc.)
    if (p.profile) {
      localUser = await hydrateReplicatedUserProfile(localUser, p.profile, db);
    }
    resolvedParticipants.push({ localUser, homeUserId: p.homeUserId });
  }

  if (resolvedParticipants.length < 2) {
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  // Find the author among the resolved participants
  const authorEntry = resolvedParticipants.find(
    p => p.homeUserId === event.message!.homeUserId,
  );
  if (!authorEntry) {
    rejected.push({ messageId: event.messageId, reason: 'author_not_found' });
    return;
  }
  const authorUser = authorEntry.localUser;

  // Resolve local DM channel: group DMs carry a federatedId and the channel
  // must already exist (bootstrapped by a prior member_add event); 1-on-1 DMs
  // are computed from the pair of home user IDs and created on demand.
  let localDmChannelId: string;

  if (event.federatedId) {
    // Group DM: look up by federated_id (channel must already exist from member_add bootstrap)
    const channel = db
      .select()
      .from(schema.dmChannels)
      .where(and(
        eq(schema.dmChannels.federatedId, event.federatedId),
        isNull(schema.dmChannels.deletedAt),
      ))
      .get();

    if (!channel) {
      rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
      return;
    }
    localDmChannelId = channel.id;
  } else {
    // 1-on-1 DM: compute federated_id from pair and find/create channel
    const federatedId = computeFederatedId(
      resolvedParticipants[0]!.homeUserId,
      resolvedParticipants[1]!.homeUserId,
    );
    localDmChannelId = findOrCreateDmChannel(
      federatedId,
      [resolvedParticipants[0]!.localUser.id, resolvedParticipants[1]!.localUser.id],
      db,
    );
  }

  // Insert the message
  const localMessageId = generateSnowflake();
  db.insert(schema.dmMessages)
    .values({
      id: localMessageId,
      dmChannelId: localDmChannelId,
      userId: authorUser.id,
      content: event.message.content,
      type: event.message.type === 'system' ? 'system' : 'user',
      replyToId: null,
      createdAt: event.message.createdAt,
      editedAt: null,
      sourceInstance,
      sourceMessageId: event.messageId,
      encryptionVersion: 0,
    })
    .run();

  // Create attachment rows and queue file downloads (SSRF-validated).
  // Attachment rows are created immediately with filename = sourceUrl so the
  // initial WebSocket broadcast includes working remote URLs. The background
  // file worker will UPDATE the filename to the local path after download.
  if (event.message.attachments && event.message.attachments.length > 0) {
    const now = Date.now();
    for (const attachment of event.message.attachments) {
      if (!isUrlFromPeer(attachment.sourceUrl, peerOrigin)) {
        console.warn(
          `[federation-relay] Rejecting attachment URL ${attachment.sourceUrl} — hostname does not match peer ${peerOrigin}`,
        );
        continue;
      }

      // Create the attachment row with sourceUrl as the interim filename.
      // AttachmentRenderer already handles filenames starting with 'http' —
      // it uses them as direct URLs. When the file worker downloads the file,
      // it updates this row's filename to the local path.
      const attachmentId = generateSnowflake();
      db.insert(schema.attachments)
        .values({
          id: attachmentId,
          dmMessageId: localMessageId,
          uploaderId: null,
          filename: attachment.sourceUrl,
          originalName: attachment.originalName,
          mimetype: attachment.mimetype,
          size: attachment.size,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          duration: attachment.duration ?? null,
          playable: attachment.playable ?? null,
          thumbnailFilename: null,  // Don't copy source thumbnail — it doesn't exist locally
          sourceUrl: attachment.sourceUrl,
          createdAt: now,
        })
        .run();

      // Queue the background file download
      db.insert(schema.federationFileQueue)
        .values({
          id: generateSnowflake(),
          peerOrigin,
          dmMessageId: localMessageId,
          sourceUrl: attachment.sourceUrl,
          originalName: attachment.originalName,
          mimetype: attachment.mimetype,
          size: attachment.size,
          status: 'pending',
          nextRetryAt: now,
          expiresAt: now + 30 * 86_400_000,
          createdAt: now,
        })
        .run();
    }
  }

  // Broadcast to local WebSocket clients, but skip members whose home instance
  // is the source instance — they already have the original message via their
  // home instance's WebSocket connection.
  const fullMessage = getDmMessageWithUser(localMessageId);
  if (fullMessage) {
    const dmMembers = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, localDmChannelId))
      .all();

    for (const member of dmMembers) {
      // If the member closed this DM, reopen it and send dm_channel_created
      // so the sidebar resurfaces before the message arrives.
      if (member.closed === 1) {
        db.update(schema.dmMembers)
          .set({ closed: 0 })
          .where(and(
            eq(schema.dmMembers.dmChannelId, localDmChannelId),
            eq(schema.dmMembers.userId, member.userId),
          ))
          .run();

        const payload = buildDmChannelPayload(localDmChannelId, db, fullMessage);
        if (payload) {
          connectionManager.sendToUser(member.userId, {
            type: 'dm_channel_created',
            dmChannel: payload,
          });
        }
      }

      connectionManager.sendToUser(member.userId, {
        type: 'dm_message_created',
        message: fullMessage,
      });
    }
  }

  // Belt-and-suspenders: clear typing indicator for the author on inbound relay.
  // This catches the case where the explicit dm_typing_stop relay was lost.
  const relayDmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, localDmChannelId))
    .all();

  for (const member of relayDmMembers) {
    if (member.userId !== authorUser.id) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_typing_stop',
        dmChannelId: localDmChannelId,
        userId: authorUser.id,
      });
    }
  }

  accepted.push(event.messageId);
}

function processUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  // Attribution: if homeInstance present, verify it matches source (FED-010)
  if (event.message?.homeInstance && !verifyAttribution(event.message.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in update: message homeInstance=${extractDomain(event.message.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const localMsg = db
    .select()
    .from(schema.dmMessages)
    .where(
      and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, event.messageId),
      ),
    )
    .get();

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'unknown_message' });
    return;
  }

  const content = event.message?.content ?? null;
  const editedAt = event.message?.editedAt ?? Date.now();

  db.update(schema.dmMessages)
    .set({ content, editedAt })
    .where(eq(schema.dmMessages.id, localMsg.id))
    .run();

  // Broadcast update to local clients
  const authorUser = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, localMsg.userId))
    .get();

  if (authorUser) {
    const updatedPayload = buildDmMessagePayload(
      {
        id: localMsg.id,
        dmChannelId: localMsg.dmChannelId,
        userId: localMsg.userId,
        content,
        replyToId: localMsg.replyToId,
        editedAt,
        createdAt: localMsg.createdAt,
      },
      authorUser,
    );

    // Re-fetch reactions and attachments for the complete payload
    const reactions = db
      .select()
      .from(schema.dmReactions)
      .where(eq(schema.dmReactions.dmMessageId, localMsg.id))
      .all();

    const attachments = db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.dmMessageId, localMsg.id))
      .all();

    updatedPayload.reactions = reactions.map(r => ({
      id: r.id,
      messageId: r.dmMessageId,
      userId: r.userId,
      emoji: r.emoji,
      createdAt: r.createdAt,
    }));

    updatedPayload.attachments = attachments.map(a => ({
      id: a.id,
      messageId: a.dmMessageId ?? a.messageId ?? '',
      filename: a.filename,
      originalName: a.originalName,
      mimetype: a.mimetype,
      size: a.size,
      thumbnailFilename: a.thumbnailFilename,
      width: a.width,
      height: a.height,
      duration: a.duration,
      playable: a.playable ?? null,
      createdAt: a.createdAt,
    }));

    connectionManager.sendToDmMembers(localMsg.dmChannelId, {
      type: 'dm_message_updated',
      message: updatedPayload,
    });
  }

  accepted.push(event.messageId);
}

function processDeleteEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  // FED-010: delete is safe by design — lookup scoped to sourceInstance+sourceMessageId
  const localMsg = db
    .select()
    .from(schema.dmMessages)
    .where(
      and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, event.messageId),
      ),
    )
    .get();

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'unknown_message' });
    return;
  }

  // Collect attachment filenames before deletion for disk cleanup
  const attachmentRows = db
    .select({ filename: schema.attachments.filename })
    .from(schema.attachments)
    .where(eq(schema.attachments.dmMessageId, localMsg.id))
    .all();

  // Delete attachments, reactions, and message atomically
  db.transaction((tx) => {
    tx.delete(schema.attachments)
      .where(eq(schema.attachments.dmMessageId, localMsg.id))
      .run();
    tx.delete(schema.dmReactions)
      .where(eq(schema.dmReactions.dmMessageId, localMsg.id))
      .run();
    tx.delete(schema.dmMessages)
      .where(eq(schema.dmMessages.id, localMsg.id))
      .run();
  });

  // Clean up files from disk
  deleteAttachmentFiles(attachmentRows);

  // Broadcast deletion to local clients
  connectionManager.sendToDmMembers(localMsg.dmChannelId, {
    type: 'dm_message_deleted',
    messageId: localMsg.id,
    dmChannelId: localMsg.dmChannelId,
  });

  accepted.push(event.messageId);
}

/**
 * Resolve a local DM message from a federation relay event's canonical identity.
 * Uses messageHomeInstance to branch the lookup:
 * - If the message originated on THIS instance → find by local ID
 * - Otherwise → find by sourceInstance + sourceMessageId tracking
 * Falls back to relay sender origin when messageHomeInstance is absent (backward compat).
 */
function resolveLocalDmMessage(
  canonicalMessageId: string,
  messageHomeInstance: string | undefined,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
): typeof schema.dmMessages.$inferSelect | undefined {
  if (messageHomeInstance && messageHomeInstance === getOurOrigin()) {
    return db
      .select()
      .from(schema.dmMessages)
      .where(
        and(
          eq(schema.dmMessages.id, canonicalMessageId),
          isNull(schema.dmMessages.sourceInstance),
        ),
      )
      .get();
  }
  const originInstance = messageHomeInstance || sourceInstance;
  return db
    .select()
    .from(schema.dmMessages)
    .where(
      and(
        eq(schema.dmMessages.sourceInstance, originInstance),
        eq(schema.dmMessages.sourceMessageId, canonicalMessageId),
      ),
    )
    .get();
}

function processReactionAddEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.reaction) {
    rejected.push({ messageId: event.messageId, reason: 'missing_reaction_payload' });
    return;
  }

  // Attribution: reacting user must belong to source instance (FED-010)
  if (!event.reaction.homeInstance || !verifyAttribution(event.reaction.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in reaction_add: reaction homeInstance=${event.reaction.homeInstance ? extractDomain(event.reaction.homeInstance) : 'missing'} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const canonicalMessageId = event.reaction.messageId ?? event.messageId;
  const localMsg = resolveLocalDmMessage(
    canonicalMessageId,
    event.reaction.messageHomeInstance,
    sourceInstance,
    db,
  );

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'unknown_message' });
    return;
  }

  // Resolve the reacting user
  const reactingUser = resolveLocalUser(event.reaction.homeUserId, db);
  if (!reactingUser) {
    rejected.push({ messageId: event.messageId, reason: 'user_not_found' });
    return;
  }

  // Dedup: check if this user already reacted with this emoji
  const existingReaction = db
    .select()
    .from(schema.dmReactions)
    .where(
      and(
        eq(schema.dmReactions.dmMessageId, localMsg.id),
        eq(schema.dmReactions.userId, reactingUser.id),
        eq(schema.dmReactions.emoji, event.reaction.emoji),
      ),
    )
    .get();

  if (existingReaction) {
    // Already exists — treat as accepted (idempotent)
    accepted.push(event.messageId);
    return;
  }

  const reactionId = generateSnowflake();
  const now = event.reaction.createdAt || Date.now();

  db.insert(schema.dmReactions)
    .values({
      id: reactionId,
      dmMessageId: localMsg.id,
      userId: reactingUser.id,
      emoji: event.reaction.emoji,
      createdAt: now,
    })
    .run();

  // Broadcast to local clients
  connectionManager.sendToDmMembers(localMsg.dmChannelId, {
    type: 'reaction_added',
    messageId: localMsg.id,
    reaction: {
      id: reactionId,
      messageId: localMsg.id,
      userId: reactingUser.id,
      emoji: event.reaction.emoji,
      createdAt: now,
      user: sanitizeUser(reactingUser),
    },
  });

  accepted.push(event.messageId);
}

function processReactionRemoveEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.reaction) {
    rejected.push({ messageId: event.messageId, reason: 'missing_reaction_payload' });
    return;
  }

  // Attribution: reacting user must belong to source instance (FED-010)
  if (!event.reaction.homeInstance || !verifyAttribution(event.reaction.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in reaction_remove: reaction homeInstance=${event.reaction.homeInstance ? extractDomain(event.reaction.homeInstance) : 'missing'} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const canonicalMessageId = event.reaction.messageId ?? event.messageId;
  const localMsg = resolveLocalDmMessage(
    canonicalMessageId,
    event.reaction.messageHomeInstance,
    sourceInstance,
    db,
  );

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'unknown_message' });
    return;
  }

  // Resolve the reacting user
  const reactingUser = resolveLocalUser(event.reaction.homeUserId, db);
  if (!reactingUser) {
    rejected.push({ messageId: event.messageId, reason: 'user_not_found' });
    return;
  }

  const result = db
    .delete(schema.dmReactions)
    .where(
      and(
        eq(schema.dmReactions.dmMessageId, localMsg.id),
        eq(schema.dmReactions.userId, reactingUser.id),
        eq(schema.dmReactions.emoji, event.reaction.emoji),
      ),
    )
    .run();

  if (result.changes > 0) {
    connectionManager.sendToDmMembers(localMsg.dmChannelId, {
      type: 'reaction_removed',
      messageId: localMsg.id,
      userId: reactingUser.id,
      emoji: event.reaction.emoji,
    });
  }

  accepted.push(event.messageId);
}

// ─── Membership mutation processors ──────────────────────────────────────────

export async function processMemberAddEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.federatedId || !event.membership?.user) {
    rejected.push({ messageId: event.messageId, reason: 'missing_membership_payload' });
    return;
  }

  // Idempotency: a prior delivery of this exact event has already been processed.
  // The system message we persist below carries `(source_instance, source_message_id)`
  // and is guarded by `idx_dm_messages_source_unique`, so presence of a row here is
  // proof the event's side-effects are already in place. Accept silently to prevent
  // outbox retries and initial-sync replay from creating duplicate system messages.
  const existingSysMsg = db
    .select({ id: schema.dmMessages.id })
    .from(schema.dmMessages)
    .where(and(
      eq(schema.dmMessages.sourceInstance, sourceInstance),
      eq(schema.dmMessages.sourceMessageId, event.messageId),
    ))
    .get();
  if (existingSysMsg) {
    accepted.push(event.messageId);
    return;
  }

  // Look up local channel by federated_id
  let channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  let bootstrapped = false;

  // Bootstrap: channel doesn't exist yet — create from group metadata
  if (!channel && event.group) {
    // Attribution: only the owner's instance can bootstrap a group (FED-010)
    if (event.group.owner && !verifyAttribution(event.group.owner.homeInstance, sourceInstance)) {
      console.warn(`[federation] Attribution mismatch in member_add bootstrap: owner homeInstance=${extractDomain(event.group.owner.homeInstance)} source=${extractDomain(sourceInstance)}`);
      rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
      return;
    }

    const channelId = generateSnowflake();
    const now = Date.now();

    // Resolve owner — create a replicated stub if unknown
    let ownerId: string | null = null;
    if (event.group.owner) {
      const ownerLocal = resolveOrCreateReplicatedUser(event.group.owner.homeUserId, event.group.owner.homeInstance, db, { username: event.group.owner.profile?.username, status: event.group.owner.profile?.status });
      ownerId = ownerLocal?.id ?? null;
    }

    // Group metadata snapshot. Older peers omit these fields — fall back
    // to safe defaults (null name/icon, metadataUpdatedAt=0). When an icon
    // URL is present, mirror processGroupMetadataUpdateEvent and try to
    // download a local copy; on failure, persist the absolute URL.
    const bootstrapName = event.group.name ?? null;
    const bootstrapIconUrl = event.group.icon ?? null;
    const bootstrapMetadataUpdatedAt = event.group.metadataUpdatedAt ?? 0;
    let bootstrapResolvedIcon: string | null = bootstrapIconUrl;
    if (bootstrapIconUrl !== null) {
      const localFile = await downloadProfileAsset(bootstrapIconUrl, sourceInstance);
      bootstrapResolvedIcon = localFile ?? bootstrapIconUrl;
    }

    db.insert(schema.dmChannels)
      .values({
        id: channelId,
        federatedId: event.federatedId,
        ownerId,
        ownerHomeUserId: event.group.owner?.homeUserId ?? null,
        // Canonicalize on storage so future authority comparisons against
        // `sourceInstance` (always a full URL) match cleanly. Defensive: older
        // peers may have sent a bare host on the wire.
        ownerHomeInstance: canonicalizeHomeInstance(event.group.owner?.homeInstance) ?? null,
        createdAt: now,
        name: bootstrapName,
        icon: bootstrapResolvedIcon,
        metadataUpdatedAt: bootstrapMetadataUpdatedAt,
      })
      .run();

    // Add all roster members — create replicated user stubs for any
    // participants from remote instances that haven't been seen before.
    for (const member of event.group.members) {
      const rosterUser = resolveOrCreateReplicatedUser(member.homeUserId, member.homeInstance, db, { username: member.profile?.username, status: member.profile?.status });
      // Skip deleted identities — tombstoned users can't be added to a DM
      if (!rosterUser) continue;
      const existing = db.select().from(schema.dmMembers)
        .where(and(
          eq(schema.dmMembers.dmChannelId, channelId),
          eq(schema.dmMembers.userId, rosterUser.id),
        )).get();
      if (!existing) {
        db.insert(schema.dmMembers).values({
          dmChannelId: channelId,
          userId: rosterUser.id,
          closed: 0,
        }).run();
      }
    }

    channel = db.select().from(schema.dmChannels)
      .where(eq(schema.dmChannels.id, channelId)).get();

    console.log(`[federation] Bootstrapped group DM channel ${channelId} (federated_id: ${event.federatedId})`);

    bootstrapped = true;
  }

  if (!channel) {
    rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
    return;
  }

  // Authority note: any HMAC-verified peer can relay member_add events.
  // The HMAC signature proves the event came from a trusted peer.
  // The attribution check below still validates that addedBy belongs to the source instance.

  // Attribution: adder must belong to source instance (FED-010)
  if (event.membership.addedBy && !verifyAttribution(event.membership.addedBy.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in member_add: addedBy homeInstance=${extractDomain(event.membership.addedBy.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Cancel soft-delete if channel was pending GC
  if (channel.deletedAt) {
    db.update(schema.dmChannels)
      .set({ deletedAt: null })
      .where(eq(schema.dmChannels.id, channel.id))
      .run();
  }

  // Resolve the added user — create a replicated stub if unknown
  const localUser = resolveOrCreateReplicatedUser(
    event.membership.user.homeUserId,
    event.membership.user.homeInstance,
    db,
    { username: event.membership.user.profile?.username, status: event.membership.user.profile?.status },
  );
  if (!localUser) {
    // The user's identity has been deleted — don't add a tombstoned user to the DM
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  // Enforce max 10 members
  const memberCount = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channel.id))
    .all().length;
  if (memberCount >= 10) {
    rejected.push({ messageId: event.messageId, reason: 'max_members_exceeded' });
    return;
  }

  // Add member (idempotent)
  const existingMember = db.select().from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    )).get();

  if (!existingMember) {
    db.insert(schema.dmMembers).values({
      dmChannelId: channel.id,
      userId: localUser.id,
      closed: 0,
    }).run();
  }

  // Insert system message for member addition — tagged with (sourceInstance, sourceMessageId)
  // so subsequent deliveries of the same event are deduplicated at the top of this function.
  // The tag is applied in both the bootstrap and incremental paths, because bootstrap replays
  // would otherwise find the channel already present and fall through to the incremental path,
  // creating spurious system messages (the exact bug this fixes).
  const actorUser = event.membership.addedBy
    ? resolveOrCreateReplicatedUser(event.membership.addedBy.homeUserId, event.membership.addedBy.homeInstance, db, { username: event.membership.addedBy.profile?.username, status: event.membership.addedBy.profile?.status })
    : null;
  const actorId = actorUser?.id ?? localUser.id;
  const addBaseName = localUser.username?.includes('@') ? localUser.username.split('@')[0] : (localUser.username ?? 'Unknown');
  const addSysMsgId = generateSnowflake();
  const addSysCreatedAt = Date.now();
  const addSysContent = JSON.stringify({
    event: 'member_added',
    targetUserId: localUser.id,
    targetDisplayName: localUser.displayName ?? addBaseName,
  });

  db.insert(schema.dmMessages).values({
    id: addSysMsgId,
    dmChannelId: channel.id,
    userId: actorId,
    content: addSysContent,
    type: 'system',
    createdAt: addSysCreatedAt,
    sourceInstance,
    sourceMessageId: event.messageId,
  }).run();

  const systemMessagePayload = {
    id: addSysMsgId,
    dmChannelId: channel.id,
    userId: actorId,
    content: addSysContent,
    type: 'system' as const,
    createdAt: addSysCreatedAt,
    sourceInstance,
    sourceMessageId: event.messageId,
    editedAt: null,
    replyToId: null,
    user: actorUser ? sanitizeUser(actorUser) : sanitizeUser(localUser),
    attachments: [],
    embeds: [],
    reactions: [],
  };

  if (bootstrapped) {
    // Bootstrap: send dm_channel_created to home-local members only (prevents
    // duplicate sidebar entries for users connected to multiple instances).
    // Include the system message we just persisted as lastMessage so the sidebar
    // preview and unread calculation use the same anchor as future messages.
    const memberRows = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, channel.id))
      .all();
    const memberUserIds = memberRows.map(m => m.userId);
    const memberUsers = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const bootstrapResult = {
      id: channel.id,
      federatedId: channel.federatedId,
      ownerId: channel.ownerId,
      createdAt: channel.createdAt,
      members: memberUsers.map(u => sanitizeUser(u)),
      lastMessage: systemMessagePayload,
    };

    const bootstrapOrigin = getOurOrigin();
    for (const mu of memberUsers) {
      const muHome = mu.homeInstance
        ? (mu.homeInstance.startsWith('http') ? mu.homeInstance : `https://${mu.homeInstance}`)
        : bootstrapOrigin;  // null homeInstance = native local user
      if (muHome !== bootstrapOrigin) continue;
      connectionManager.sendToUser(mu.id, {
        type: 'dm_channel_created',
        dmChannel: bootstrapResult as unknown as DmChannel,
      });
    }
  } else {
    // Incremental: channel already exists for local members, so broadcast the
    // structural change (dm_member_added) and the chat message.
    connectionManager.sendToDmMembers(channel.id, {
      type: 'dm_message_created',
      message: systemMessagePayload as unknown as DmMessageWithUser,
    });
    connectionManager.sendToDmMembers(channel.id, {
      type: 'dm_member_added',
      dmChannelId: channel.id,
      user: sanitizeUser(localUser),
    });
  }

  accepted.push(event.messageId);
}

export function processMemberRemoveEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.membership?.user) {
    rejected.push({ messageId: event.messageId, reason: 'missing_membership_payload' });
    return;
  }

  // Attribution: for self-leave, user must belong to source instance (FED-010)
  if (event.membership.reason === 'leave' && !verifyAttribution(event.membership.user.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in member_remove: user homeInstance=${extractDomain(event.membership.user.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Idempotency: skip if this exact event has already been processed.
  // See `processMemberAddEvent` for the rationale — deduplicates retries and
  // initial-sync replay so we don't insert duplicate leave/kick system messages
  // or re-trigger broadcast and soft-delete side-effects.
  const existingSysMsg = db
    .select({ id: schema.dmMessages.id })
    .from(schema.dmMessages)
    .where(and(
      eq(schema.dmMessages.sourceInstance, sourceInstance),
      eq(schema.dmMessages.sourceMessageId, event.messageId),
    ))
    .get();
  if (existingSysMsg) {
    accepted.push(event.messageId);
    return;
  }

  const channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // Validate authority: owner's instance for kicks, any instance for self-leave.
  //
  // `sourceInstance` arrives as a full URL from `federationWorker.ts` (always
  // `getOurOrigin()` on the sender). `channel.ownerHomeInstance`, however, can be
  // stored either as a bare host (from `users.homeInstance`, written by
  // `resolveOrCreateReplicatedUser` and by group DM ownership transfers to a
  // federated user) OR as a full URL (group DM creation / transfers to a local
  // user, which fall back to `domainOrigin = getOurOrigin()`). Strict equality
  // here mis-fires for the bare-vs-full mismatch — see the historical bug entry
  // in `docs/systems/dm-system.md`. Always compare through
  // `normalizeOriginForCompare`, matching the established pattern for federation
  // authority checks.
  if (event.membership.reason !== 'leave' && channel.ownerHomeInstance &&
      normalizeOriginForCompare(sourceInstance) !== normalizeOriginForCompare(channel.ownerHomeInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'unauthorized_source' });
    return;
  }

  const localUser = resolveLocalUser(event.membership.user.homeUserId, db);
  if (!localUser) {
    accepted.push(event.messageId);
    return;
  }

  // Insert system message for member leaving (before deletion so the broadcast
  // still reaches the departing user's connections). Tagged with source for dedup.
  const leaveBaseName = localUser.username?.includes('@') ? localUser.username.split('@')[0] : (localUser.username ?? 'Unknown');
  const leaveSysMsgId = generateSnowflake();
  const leaveSysCreatedAt = Date.now();
  const leaveSysContent = JSON.stringify({
    event: 'member_removed',
    targetUserId: localUser.id,
    targetDisplayName: localUser.displayName ?? leaveBaseName,
    reason: event.membership?.reason ?? 'leave',
  });
  db.insert(schema.dmMessages).values({
    id: leaveSysMsgId,
    dmChannelId: channel.id,
    userId: localUser.id,
    content: leaveSysContent,
    type: 'system',
    createdAt: leaveSysCreatedAt,
    sourceInstance,
    sourceMessageId: event.messageId,
  }).run();

  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_message_created',
    message: {
      id: leaveSysMsgId,
      dmChannelId: channel.id,
      userId: localUser.id,
      content: leaveSysContent,
      type: 'system',
      createdAt: leaveSysCreatedAt,
      sourceInstance,
      sourceMessageId: event.messageId,
      editedAt: null,
      replyToId: null,
      user: sanitizeUser(localUser),
      attachments: [],
      embeds: [],
      reactions: [],
    } as unknown as DmMessageWithUser,
  });

  // Remove member (idempotent)
  db.delete(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .run();

  // Clean up read states
  db.delete(schema.readStates)
    .where(and(
      eq(schema.readStates.userId, localUser.id),
      eq(schema.readStates.channelId, channel.id),
    ))
    .run();

  // Broadcast to local WebSocket clients
  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_member_removed',
    dmChannelId: channel.id,
    userId: localUser.id,
  });

  // Check if zero local members remain — begin soft-delete GC
  const remaining = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channel.id))
    .all();

  if (remaining.length === 0) {
    db.update(schema.dmChannels)
      .set({ deletedAt: Date.now() })
      .where(eq(schema.dmChannels.id, channel.id))
      .run();
    console.log(`[federation] Group DM ${channel.id} has no local members, soft-deleted for GC`);
  }

  accepted.push(event.messageId);
}

export function processOwnershipTransferEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.ownership) {
    rejected.push({ messageId: event.messageId, reason: 'missing_ownership_payload' });
    return;
  }

  // Attribution: previous owner must belong to source instance (FED-010)
  if (event.ownership.previousOwner && !verifyAttribution(event.ownership.previousOwner.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in ownership_transfer: previousOwner homeInstance=${extractDomain(event.ownership.previousOwner.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Idempotency: reject replay of a transfer we've already processed. Critical here
  // because a stale replay could otherwise overwrite a newer owner (e.g. A->B then
  // B->A, then A->B arrives again and clobbers). See `processMemberAddEvent`.
  const existingSysMsg = db
    .select({ id: schema.dmMessages.id })
    .from(schema.dmMessages)
    .where(and(
      eq(schema.dmMessages.sourceInstance, sourceInstance),
      eq(schema.dmMessages.sourceMessageId, event.messageId),
    ))
    .get();
  if (existingSysMsg) {
    accepted.push(event.messageId);
    return;
  }

  const channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // Validate authority: only the current owner's instance can transfer ownership.
  //
  // See the matching note in `processMemberRemoveEvent`: `sourceInstance` is
  // always a full URL but `channel.ownerHomeInstance` can be bare or full.
  // Normalize both sides through `normalizeOriginForCompare` so we don't reject
  // legitimate back-and-forth transfers that wrote a bare host into the column.
  if (channel.ownerHomeInstance &&
      normalizeOriginForCompare(sourceInstance) !== normalizeOriginForCompare(channel.ownerHomeInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'unauthorized_source' });
    return;
  }

  // Resolve new owner to local user. If the new owner's identity has been
  // deleted, we cannot complete the transfer — reject so the event can be
  // retried or dropped by the sender.
  const newOwnerLocal = resolveOrCreateReplicatedUser(
    event.ownership.newOwner.homeUserId,
    event.ownership.newOwner.homeInstance,
    db,
    { username: event.ownership.newOwner.profile?.username, status: event.ownership.newOwner.profile?.status },
  );
  if (!newOwnerLocal) {
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  // Canonicalize to a full origin URL on storage so future authority checks
  // can compare cleanly against `sourceInstance` (also a full URL). Mirrors
  // the canonicalization performed in `transferGroupDmOwnership` on the
  // sender side. Falls back to the wire value if normalization yields null
  // (shouldn't happen for valid events; defensive).
  const canonicalOwnerHome =
    canonicalizeHomeInstance(event.ownership.newOwner.homeInstance) ?? event.ownership.newOwner.homeInstance;

  db.update(schema.dmChannels)
    .set({
      ownerId: newOwnerLocal.id,
      ownerHomeUserId: event.ownership.newOwner.homeUserId,
      ownerHomeInstance: canonicalOwnerHome,
    })
    .where(eq(schema.dmChannels.id, channel.id))
    .run();

  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_owner_updated',
    dmChannelId: channel.id,
    newOwnerId: newOwnerLocal.id,
    newOwnerHomeUserId: event.ownership.newOwner.homeUserId,
    newOwnerHomeInstance: canonicalOwnerHome,
  });

  const prevOwnerLocal = event.ownership.previousOwner
    ? resolveLocalUser(event.ownership.previousOwner.homeUserId, db)
    : null;
  const ownerSysMsgId = generateSnowflake();
  const ownerSysCreatedAt = Date.now();
  const newOwnerBaseName = newOwnerLocal?.username?.includes('@') ? newOwnerLocal.username.split('@')[0] : (newOwnerLocal?.username ?? 'Unknown');
  const prevOwnerId = prevOwnerLocal?.id ?? channel.ownerId ?? 'system';
  const ownerSysContent = JSON.stringify({
    event: 'owner_changed',
    newOwnerId: newOwnerLocal.id,
    newOwnerDisplayName: newOwnerLocal.displayName ?? newOwnerBaseName,
  });

  db.insert(schema.dmMessages).values({
    id: ownerSysMsgId,
    dmChannelId: channel.id,
    userId: prevOwnerId,
    content: ownerSysContent,
    type: 'system',
    createdAt: ownerSysCreatedAt,
    sourceInstance,
    sourceMessageId: event.messageId,
  }).run();

  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_message_created',
    message: {
      id: ownerSysMsgId,
      dmChannelId: channel.id,
      userId: prevOwnerId,
      content: ownerSysContent,
      type: 'system',
      createdAt: ownerSysCreatedAt,
      sourceInstance,
      sourceMessageId: event.messageId,
      editedAt: null,
      replyToId: null,
      user: prevOwnerLocal ? sanitizeUser(prevOwnerLocal) : undefined,
      attachments: [],
      embeds: [],
      reactions: [],
    } as unknown as DmMessageWithUser,
  });

  accepted.push(event.messageId);
}

// ─── Friend Event Processors ─────────────────────────────────────────────────

/**
 * Hydrate a replicated user stub with profile data from a relay event.
 * Only updates fields that are currently null/empty on the local row,
 * so manually-set local values are preserved.
 */
export async function hydrateReplicatedUserProfile(
  user: typeof schema.users.$inferSelect,
  profile: FederationRelayProfileSnapshot | undefined,
  db: ReturnType<typeof getDb>,
): Promise<typeof schema.users.$inferSelect> {
  if (!profile) return user;
  if (!user.homeInstance) return user; // Don't update native users

  const baseUrl = user.homeInstance.startsWith('http') ? user.homeInstance : `https://${user.homeInstance}`;
  const buildAbsoluteUrl = (value: string): string => {
    if (value.startsWith('http')) return value;
    const path = value.startsWith('/') ? value : `/api/uploads/${value}`;
    return `${baseUrl}${path}`;
  };

  // Resolve a snapshot asset to a local filename (preferred) or, on download
  // failure, fall back to the absolute URL so the avatar still renders while
  // the home instance is reachable.
  const resolveAsset = async (snapshot: string): Promise<string> => {
    const absoluteUrl = buildAbsoluteUrl(snapshot);
    const localFile = await downloadProfileAsset(absoluteUrl, baseUrl);
    return localFile ?? absoluteUrl;
  };

  const updates: Record<string, string | null> = {};
  // Use displayName from profile, falling back to the home username (without
  // the @domain suffix that the local replicated username carries).  This
  // ensures federated users show a human-readable name instead of the raw
  // "user@instance.example" federation username.
  const effectiveDisplayName = profile.displayName || profile.username || null;
  if (effectiveDisplayName && !user.displayName) updates.displayName = effectiveDisplayName;
  // Hydrate is best-effort: only fill empty fields. Never overwrite existing
  // avatar/banner values — that is exclusively processProfileUpdateEvent's job
  // (which carries a monotonic version). In particular, locally-downloaded
  // bare filenames produced by that path must not be clobbered back to URLs.
  if (profile.avatar && !user.avatar) updates.avatar = await resolveAsset(profile.avatar);
  if (profile.avatarColor) updates.avatarColor = profile.avatarColor;
  if (profile.banner && !user.banner) updates.banner = await resolveAsset(profile.banner);
  if (profile.bio && !user.bio) updates.bio = profile.bio;

  if (Object.keys(updates).length === 0) return user;

  db.update(schema.users)
    .set(updates)
    .where(eq(schema.users.id, user.id))
    .run();

  return { ...user, ...updates };
}

async function processFriendRequestCreateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: sender must belong to source instance (FED-010)
  if (!verifyAttribution(from.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_request_create: from homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Self-target guard (defense-in-depth): from-identity must not equal to-identity.
  // Sender's local cannot_friend_self check should catch this, but the receiver must not trust it.
  if (
    from.homeUserId === to.homeUserId &&
    normalizeOriginForCompare(from.homeInstance) === normalizeOriginForCompare(to.homeInstance)
  ) {
    console.warn(`[federation] Self-target friend_request_create rejected: homeUserId=${from.homeUserId} homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'self_target_invalid' });
    return;
  }

  // Resolve the sender (create stub if needed — they're on a remote instance)
  const fromUserResolved = resolveOrCreateReplicatedUser(from.homeUserId, from.homeInstance, db, { username: event.friendship.fromProfile?.username, status: event.friendship.fromProfile?.status });
  if (!fromUserResolved) {
    // Sender's identity has been deleted — silently accept to drop the event
    accepted.push(event.messageId);
    return;
  }
  let fromUser = await hydrateReplicatedUserProfile(fromUserResolved, event.friendship.fromProfile, db);

  // Resolve the recipient — must be a local user on this instance
  const toUser = resolveLocalUser(to.homeUserId, db);
  if (!toUser) {
    rejected.push({ messageId: event.messageId, reason: 'recipient_not_found' });
    return;
  }

  // Idempotency: if already friends, accept as no-op
  const existingFriend = db
    .select()
    .from(schema.friends)
    .where(
      or(
        and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
        and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
      ),
    )
    .get();

  if (existingFriend) {
    accepted.push(event.messageId);
    return;
  }

  // Idempotency: a pending request in EITHER direction makes this event a no-op.
  //   Forward (from→to): re-delivery of an event we've already processed.
  //   Reverse (to→from): the local user has already sent a request TO this remote sender.
  //     Race window: both sides click "add friend" near-simultaneously. Each sender's both-direction
  //     check passes locally (no rows yet anywhere). When the events cross, each receiver must
  //     treat the reverse-direction collision as idempotent — otherwise both instances end up
  //     with two opposite-direction pending rows for the same logical pair. Mirror the
  //     sender-side both-direction check (`incoming_request_exists` in social.ts).
  const existingRequest = db
    .select()
    .from(schema.friendRequests)
    .where(
      and(
        or(
          and(eq(schema.friendRequests.fromId, fromUser.id), eq(schema.friendRequests.toId, toUser.id)),
          and(eq(schema.friendRequests.fromId, toUser.id), eq(schema.friendRequests.toId, fromUser.id)),
        ),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (existingRequest) {
    accepted.push(event.messageId);
    return;
  }

  // Create the friend request
  const id = generateSnowflake();
  const now = event.friendship.createdAt || Date.now();

  db.insert(schema.friendRequests)
    .values({
      id,
      fromId: fromUser.id,
      toId: toUser.id,
      status: 'pending',
      createdAt: now,
    })
    .run();

  // Broadcast to the recipient
  connectionManager.sendToUser(toUser.id, {
    type: 'friend_request_received',
    request: {
      id,
      fromId: fromUser.id,
      toId: toUser.id,
      status: 'pending' as const,
      createdAt: now,
      user: sanitizeUser(fromUser),
    },
  });

  accepted.push(event.messageId);
}

function processFriendRequestUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.friendship || !event.friendship.status) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to, status } = event.friendship;

  // Attribution: recipient (acceptor/decliner) must belong to source instance (FED-010)
  if (!verifyAttribution(to.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_request_update: to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve the sender — must be a local user (the one who sent the original request)
  const fromUser = resolveLocalUser(from.homeUserId, db);
  if (!fromUser) {
    rejected.push({ messageId: event.messageId, reason: 'sender_not_found' });
    return;
  }

  // Resolve the recipient (create stub if needed — they're on the remote instance)
  const toUser = resolveOrCreateReplicatedUser(to.homeUserId, to.homeInstance, db, { username: event.friendship.toProfile?.username, status: event.friendship.toProfile?.status });
  if (!toUser) {
    // Recipient's identity has been deleted — accept idempotently to drop the event
    accepted.push(event.messageId);
    return;
  }

  // Find the pending request
  const pendingRequest = db
    .select()
    .from(schema.friendRequests)
    .where(
      and(
        eq(schema.friendRequests.fromId, fromUser.id),
        eq(schema.friendRequests.toId, toUser.id),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (!pendingRequest) {
    // Accept idempotently — friend_add may have arrived first
    accepted.push(event.messageId);
    return;
  }

  // Update request status
  db.update(schema.friendRequests)
    .set({ status: status as string })
    .where(eq(schema.friendRequests.id, pendingRequest.id))
    .run();

  if (status === 'accepted') {
    const now = event.friendship.createdAt || Date.now();
    connectionManager.sendToUser(fromUser.id, {
      type: 'friend_request_accepted',
      friend: {
        ...sanitizeUser(toUser),
        addedAt: now,
      },
      requestId: pendingRequest.id,
    });
  } else if (status === 'declined') {
    connectionManager.sendToUser(fromUser.id, {
      type: 'friend_request_declined',
      requestId: pendingRequest.id,
      userId: toUser.id,
    });
  }

  accepted.push(event.messageId);
}

function processFriendRequestCancelEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: sender must belong to source instance (FED-010)
  if (!verifyAttribution(from.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_request_cancel: from homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve both users — must both exist locally for there to be a pending request
  const fromUser = resolveLocalUser(from.homeUserId, db);
  const toUser = resolveLocalUser(to.homeUserId, db);

  if (!fromUser || !toUser) {
    // Accept idempotently — if either user doesn't exist, there's nothing to cancel
    accepted.push(event.messageId);
    return;
  }

  // Find the pending request
  const pendingRequest = db
    .select()
    .from(schema.friendRequests)
    .where(
      and(
        eq(schema.friendRequests.fromId, fromUser.id),
        eq(schema.friendRequests.toId, toUser.id),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (!pendingRequest) {
    // Accept idempotently — already cancelled or never existed
    accepted.push(event.messageId);
    return;
  }

  // Delete the request
  db.delete(schema.friendRequests)
    .where(eq(schema.friendRequests.id, pendingRequest.id))
    .run();

  // Broadcast to the recipient
  connectionManager.sendToUser(toUser.id, {
    type: 'friend_request_cancelled',
    requestId: pendingRequest.id,
    userId: fromUser.id,
  });

  accepted.push(event.messageId);
}

async function processFriendAddEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: acceptor must belong to source instance (FED-010)
  if (!verifyAttribution(to.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_add: to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve both users (create stubs if needed) and hydrate with profile data
  const fromUserResolved = resolveOrCreateReplicatedUser(from.homeUserId, from.homeInstance, db, { username: event.friendship.fromProfile?.username, status: event.friendship.fromProfile?.status });
  if (!fromUserResolved) {
    // One party's identity is deleted — accept idempotently to drop the event
    accepted.push(event.messageId);
    return;
  }
  let fromUser = await hydrateReplicatedUserProfile(fromUserResolved, event.friendship.fromProfile, db);
  const toUserResolved = resolveOrCreateReplicatedUser(to.homeUserId, to.homeInstance, db, { username: event.friendship.toProfile?.username, status: event.friendship.toProfile?.status });
  if (!toUserResolved) {
    accepted.push(event.messageId);
    return;
  }
  let toUser = await hydrateReplicatedUserProfile(toUserResolved, event.friendship.toProfile, db);

  // Idempotency: if friendship already exists, accept as no-op
  const existingFriend = db
    .select()
    .from(schema.friends)
    .where(
      or(
        and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
        and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
      ),
    )
    .get();

  if (existingFriend) {
    accepted.push(event.messageId);
    return;
  }

  // Insert friendship row
  const now = event.friendship.createdAt || Date.now();
  db.insert(schema.friends)
    .values({
      userId: fromUser.id,
      friendId: toUser.id,
      createdAt: now,
    })
    .run();

  // Auto-resolve any pending friend request between these users to 'accepted'
  // (handles friend_add arriving before friend_request_update)
  db.update(schema.friendRequests)
    .set({ status: 'accepted' })
    .where(
      and(
        or(
          and(eq(schema.friendRequests.fromId, fromUser.id), eq(schema.friendRequests.toId, toUser.id)),
          and(eq(schema.friendRequests.fromId, toUser.id), eq(schema.friendRequests.toId, fromUser.id)),
        ),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .run();

  // Determine which user is local and broadcast to them
  const ourOrigin = getOurOrigin();
  const localUser = from.homeInstance === ourOrigin ? fromUser : toUser;
  const remoteUser = from.homeInstance === ourOrigin ? toUser : fromUser;

  connectionManager.sendToUser(localUser.id, {
    type: 'friend_request_accepted',
    friend: {
      ...sanitizeUser(remoteUser),
      addedAt: now,
    },
    // Use empty string for requestId since the request may not exist locally yet
    requestId: '',
  });

  accepted.push(event.messageId);
}

function processFriendRemoveEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: at least one side must belong to source instance (FED-010)
  if (!verifyAttribution(from.homeInstance, sourceInstance) && !verifyAttribution(to.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_remove: from homeInstance=${extractDomain(from.homeInstance)} to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve both users — must both exist locally for there to be a friendship
  const fromUser = resolveLocalUser(from.homeUserId, db);
  const toUser = resolveLocalUser(to.homeUserId, db);

  if (!fromUser || !toUser) {
    // Accept idempotently — if either user doesn't exist locally, nothing to remove
    accepted.push(event.messageId);
    return;
  }

  // Delete friendship in both directions
  db.delete(schema.friends)
    .where(
      or(
        and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
        and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
      ),
    )
    .run();

  // Determine which user is local (the one whose home instance is NOT the source)
  // The removing user is on the source instance; broadcast to the other user
  const ourOrigin = getOurOrigin();
  const localUser = from.homeInstance === ourOrigin ? fromUser : toUser;
  const removingUser = from.homeInstance === ourOrigin ? toUser : fromUser;

  connectionManager.sendToUser(localUser.id, {
    type: 'friend_removed',
    userId: removingUser.id,
  });

  accepted.push(event.messageId);
}

function processFileRejectedEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  // FED-010: file_rejected is a system event from the rejecting peer — no user attribution to verify
  if (!event.attachmentId || !event.rejectionReason) {
    rejected.push({ messageId: event.messageId, reason: 'missing_file_rejected_payload' });
    return;
  }

  // event.messageId is the original local message ID on THIS (sender) instance
  const localMsg = db.select()
    .from(schema.dmMessages)
    .where(eq(schema.dmMessages.id, event.messageId))
    .get();

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'message_not_found' });
    return;
  }

  // Find the attachment — try by sourceUrl matching, then by checking all attachments on the message
  const messageAttachments = db.select()
    .from(schema.attachments)
    .where(eq(schema.attachments.dmMessageId, localMsg.id))
    .all();

  // Match by filename from the sourceUrl — the remote sends the filename portion
  // (e.g., "12345.png") which matches our local attachment's filename.
  let matchedAttachment = event.sourceFilename
    ? messageAttachments.find(a => a.filename === event.sourceFilename)
    : undefined;

  // Fallback: if only one attachment, use it directly
  if (!matchedAttachment && messageAttachments.length === 1) {
    matchedAttachment = messageAttachments[0];
  }

  if (!matchedAttachment) {
    rejected.push({ messageId: event.messageId, reason: 'attachment_not_found' });
    return;
  }

  // Resolve affected user IDs to local usernames
  const affectedUsers: Array<{ userId: string; username: string; limit: number }> = [];
  for (const remoteUserId of (event.affectedUserIds ?? [])) {
    // These are homeUserIds — find the replicated user stub
    const user = db.select()
      .from(schema.users)
      .where(eq(schema.users.homeUserId, remoteUserId))
      .get();
    if (user) {
      affectedUsers.push({
        userId: user.id,
        username: user.displayName || user.username,
        limit: event.rejectionLimit ?? 0,
      });
    }
  }

  if (affectedUsers.length === 0) {
    // Fallback: if we can't resolve usernames, still accept the event
    // but skip the UI update since we can't show meaningful info
    accepted.push(event.messageId);
    return;
  }

  // Merge into federation_meta — accumulate rejections from multiple peers
  let existingMeta: Array<{ userId: string; username: string; limit: number }> = [];
  if (matchedAttachment.federationMeta) {
    try {
      const parsed = JSON.parse(matchedAttachment.federationMeta);
      existingMeta = Array.isArray(parsed) ? parsed : [];
    } catch { /* ignore parse errors */ }
  }

  // Add new affected users, avoiding duplicates by userId
  const existingUserIds = new Set(existingMeta.map(u => u.userId));
  for (const user of affectedUsers) {
    if (!existingUserIds.has(user.userId)) {
      existingMeta.push(user);
    }
  }

  // Update attachment
  db.update(schema.attachments)
    .set({
      federationStatus: 'remote_partial',
      federationMeta: JSON.stringify(existingMeta),
    })
    .where(eq(schema.attachments.id, matchedAttachment.id))
    .run();

  // Broadcast dm_message_updated to all DM members (persistent indicator)
  const updatedMsg = getDmMessageWithUser(localMsg.id);
  if (updatedMsg) {
    connectionManager.sendToDmMembers(updatedMsg.dmChannelId, {
      type: 'dm_message_updated',
      message: updatedMsg,
    });

    // Send targeted toast event to the message author only
    connectionManager.sendToUser(localMsg.userId, {
      type: 'federation_file_rejected',
      messageId: localMsg.id,
      dmChannelId: localMsg.dmChannelId,
      attachmentId: matchedAttachment.id,
      affectedUsers,
    });
  }

  accepted.push(event.messageId);
}

// ─── DM Call Relay Processors ─────────────────────────────────────────────────

function processDmCallStartEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
  undeliverable: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.call?.caller || !event.call.livekitUrl || !event.call.tokens || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_call_payload' });
    return;
  }

  // Attribution: caller must belong to source instance
  if (!verifyAttribution(event.call.caller.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in dm_call_start: caller=${extractDomain(event.call.caller.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Find local DM channel by federatedId
  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  // Resolve caller to local stub
  const callerStub = resolveOrCreateReplicatedUser(
    event.call.caller.homeUserId,
    event.call.caller.homeInstance,
    db,
    { username: event.call.caller.displayName },
  );
  if (!callerStub) {
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  const ringedUserIds: string[] = [];

  if (channel) {
    // ── Path A: DM exists locally ──
    const localDmChannelId = channel.id;

    const localMembers = db.select({
      userId: schema.dmMembers.userId,
      homeUserId: schema.users.homeUserId,
      homeInstance: schema.users.homeInstance,
    })
      .from(schema.dmMembers)
      .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
      .where(eq(schema.dmMembers.dmChannelId, localDmChannelId))
      .all();

    for (const member of localMembers) {
      const homeUserId = member.homeUserId || member.userId;
      // Bug 1 fix: don't ring the caller on this instance
      if (homeUserId === event.call.caller.homeUserId) continue;

      // #18: skip offline members. Entry-vs-no-entry decision uses the same
      // connection-count signal Path B has always used — keeps the two paths
      // symmetric in what counts as "ringed."
      if (connectionManager.getUserConnections(member.userId).size === 0) continue;

      const token = event.call!.tokens![homeUserId];
      connectionManager.sendToUser(member.userId, {
        type: 'dm_call_incoming',
        dmChannelId: localDmChannelId,
        federatedCallId: event.federatedId,
        callerId: callerStub.id,
        callerName: callerStub.displayName ?? callerStub.username,
        livekitUrl: event.call!.livekitUrl,
        livekitToken: token,
        callOrigin: event.call!.caller.homeInstance,
      });
      ringedUserIds.push(member.userId);
    }

    if (ringedUserIds.length === 0) {
      // #18: no local member was reachable. Do not create a FederatedCallEntry
      // (it would strand with no accept/reject path); surface to the caller
      // via undeliverable so it can tear down its ring room instead of hanging.
      undeliverable.push({ messageId: event.messageId, reason: 'no_recipient' });
      return;
    }

    const entry: FederatedCallEntry = {
      dmChannelId: localDmChannelId,
      federatedId: event.federatedId,
      callerId: callerStub.id,
      callerHomeUserId: event.call.caller.homeUserId,
      federatedCallHost: sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`,
      livekitUrl: event.call.livekitUrl,
      tokens: new Map(Object.entries(event.call.tokens)),
      ringedUserIds,
      state: 'ringing',
      startedAt: Date.now(),
    };
    connectionManager.createFederatedCall(entry);

  } else {
    // ── Path B: DM doesn't exist locally — match by participant identity ──
    if (!event.call.participants || !Array.isArray(event.call.participants)) {
      // Old-format relay without participants — backwards-compatible rejection
      rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
      return;
    }

    const ourDomain = extractDomain(getOurOrigin());

    for (const p of event.call.participants) {
      const participantDomain = extractDomain(p.homeInstance);
      // Skip the caller — strict match on BOTH homeUserId AND homeInstance
      if (p.homeUserId === event.call.caller.homeUserId
          && participantDomain === extractDomain(event.call.caller.homeInstance)) {
        continue;
      }

      // Strict identity resolution: homeUserId is only unique within its homeInstance
      const localUser = db.select({ id: schema.users.id, homeUserId: schema.users.homeUserId })
        .from(schema.users)
        .where(
          or(
            // Replicated stub or federated account from the participant's home instance
            and(
              eq(schema.users.homeUserId, p.homeUserId),
              sql`replace(replace(coalesce(${schema.users.homeInstance}, ''), 'https://', ''), 'http://', '') = ${participantDomain}`,
            ),
            // Native user whose ID matches and participant's home matches our domain
            and(
              eq(schema.users.id, p.homeUserId),
              isNull(schema.users.homeInstance),
              sql`${participantDomain} = ${ourDomain}`,
            ),
          ),
        )
        .get();

      if (!localUser) continue;

      // Check if user has an active WS connection
      const connections = connectionManager.getUserConnections(localUser.id);
      if (connections.size === 0) continue;

      const homeUserId = localUser.homeUserId || localUser.id;
      const token = event.call!.tokens![homeUserId];
      if (!token) continue;

      connectionManager.sendToUser(localUser.id, {
        type: 'dm_call_incoming',
        dmChannelId: null,
        federatedCallId: event.federatedId,
        callerId: callerStub.id,
        callerName: callerStub.displayName ?? callerStub.username,
        livekitUrl: event.call!.livekitUrl,
        livekitToken: token,
        callOrigin: event.call!.caller.homeInstance,
      });
      ringedUserIds.push(localUser.id);
    }

    if (ringedUserIds.length === 0) {
      // No recipient reachable — signal to caller via third ack bucket (#18).
      // The remote processed the event cleanly; this is not a data error, but
      // the caller must learn that nobody was rung so it can tear down its
      // local ring room instead of hanging 60s waiting for an accept.
      undeliverable.push({ messageId: event.messageId, reason: 'no_recipient' });
      return;
    }

    const entry: FederatedCallEntry = {
      dmChannelId: null,
      federatedId: event.federatedId,
      callerId: callerStub.id,
      callerHomeUserId: event.call.caller.homeUserId,
      federatedCallHost: sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`,
      livekitUrl: event.call.livekitUrl,
      tokens: new Map(Object.entries(event.call.tokens)),
      ringedUserIds,
      state: 'ringing',
      startedAt: Date.now(),
    };
    connectionManager.createFederatedCall(entry);
  }

  accepted.push(event.messageId);
}

function processDmCallAcceptEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.call?.acceptor || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_call_payload' });
    return;
  }

  if (!verifyAttribution(event.call.acceptor.homeInstance, sourceInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();
  const dmChannelId = channel?.id;

  // Check if we're the HOST (have a VoiceRoom)
  const room = dmChannelId ? connectionManager.getRoom(dmChannelId) : undefined;
  if (room && room.roomType === 'dm') {
    const meta = room.metadata as DmRoomMeta;

    if (meta.state === 'ringing') {
      connectionManager.activateDmRoom(dmChannelId!);

      // Join caller to room
      connectionManager.leaveCurrentRoom(meta.callerId);
      connectionManager.joinRoom(dmChannelId!, meta.callerId);

      connectionManager.sendToDmMembers(dmChannelId!, {
        type: 'voice_state_update',
        channelId: dmChannelId!,
        userId: meta.callerId,
        action: 'join',
      });
    }

    // Broadcast accepted locally — include federatedCallId so all clients can match
    connectionManager.sendToDmMembers(dmChannelId!, {
      type: 'dm_call_accepted',
      dmChannelId: dmChannelId!,
      federatedCallId: event.federatedId,
    } as ServerEvent);

    // Fan out to ALL other remote instances (exclude the one that sent the accept)
    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    const hostCallerId = (room.metadata as DmRoomMeta).callerId;
    const localDmId = dmChannelId!;
    void fanOutCallEvent(localDmId, event.federatedId, 'dm_call_accept', {
      call: { acceptor: event.call.acceptor },
    }, normalizedSource, db).then(failures => {
      emitHostFanoutUndeliverable(hostCallerId, localDmId, event.federatedId!, 'accept', failures);
    }).catch(err =>
      console.error('[federation] Fan-out dm_call_accept threw:', err),
    );
  } else {
    // We're a REMOTE instance receiving fan-out — transition local state
    const fedCall = connectionManager.getFederatedCall(event.federatedId);
    if (fedCall) {
      // Only broadcast if transitioning from ringing → active.
      // If already active (e.g., we initiated the accept and the host is fanning out back),
      // skip the duplicate broadcast to avoid state conflicts on the client.
      const wasRinging = fedCall.state === 'ringing';
      connectionManager.activateFederatedCall(event.federatedId);
      if (wasRinging) {
        connectionManager.sendToFederatedCallUsers(event.federatedId, {
          type: 'dm_call_accepted',
          dmChannelId: fedCall.dmChannelId,
          federatedCallId: event.federatedId,
        } as ServerEvent);
      }
    }
  }

  accepted.push(event.messageId);
}

function processDmCallRejectEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.call?.rejector || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_call_payload' });
    return;
  }

  if (!verifyAttribution(event.call.rejector.homeInstance, sourceInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();
  const dmChannelId = channel?.id;

  const room = dmChannelId ? connectionManager.getRoom(dmChannelId) : undefined;
  if (room && room.roomType === 'dm') {
    const meta = room.metadata as DmRoomMeta;
    const hostCallerId = meta.callerId;
    const localDmId = dmChannelId!;
    connectionManager.clearVoiceWs(meta.callerId);
    connectionManager.destroyRoom(localDmId);

    connectionManager.sendToDmMembers(localDmId, {
      type: 'dm_call_rejected',
      dmChannelId: localDmId,
    });

    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    void fanOutCallEvent(localDmId, event.federatedId, 'dm_call_end', {
      call: { endedBy: event.call.rejector },
    }, normalizedSource, db).then(failures => {
      emitHostFanoutUndeliverable(hostCallerId, localDmId, event.federatedId!, 'reject', failures);
    }).catch(err =>
      console.error('[federation] Fan-out dm_call_end (reject) threw:', err),
    );
  } else {
    const fedCall = connectionManager.getFederatedCall(event.federatedId);
    if (fedCall) {
      connectionManager.sendToFederatedCallUsers(event.federatedId, {
        type: 'dm_call_rejected',
        dmChannelId: fedCall.dmChannelId,
        federatedCallId: event.federatedId,
      } as ServerEvent);
      connectionManager.clearFederatedCall(event.federatedId);
    }
  }

  accepted.push(event.messageId);
}

function processDmCallEndEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.call?.endedBy || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_call_payload' });
    return;
  }

  if (!verifyAttribution(event.call.endedBy.homeInstance, sourceInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();
  const dmChannelId = channel?.id;

  const room = dmChannelId ? connectionManager.getRoom(dmChannelId) : undefined;
  if (room && room.roomType === 'dm') {
    const meta = room.metadata as DmRoomMeta;
    const hostCallerId = meta.callerId;
    const localDmId = dmChannelId!;
    connectionManager.clearVoiceWs(meta.callerId);
    for (const pid of room.participants) {
      connectionManager.clearVoiceUserStatus(pid);
      connectionManager.clearVoiceWs(pid);
    }
    connectionManager.destroyRoom(localDmId);

    connectionManager.sendToDmMembers(localDmId, {
      type: 'dm_call_ended',
      dmChannelId: localDmId,
    });

    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    void fanOutCallEvent(localDmId, event.federatedId, 'dm_call_end', {
      call: { endedBy: event.call.endedBy },
    }, normalizedSource, db).then(failures => {
      emitHostFanoutUndeliverable(hostCallerId, localDmId, event.federatedId!, 'end', failures);
    }).catch(err =>
      console.error('[federation] Fan-out dm_call_end threw:', err),
    );
  } else {
    const fedCall = connectionManager.getFederatedCall(event.federatedId);
    if (fedCall) {
      connectionManager.sendToFederatedCallUsers(event.federatedId, {
        type: 'dm_call_ended',
        dmChannelId: fedCall.dmChannelId,
        federatedCallId: event.federatedId,
      } as ServerEvent);
      connectionManager.clearFederatedCall(event.federatedId);
    }
  }

  accepted.push(event.messageId);
}

function processDmTypingStartEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.typing || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_typing_payload' });
    return;
  }

  // Look up local channel by federatedId
  const channel = db.select()
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    // Channel not bootstrapped yet — discard silently
    accepted.push(event.messageId);
    return;
  }

  // Resolve the typing user (read-only — don't create stubs for ephemeral events)
  const typingUser = resolveLocalUser(event.typing.homeUserId, db);
  if (!typingUser) {
    // User stub doesn't exist — discard silently
    accepted.push(event.messageId);
    return;
  }

  // Broadcast dm_typing to local DM members (excluding the typer)
  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channel.id))
    .all();

  for (const member of dmMembers) {
    if (member.userId !== typingUser.id) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_typing',
        dmChannelId: channel.id,
        userId: typingUser.id,
        username: typingUser.username ?? event.typing.username,
      });
    }
  }

  accepted.push(event.messageId);
}

function processDmTypingStopEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.typing || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_typing_payload' });
    return;
  }

  // Look up local channel by federatedId
  const channel = db.select()
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // Resolve the typing user (read-only)
  const typingUser = resolveLocalUser(event.typing.homeUserId, db);
  if (!typingUser) {
    accepted.push(event.messageId);
    return;
  }

  // Broadcast dm_typing_stop to local DM members
  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channel.id))
    .all();

  for (const member of dmMembers) {
    if (member.userId !== typingUser.id) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_typing_stop',
        dmChannelId: channel.id,
        userId: typingUser.id,
      });
    }
  }

  accepted.push(event.messageId);
}

/**
 * Download a profile image (avatar or banner) from a remote instance.
 * Returns the local filename on success, or null on failure.
 * On failure, the caller stores the absolute URL as a display fallback.
 */
async function downloadProfileAsset(
  url: string,
  sourceInstance: string,
): Promise<string | null> {
  // SSRF: hostname must match the authenticated source instance
  try {
    const urlHostname = new URL(url).hostname;
    const sourceHostname = new URL(sourceInstance).hostname;
    if (urlHostname !== sourceHostname) {
      console.warn(`[federation] Profile asset SSRF blocked: URL hostname "${urlHostname}" != source "${sourceHostname}"`);
      return null;
    }
  } catch {
    return null;
  }

  const ext = path.extname(new URL(url).pathname) || '.webp';
  const localId = generateSnowflake();
  const finalFilename = `${localId}${ext}`;
  const tempFilename = `temp_${localId}${ext}`;
  const tempPath = path.join(config.uploadDir, tempFilename);
  const finalPath = path.join(config.uploadDir, finalFilename);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok || !response.body) {
      return null;
    }

    // Content-type must be an image
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      console.warn(`[federation] Profile asset rejected: non-image content-type "${contentType}" from ${url}`);
      return null;
    }

    // Ensure upload directory exists
    fs.mkdirSync(config.uploadDir, { recursive: true });

    // Stream to temp file
    const nodeStream = Readable.fromWeb(response.body as ReadableStream);
    const writeStream = fs.createWriteStream(tempPath);
    await pipeline(nodeStream, writeStream);

    // Atomic rename
    fs.renameSync(tempPath, finalPath);

    return finalFilename;
  } catch (err) {
    // Clean up temp file on any failure
    try { fs.unlinkSync(tempPath); } catch { /* may not exist */ }
    console.warn(`[federation] Profile asset download failed for ${url}:`, (err as Error).message);
    return null;
  }
}

export async function processProfileUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  const payload = event.profileUpdate;
  if (!payload) {
    rejected.push({ messageId: event.messageId, reason: 'missing_profile_update_payload' });
    return;
  }

  // Strict attribution: profile updates MUST originate from the home instance.
  // No homeward relay exception — unlike DMs, profile updates always come from home.
  const payloadDomain = extractDomain(payload.homeInstance);
  const sourceDomain = extractDomain(sourceInstance);
  if (payloadDomain !== sourceDomain) {
    console.warn(`[federation] Attribution mismatch in profile_update: homeInstance=${payloadDomain} source=${sourceDomain}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Look up the local replicated user by canonical identity
  const localUser = db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.homeUserId, payload.homeUserId),
        eq(schema.users.isDeleted, 0),
      ),
    )
    .get();

  if (!localUser) {
    // This peer has no replica of this user — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Verify the homeInstance domain matches (guard against homeUserId collisions)
  if (localUser.homeInstance && extractDomain(localUser.homeInstance) !== payloadDomain) {
    accepted.push(event.messageId);
    return;
  }

  // Version check: reject stale/duplicate events
  const storedTs = localUser.profileUpdatedAt ?? 0;
  const incomingTs = payload.profileUpdatedAt ?? 0;
  if (incomingTs <= storedTs) {
    accepted.push(event.messageId);
    return;
  }

  // ── Resolve avatar/banner: download locally, fall back to absolute URL ──
  let resolvedAvatar: string | null = payload.avatar ?? null;
  let resolvedBanner: string | null = payload.banner ?? null;

  // Download avatar
  if (resolvedAvatar && resolvedAvatar.startsWith('http')) {
    const localFile = await downloadProfileAsset(resolvedAvatar, sourceInstance);
    resolvedAvatar = localFile ?? resolvedAvatar; // local filename or absolute URL fallback
  } else if (resolvedAvatar && !resolvedAvatar.startsWith('http')) {
    // Bare filename (shouldn't happen) — resolve to absolute URL
    const baseUrl = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    const absoluteUrl = `${baseUrl}/api/uploads/${resolvedAvatar}`;
    const localFile = await downloadProfileAsset(absoluteUrl, sourceInstance);
    resolvedAvatar = localFile ?? absoluteUrl;
  }

  // Download banner
  if (resolvedBanner && resolvedBanner.startsWith('http')) {
    const localFile = await downloadProfileAsset(resolvedBanner, sourceInstance);
    resolvedBanner = localFile ?? resolvedBanner;
  } else if (resolvedBanner && !resolvedBanner.startsWith('http')) {
    const baseUrl = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    const absoluteUrl = `${baseUrl}/api/uploads/${resolvedBanner}`;
    const localFile = await downloadProfileAsset(absoluteUrl, sourceInstance);
    resolvedBanner = localFile ?? absoluteUrl;
  }

  // Clean up old local files being replaced
  const oldAvatar = localUser.avatar;
  const oldBanner = localUser.banner;
  if (oldAvatar && !oldAvatar.startsWith('http') && oldAvatar !== resolvedAvatar) {
    deleteUploadFile(oldAvatar);
  }
  if (oldBanner && !oldBanner.startsWith('http') && oldBanner !== resolvedBanner) {
    deleteUploadFile(oldBanner);
  }

  // Authoritative overwrite — home instance is always right.
  // displayName falls back to the home user's canonical username when null,
  // mirroring hydrateReplicatedUserProfile so stubs whose home user has no
  // displayName show the real handle instead of getting clobbered to null.
  // (The username field on the wire is the home's canonical handle, not the
  // stub's local-part; usernames are immutable on the home instance, so we
  // never rewrite the stub's username column here.)
  const effectiveDisplayName = payload.displayName ?? payload.username ?? null;
  db.update(schema.users)
    .set({
      displayName: effectiveDisplayName,
      avatar: resolvedAvatar,
      banner: resolvedBanner,
      accentColor: payload.accentColor,
      avatarColor: payload.avatarColor,
      bio: payload.bio,
      profileUpdatedAt: payload.profileUpdatedAt,
    })
    .where(eq(schema.users.id, localUser.id))
    .run();

  // Broadcast user_updated to local clients
  const updatedUser = db.select().from(schema.users).where(eq(schema.users.id, localUser.id)).get();
  if (updatedUser) {
    const sanitized = sanitizeUser(updatedUser, false);
    const targetUserIds = collectProfileBroadcastTargetIds(localUser.id);
    targetUserIds.add(localUser.id); // Include self (other tabs/connections)
    const userUpdatedEvent = { type: 'user_updated' as const, user: sanitized };
    for (const uid of targetUserIds) {
      connectionManager.sendToUser(uid, userUpdatedEvent);
    }
  }

  accepted.push(event.messageId);
}

/**
 * Inbound group_metadata_update relay handler.
 *
 * Authority: only the group's owner instance may mutate name/icon. We compare
 * `extractDomain(sourceInstance)` with `extractDomain(channel.ownerHomeInstance)`;
 * any other peer relaying this event is treated as an attribution mismatch
 * (mirrors the strict check in processProfileUpdateEvent).
 *
 * Receiver hardening: never trust the wire payload's bounds — re-validate name
 * length and icon URL scheme. A malicious or buggy peer cannot push us past
 * the same constraints we enforce in PATCH /api/dm/:id.
 *
 * Side-effects on success:
 *   1. dm_channels.{name,icon,metadataUpdatedAt} updated in a single tx.
 *   2. One or two `dm_messages` system rows inserted (name_changed / icon_changed),
 *      each tagged with `(sourceInstance, sourceMessageId)` using the dedup-suffix
 *      scheme `${event.messageId}:name` / `${event.messageId}:icon`. This mirrors
 *      processMemberAddEvent's idempotency contract — a retry of the same wire
 *      event must not insert a second row.
 *   3. dm_channel_updated WS broadcast to local members.
 *   4. dm_message_created WS broadcast for each new system message.
 *   5. Old local icon file is unlinked from disk if it changed away from a local
 *      filename (same precedent as the local PATCH endpoint).
 */
export async function processGroupMetadataUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_federated_id' });
    return;
  }

  // Lookup channel by federated_id. Missing → idempotent accept (this peer has
  // no replica of the channel, nothing to update).
  const channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // Authority: only the owner's home instance can mutate group metadata.
  if (extractDomain(sourceInstance) !== extractDomain(channel.ownerHomeInstance ?? '')) {
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Receiver hardening — payload validation. Don't trust remote peers to
  // respect our bounds; a peer bug or malicious actor must not be able to
  // push values our local PATCH endpoint would have rejected.
  const metadata = event.metadata;
  if (!metadata) {
    rejected.push({ messageId: event.messageId, reason: 'missing_metadata_payload' });
    return;
  }

  if (metadata.name !== null) {
    const trimmedLength = metadata.name.trim().length;
    if (trimmedLength < GROUP_DM_NAME_MIN_LENGTH || trimmedLength > GROUP_DM_NAME_MAX_LENGTH) {
      rejected.push({ messageId: event.messageId, reason: 'invalid_payload' });
      return;
    }
  }

  if (metadata.icon !== null && !(metadata.icon.startsWith('http://') || metadata.icon.startsWith('https://'))) {
    rejected.push({ messageId: event.messageId, reason: 'invalid_payload' });
    return;
  }

  // Version check: stale or duplicate timestamp → silent accept.
  if (metadata.metadataUpdatedAt <= (channel.metadataUpdatedAt ?? 0)) {
    accepted.push(event.messageId);
    return;
  }

  // Diff against stored row — if neither field actually changed, no-op.
  const nameChanged = metadata.name !== channel.name;
  const iconChanged = metadata.icon !== channel.icon;
  if (!nameChanged && !iconChanged) {
    accepted.push(event.messageId);
    return;
  }

  // Idempotency pre-check: if either system message already exists under
  // `(sourceInstance, sourceMessageId)`, this event was already processed.
  // Mirrors processMemberAddEvent's dedup contract — outbox retries and
  // initial-sync replay must not double-insert.
  const nameMessageId = `${event.messageId}:name`;
  const iconMessageId = `${event.messageId}:icon`;
  const existingNameRow = nameChanged
    ? db
      .select({ id: schema.dmMessages.id })
      .from(schema.dmMessages)
      .where(and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, nameMessageId),
      ))
      .get()
    : null;
  const existingIconRow = iconChanged
    ? db
      .select({ id: schema.dmMessages.id })
      .from(schema.dmMessages)
      .where(and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, iconMessageId),
      ))
      .get()
    : null;
  // If every changed field already has its corresponding system row, the
  // entire event has been applied — accept silently.
  if (
    (!nameChanged || existingNameRow)
    && (!iconChanged || existingIconRow)
  ) {
    accepted.push(event.messageId);
    return;
  }

  // ── Resolve icon: download to local upload dir, fall back to absolute URL ──
  let resolvedIcon: string | null = metadata.icon;
  if (iconChanged && metadata.icon !== null) {
    const localFile = await downloadProfileAsset(metadata.icon, sourceInstance);
    resolvedIcon = localFile ?? metadata.icon;
  }

  // Resolve actor → local user id for the system-message foreign key.
  // Falls back to channel.ownerId if the actor stub can't be created (e.g.
  // tombstoned identity); the system message still has to render somewhere.
  const actorParticipant = metadata.actor;
  let actorUserId: string | null = null;
  if (actorParticipant) {
    const actorUser = resolveOrCreateReplicatedUser(
      actorParticipant.homeUserId,
      actorParticipant.homeInstance,
      db,
      { username: actorParticipant.profile?.username, status: actorParticipant.profile?.status },
    );
    actorUserId = actorUser?.id ?? null;
  }
  if (!actorUserId) {
    actorUserId = channel.ownerId;
  }
  if (!actorUserId) {
    // No owner user row to attach a system message to — extremely unusual,
    // bail out cleanly without persisting anything.
    rejected.push({ messageId: event.messageId, reason: 'actor_not_found' });
    return;
  }

  const oldName = channel.name;
  const oldIcon = channel.icon;

  type SystemMessageRow = { id: string; sourceMessageId: string; content: string; createdAt: number };
  const sysMessageRows: SystemMessageRow[] = [];

  // Single transaction: channel update + system message insert(s).
  db.transaction((tx) => {
    tx.update(schema.dmChannels)
      .set({
        name: metadata.name,
        icon: resolvedIcon,
        metadataUpdatedAt: metadata.metadataUpdatedAt,
      })
      .where(eq(schema.dmChannels.id, channel.id))
      .run();

    if (nameChanged && !existingNameRow) {
      const sysId = generateSnowflake();
      const content = JSON.stringify({ event: 'name_changed', oldName, newName: metadata.name });
      tx.insert(schema.dmMessages).values({
        id: sysId,
        dmChannelId: channel.id,
        userId: actorUserId,
        content,
        type: 'system',
        sourceInstance,
        sourceMessageId: nameMessageId,
        createdAt: metadata.metadataUpdatedAt,
      }).run();
      sysMessageRows.push({
        id: sysId,
        sourceMessageId: nameMessageId,
        content,
        createdAt: metadata.metadataUpdatedAt,
      });
    }

    if (iconChanged && !existingIconRow) {
      const sysId = generateSnowflake();
      const content = JSON.stringify({ event: 'icon_changed' });
      tx.insert(schema.dmMessages).values({
        id: sysId,
        dmChannelId: channel.id,
        userId: actorUserId,
        content,
        type: 'system',
        sourceInstance,
        sourceMessageId: iconMessageId,
        createdAt: metadata.metadataUpdatedAt,
      }).run();
      sysMessageRows.push({
        id: sysId,
        sourceMessageId: iconMessageId,
        content,
        createdAt: metadata.metadataUpdatedAt,
      });
    }
  });

  // ── Broadcast channel update to local members ──
  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_channel_updated',
    dmChannelId: channel.id,
    name: metadata.name,
    icon: resolvedIcon,
  });

  // ── Broadcast each new system message ──
  const actorRow = db.select().from(schema.users).where(eq(schema.users.id, actorUserId)).get();
  const sanitizedActor = actorRow ? sanitizeUser(actorRow) : undefined;
  for (const sys of sysMessageRows) {
    connectionManager.sendToDmMembers(channel.id, {
      type: 'dm_message_created',
      message: {
        id: sys.id,
        dmChannelId: channel.id,
        userId: actorUserId,
        content: sys.content,
        type: 'system',
        createdAt: sys.createdAt,
        sourceInstance,
        sourceMessageId: sys.sourceMessageId,
        editedAt: null,
        replyToId: null,
        user: sanitizedActor,
        attachments: [],
        embeds: [],
        reactions: [],
      } as DmMessageWithUser,
    });
  }

  // ── Cleanup old local icon file ──
  // Mirrors the local PATCH precedent (dm.ts:1595): only unlink when the
  // previous icon was a bare local filename (i.e. we own the file on disk).
  // Absolute URLs point at remote files we never owned.
  if (iconChanged && oldIcon && !oldIcon.startsWith('http://') && !oldIcon.startsWith('https://') && oldIcon !== resolvedIcon) {
    deleteUploadFile(oldIcon);
  }

  accepted.push(event.messageId);
}

/**
 * Inbound presence_update relay handler.
 *
 * Authority: home instance is exclusive. payload.homeInstance domain MUST equal
 * the source peer's domain (attribution check, mirrors profile_update).
 *
 * Effect on success:
 *   1. Update the local stub's status column.
 *   2. Broadcast a WS presence_update to local users via collectProfileBroadcastTargetIds
 *      (friends + DM members + space co-members), so the green dot updates without a
 *      page refresh on every connected client that knows this user.
 *
 * Edge cases:
 *   - No local replica → silently accept (peer broadcasts presence to all peers,
 *     not all peers have a stub).
 *   - homeInstance domain mismatch on the existing stub → ignore (collision against
 *     a stub of a different identity).
 *   - Invalid status string → reject; sender is buggy, surface for diagnosis.
 */
export function processPresenceUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  const payload = event.presenceUpdate;
  if (!payload) {
    rejected.push({ messageId: event.messageId, reason: 'missing_presence_update_payload' });
    return;
  }

  const payloadDomain = extractDomain(payload.homeInstance);
  const sourceDomain = extractDomain(sourceInstance);
  if (payloadDomain !== sourceDomain) {
    console.warn(`[federation] Attribution mismatch in presence_update: homeInstance=${payloadDomain} source=${sourceDomain}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  if (!payload.status || !['online', 'idle', 'dnd', 'offline'].includes(payload.status)) {
    rejected.push({ messageId: event.messageId, reason: 'invalid_status' });
    return;
  }

  const localUser = db
    .select()
    .from(schema.users)
    .where(and(
      eq(schema.users.homeUserId, payload.homeUserId),
      eq(schema.users.isDeleted, 0),
    ))
    .get();

  if (!localUser) {
    accepted.push(event.messageId);
    return;
  }

  if (localUser.homeInstance && extractDomain(localUser.homeInstance) !== payloadDomain) {
    accepted.push(event.messageId);
    return;
  }

  db.update(schema.users)
    .set({ status: payload.status })
    .where(eq(schema.users.id, localUser.id))
    .run();

  // Broadcast presence_update WS event to local users who care.
  const targetUserIds = collectProfileBroadcastTargetIds(localUser.id);
  const wsPayload = {
    type: 'presence_update' as const,
    userId: localUser.id,
    status: payload.status,
    ...(payload.activities && payload.activities.length > 0 ? { activities: payload.activities } : {}),
  };
  for (const uid of targetUserIds) {
    connectionManager.sendToUser(uid, wsPayload);
  }

  accepted.push(event.messageId);
}

// ─── Replicated Profile Asset Backfill ──────────────────────────────────────

/**
 * One-time / idempotent pass that converts existing absolute-URL avatars and
 * banners on replicated users into local files via downloadProfileAsset.
 *
 * Why: hydrateReplicatedUserProfile historically wrote home-instance URLs into
 * users.avatar / users.banner. When the home instance is offline those URLs
 * 404, leaving sidebars (server activity, friend activity, DM list) showing
 * letter fallbacks. processProfileUpdateEvent only re-downloads on the next
 * profile edit, which most users don't do — so this worker cleans up the
 * accumulated URL rows.
 *
 * Behavior: best-effort. Rows where the home instance can't be reached are
 * left as URLs (they still render while the peer is up), and the worker is
 * safe to re-run on every startup.
 */
export async function backfillReplicatedProfileAssets(): Promise<void> {
  const db = getDb();
  const rows = db
    .select({
      id: schema.users.id,
      homeInstance: schema.users.homeInstance,
      avatar: schema.users.avatar,
      banner: schema.users.banner,
    })
    .from(schema.users)
    .where(
      and(
        sql`${schema.users.homeInstance} IS NOT NULL`,
        eq(schema.users.isDeleted, 0),
        or(
          sql`${schema.users.avatar} LIKE 'http%'`,
          sql`${schema.users.banner} LIKE 'http%'`,
        ),
      ),
    )
    .all();

  if (rows.length === 0) return;

  let avatarOk = 0;
  let bannerOk = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.homeInstance) continue;
    const baseUrl = row.homeInstance.startsWith('http')
      ? row.homeInstance
      : `https://${row.homeInstance}`;

    const updates: Record<string, string | null> = {};

    if (row.avatar && row.avatar.startsWith('http')) {
      const localFile = await downloadProfileAsset(row.avatar, baseUrl);
      if (localFile) {
        updates.avatar = localFile;
        avatarOk++;
      } else {
        skipped++;
      }
    }

    if (row.banner && row.banner.startsWith('http')) {
      const localFile = await downloadProfileAsset(row.banner, baseUrl);
      if (localFile) {
        updates.banner = localFile;
        bannerOk++;
      } else {
        skipped++;
      }
    }

    if (Object.keys(updates).length > 0) {
      db.update(schema.users)
        .set(updates)
        .where(eq(schema.users.id, row.id))
        .run();
    }
  }

  console.log(
    `[federation] Replicated profile asset backfill: ${avatarOk} avatars, ${bannerOk} banners downloaded; ${skipped} unreachable (will retry next start)`,
  );
}

function processReadStateUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.readState) {
    rejected.push({ messageId: event.messageId, reason: 'missing_read_state_payload' });
    return;
  }

  // Find the local DM channel by federatedId
  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
    return;
  }

  // Resolve the user locally
  const localUser = resolveLocalUser(event.readState.user.homeUserId, db);
  if (!localUser) {
    rejected.push({ messageId: event.messageId, reason: 'user_not_found' });
    return;
  }

  // Translate messageRef to a local message ID
  const { sourceInstance: refSource, sourceMessageId: refId } = event.readState.messageRef;
  let localMessageId: string;

  const ourOrigin = getOurOrigin();
  if (extractDomain(refSource) === extractDomain(ourOrigin)) {
    // The message originated on this instance — refId IS our local ID
    localMessageId = refId;
  } else {
    // Look up the relayed copy by source coordinates
    const localMsg = db.select({ id: schema.dmMessages.id })
      .from(schema.dmMessages)
      .where(and(
        eq(schema.dmMessages.sourceInstance, refSource),
        eq(schema.dmMessages.sourceMessageId, refId),
      ))
      .get();

    if (!localMsg) {
      // Message relay hasn't arrived yet — silently discard
      accepted.push(event.messageId);
      return;
    }
    localMessageId = localMsg.id;
  }

  // Write/update read state using timestamp-only LWW
  const existing = db.select()
    .from(schema.readStates)
    .where(and(
      eq(schema.readStates.userId, localUser.id),
      eq(schema.readStates.channelId, channel.id),
    ))
    .get();

  if (existing) {
    if (event.timestamp > existing.updatedAt) {
      db.update(schema.readStates)
        .set({ lastReadMessageId: localMessageId, updatedAt: event.timestamp })
        .where(and(
          eq(schema.readStates.userId, localUser.id),
          eq(schema.readStates.channelId, channel.id),
        ))
        .run();
    }
  } else {
    db.insert(schema.readStates).values({
      userId: localUser.id,
      channelId: channel.id,
      lastReadMessageId: localMessageId,
      updatedAt: event.timestamp,
    }).run();
  }

  // Echo channel_ack to the user's local WebSocket connections (multi-tab sync)
  connectionManager.sendToUser(localUser.id, {
    type: 'channel_ack',
    channelId: channel.id,
    messageId: localMessageId,
  });

  accepted.push(event.messageId);
}

function processDmCloseEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.dmCloseReopen) {
    rejected.push({ messageId: event.messageId, reason: 'missing_dm_close_payload' });
    return;
  }

  // Find the local DM channel by federatedId
  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    // Channel doesn't exist locally — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Resolve the user locally
  const localUser = resolveLocalUser(event.dmCloseReopen.homeUserId, db);
  if (!localUser) {
    // User not found locally — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Verify user is a DM member
  const membership = db.select()
    .from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .get();

  if (!membership) {
    // Not a member — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Set closed = 1
  db.update(schema.dmMembers)
    .set({ closed: 1 })
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .run();

  // Broadcast dm_channel_closed to local connections of this user
  connectionManager.sendToUser(localUser.id, {
    type: 'dm_channel_closed',
    dmChannelId: channel.id,
  });

  accepted.push(event.messageId);
}

function processDmReopenEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.dmCloseReopen) {
    rejected.push({ messageId: event.messageId, reason: 'missing_dm_reopen_payload' });
    return;
  }

  // Find the local DM channel by federatedId
  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    // Channel doesn't exist locally — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Resolve the user locally
  const localUser = resolveLocalUser(event.dmCloseReopen.homeUserId, db);
  if (!localUser) {
    // User not found locally — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Verify user is a DM member
  const membership = db.select()
    .from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .get();

  if (!membership) {
    // Not a member — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Set closed = 0
  db.update(schema.dmMembers)
    .set({ closed: 0 })
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .run();

  // Build full DM channel payload and broadcast dm_channel_created
  const payload = buildDmChannelPayload(channel.id, db);
  if (payload) {
    connectionManager.sendToUser(localUser.id, {
      type: 'dm_channel_created',
      dmChannel: payload,
    });
  }

  accepted.push(event.messageId);
}

/**
 * Fan out a call event to all remote instances with DM members,
 * optionally excluding the instance that triggered the event.
 */
async function fanOutCallEvent(
  dmChannelId: string,
  federatedId: string,
  eventType: 'dm_call_accept' | 'dm_call_reject' | 'dm_call_end',
  extraFields: Partial<FederationRelayEvent>,
  excludeOrigin: string | undefined,
  db: ReturnType<typeof getDb>,
): Promise<CallFanoutFailure[]> {
  const members = db.select({ homeInstance: schema.users.homeInstance })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  const ourOrigin = getOurOrigin();
  const targets = new Set<string>();
  for (const m of members) {
    if (m.homeInstance) {
      const normalized = m.homeInstance.startsWith('http') ? m.homeInstance : `https://${m.homeInstance}`;
      if (normalized !== ourOrigin && normalized !== excludeOrigin) {
        targets.add(normalized);
      }
    }
  }
  if (targets.size === 0) return [];

  const relayEvent: FederationRelayEvent = {
    eventType,
    messageId: generateSnowflake(),
    encryptionVersion: 0,
    timestamp: Date.now(),
    federatedId,
    ...extraFields,
  } as FederationRelayEvent;

  const labelByOrigin = new Map<string, string | null>();
  for (const r of db.select({ origin: schema.federationPeers.origin, instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .all()) {
    labelByOrigin.set(r.origin, r.instanceName ?? null);
  }

  const results = await Promise.all(
    Array.from(targets).map(async origin => ({ origin, result: await sendCallRelay(origin, [relayEvent]) })),
  );

  const failures: CallFanoutFailure[] = [];
  for (const { origin, result } of results) {
    if (!result.ok) {
      console.error(`[federation] Fan-out ${eventType} to ${origin} failed (${result.reason}): ${result.error}`);
      failures.push({
        origin,
        peerLabel: labelByOrigin.get(origin) ?? undefined,
        reason: mapCallReasonToEventReason(result.reason),
      });
    }
  }
  return failures;
}

/** Emit a non-terminal dm_call_undeliverable for a host-side fan-out failure. */
function emitHostFanoutUndeliverable(
  userId: string,
  dmChannelId: string,
  federatedId: string,
  phase: 'accept' | 'reject' | 'end',
  fanoutFailures: CallFanoutFailure[],
): void {
  if (fanoutFailures.length === 0) return;
  const failures: DmCallUndeliverableFailure[] = fanoutFailures.map(f => ({
    reason: f.reason,
    peerOrigin: f.origin,
    peerLabel: f.peerLabel,
  }));
  connectionManager.sendToUser(userId, {
    type: 'dm_call_undeliverable',
    dmChannelId,
    federatedCallId: federatedId,
    terminal: false,
    phase,
    failures,
  });
}
