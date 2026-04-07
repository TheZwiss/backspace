import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { eq, and, or, isNull, inArray, sql } from 'drizzle-orm';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { generateHmacSecret, getOurOrigin, parseFederationHeaders, verifySignature, verifyPeerSignature, buildFederationHeaders } from '../utils/federationAuth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { getDb, getRawDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { connectionManager } from '../ws/handler.js';
import type { FederatedCallEntry, DmRoomMeta } from '../ws/handler.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { deleteAttachmentFiles } from '../utils/fileCleanup.js';
import { tombstoneUser, collectDeletionBroadcastTargets, collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';
import { computeFederatedId, getDmParticipants, sendCallRelay } from '../utils/federationOutbox.js';
import { getDmMessageWithUser } from './dm.js';
import type { FederationRelayRequest, FederationRelayResponse, FederationRelayEvent, FederationRelayAttachment, FederationSyncRequest, FederationSyncResponse, DmMessageWithUser, FederationRelayProfileSnapshot, FederationIdentityDeleteS2SRequest, FederationProfileUpdatePayload } from '@backspace/shared';

/** Fields safe to expose to admin callers (everything except hmacSecret). */
interface SanitizedPeer {
  id: string;
  origin: string;
  instanceName: string | null;
  status: string;
  lastSeenAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number | null;
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
function validateOrigin(raw: string): string | null {
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
          }),
          signal: AbortSignal.timeout(10_000),
        });

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

        // Remote accepted — activate the peer
        db.update(schema.federationPeers)
          .set({ status: 'active', lastSeenAt: Date.now() })
          .where(eq(schema.federationPeers.id, peerId))
          .run();

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
  app.post<{ Body: { sourceOrigin: string; challenge?: string; hmacSecret: string } }>(
    '/api/federation/peer/accept',
    async (request, reply) => {
      const clientIp = request.ip;
      if (isAcceptRateLimited(clientIp)) {
        return reply.code(429).send({
          error: 'Too many peering requests — try again later',
          statusCode: 429,
        });
      }

      const { sourceOrigin: rawOrigin, hmacSecret } = request.body ?? {};

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

      // Check if peer already exists
      const existing = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, sourceOrigin))
        .get();

      if (existing) {
        if (existing.status === 'active') {
          // Idempotent — already peered
          return reply.code(200).send({ accepted: true });
        }
        if (existing.status === 'revoked') {
          return reply.code(403).send({
            error: 'Peering with this instance has been revoked',
            statusCode: 403,
          });
        }
        // Pending — update with new secret and activate
        db.update(schema.federationPeers)
          .set({
            hmacSecret,
            status: 'active',
            lastSeenAt: Date.now(),
          })
          .where(eq(schema.federationPeers.id, existing.id))
          .run();

        return reply.code(200).send({ accepted: true });
      }

      // New peer — create and activate
      const peerId = generateSnowflake();
      db.insert(schema.federationPeers).values({
        id: peerId,
        origin: sourceOrigin,
        hmacSecret,
        status: 'active',
        lastSeenAt: Date.now(),
        createdAt: Date.now(),
      }).run();

      return reply.code(200).send({ accepted: true });
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

      // Delete all outbox entries for this peer
      db.delete(schema.federationOutbox)
        .where(eq(schema.federationOutbox.peerId, id))
        .run();

      return reply.code(200).send({ success: true });
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
      const { accepted, rejected } = processRelayEvents(body.events, sourceInstance, peer.origin, db);

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
      };

      return reply.code(200).send(response);
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
        ? body.contextType as 'dm' | 'friend'
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

      if (contextTypeFilter === 'friend') {
        // ── Friend event sync: no DM channel logic needed ──
        mutationRows = rawDb.prepare(`
          SELECT id, entity_id, context_id, context_type, mutation_type, mutated_at, payload
          FROM federation_mutation_log
          WHERE context_type = 'friend' AND mutated_at > ?
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
          SELECT id as dm_channel_id FROM dm_channels
          WHERE federated_id IS NOT NULL AND deleted_at IS NULL
        `).all() as Array<{ dm_channel_id: string }>;

        const sharedChannelIds = sharedChannelRows.map(r => r.dm_channel_id);

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
        //    This includes messages by replicated users (e.g., Jannis browsing orbit)
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
              AND (dm.id IS NOT NULL OR ml.mutation_type IN ('delete', 'member_add', 'member_remove', 'ownership_transfer'))
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
              AND (dm.id IS NOT NULL OR ml.mutation_type IN ('delete', 'member_add', 'member_remove', 'ownership_transfer'))
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
          | 'friend_add' | 'friend_remove';

        if (['member_add', 'member_remove', 'ownership_transfer',
             'friend_request_create', 'friend_request_update', 'friend_request_cancel',
             'friend_add', 'friend_remove'].includes(mutationType)) {
          // Membership and friend mutations store the full event in the payload
          const payload = mutation.payload ? JSON.parse(mutation.payload) : {};
          events.push({
            eventType: mutationType as FederationRelayEvent['eventType'],
            contextType: (mutation.context_type ?? 'dm') as 'dm' | 'friend',
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
          thumbnailFilename: a.thumbnailFilename ?? undefined,
          sourceUrl: `${localOrigin}/api/uploads/${a.filename}`,
        }));

        events.push({
          eventType: mutationType,
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
export function processRelayEvents(
  events: FederationRelayEvent[],
  sourceInstance: string,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
): { accepted: string[]; rejected: Array<{ messageId: string; reason: string }> } {
  const accepted: string[] = [];
  const rejected: Array<{ messageId: string; reason: string }> = [];

  for (const event of events) {
    try {
      switch (event.eventType) {
        case 'create':
          processCreateEvent(event, sourceInstance, peerOrigin, db, accepted, rejected);
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
          processMemberAddEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'member_remove':
          processMemberRemoveEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'ownership_transfer':
          processOwnershipTransferEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_request_create':
          processFriendRequestCreateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_request_update':
          processFriendRequestUpdateEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_request_cancel':
          processFriendRequestCancelEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_add':
          processFriendAddEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'friend_remove':
          processFriendRemoveEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'file_rejected':
          processFileRejectedEvent(event, sourceInstance, db, accepted, rejected);
          break;
        case 'dm_call_start':
          processDmCallStartEvent(event, sourceInstance, db, accepted, rejected);
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
          processProfileUpdateEvent(event, sourceInstance, db, accepted, rejected);
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

  return { accepted, rejected };
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
 *    user (e.g., youruser@nova logged into orbit) sends a message on a remote server, and the
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
  hints?: { username?: string | null },
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

  // Use the snowflake-style homeUserId as the local part; append the
  // domain so the username is globally unique and human-readable.
  const baseUsername = `${homeUserId}@${domain}`.toLowerCase();

  // Guard against the (unlikely) case where this username already
  // exists — e.g. a prior partial replication or manual creation.
  let username = baseUsername;
  let collision = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  let attempt = 0;
  while (collision) {
    attempt++;
    username = `${homeUserId}_${attempt}@${domain}`.toLowerCase();
    collision = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    if (attempt > 10) {
      // Extremely unlikely; use a random suffix to break out
      username = `${homeUserId}_${randomBytes(4).toString('hex')}@${domain}`.toLowerCase();
      break;
    }
  }

  const userId = generateSnowflake();
  const now = Date.now();

  db.insert(schema.users).values({
    id: userId,
    username,
    displayName: null,
    passwordHash: '!federation-replicated',  // Cannot be used to log in (bcrypt never produces this)
    status: 'offline',
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

function processCreateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
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
    let localUser = resolveOrCreateReplicatedUser(p.homeUserId, p.homeInstance, db, { username: p.profile?.username });
    // Skip deleted identities — don't include tombstoned users in the DM
    if (!localUser) continue;
    // Hydrate with profile data from the relay event (displayName, avatar, etc.)
    if (p.profile) {
      localUser = hydrateReplicatedUserProfile(localUser, p.profile, db);
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
      const memberUser = db.select()
        .from(schema.users)
        .where(eq(schema.users.id, member.userId))
        .get();

      // Skip members whose home instance is the source — they already have this message
      const memberHome = memberUser?.homeInstance?.startsWith('http') ? memberUser.homeInstance : `https://${memberUser?.homeInstance}`;
      if (memberHome === sourceInstance) continue;

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

function processMemberAddEvent(
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
      const ownerLocal = resolveOrCreateReplicatedUser(event.group.owner.homeUserId, event.group.owner.homeInstance, db, { username: event.group.owner.profile?.username });
      ownerId = ownerLocal?.id ?? null;
    }

    db.insert(schema.dmChannels)
      .values({
        id: channelId,
        federatedId: event.federatedId,
        ownerId,
        ownerHomeUserId: event.group.owner?.homeUserId ?? null,
        ownerHomeInstance: event.group.owner?.homeInstance ?? null,
        createdAt: now,
      })
      .run();

    // Add all roster members — create replicated user stubs for any
    // participants from remote instances that haven't been seen before.
    for (const member of event.group.members) {
      const localUser = resolveOrCreateReplicatedUser(member.homeUserId, member.homeInstance, db, { username: member.profile?.username });
      // Skip deleted identities — tombstoned users can't be added to a DM
      if (!localUser) continue;
      const existing = db.select().from(schema.dmMembers)
        .where(and(
          eq(schema.dmMembers.dmChannelId, channelId),
          eq(schema.dmMembers.userId, localUser.id),
        )).get();
      if (!existing) {
        db.insert(schema.dmMembers).values({
          dmChannelId: channelId,
          userId: localUser.id,
          closed: 0,
        }).run();
      }
    }

    channel = db.select().from(schema.dmChannels)
      .where(eq(schema.dmChannels.id, channelId)).get();

    console.log(`[federation] Bootstrapped group DM channel ${channelId} (federated_id: ${event.federatedId})`);

    bootstrapped = true;

    // Build full DmChannel response for dm_channel_created
    const memberRows = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, channelId))
      .all();
    const memberUserIds = memberRows.map(m => m.userId);
    const memberUsers = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const bootstrapResult = {
      id: channelId,
      ownerId,
      createdAt: now,
      members: memberUsers.map(u => sanitizeUser(u)),
      lastMessage: null,
    };

    // Send dm_channel_created only to members whose home is THIS instance.
    // Remote replicas will get the channel from their own home instance's
    // federation bootstrap — prevents duplicate channels in their sidebar.
    const bootstrapOrigin = getOurOrigin();
    for (const mu of memberUsers) {
      const muHome = mu.homeInstance
        ? (mu.homeInstance.startsWith('http') ? mu.homeInstance : `https://${mu.homeInstance}`)
        : bootstrapOrigin;  // null homeInstance = native local user
      if (muHome !== bootstrapOrigin) continue;
      connectionManager.sendToUser(mu.id, {
        type: 'dm_channel_created',
        dmChannel: bootstrapResult,
      });
    }
  }

  if (!channel) {
    rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
    return;
  }

  // Validate authority: only the owner's instance can add members
  if (channel.ownerHomeInstance && sourceInstance !== channel.ownerHomeInstance) {
    rejected.push({ messageId: event.messageId, reason: 'unauthorized_source' });
    return;
  }

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
    { username: event.membership.user.profile?.username },
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

  if (!bootstrapped) {
    // Insert system message for member addition
    const actorUser = event.membership.addedBy
      ? resolveOrCreateReplicatedUser(event.membership.addedBy.homeUserId, event.membership.addedBy.homeInstance, db, { username: event.membership.addedBy.profile?.username })
      : null;
    const actorId = actorUser?.id ?? localUser.id;

    const addSysMsgId = generateSnowflake();
    const addBaseName = localUser.username?.includes('@') ? localUser.username.split('@')[0] : (localUser.username ?? 'Unknown');
    db.insert(schema.dmMessages).values({
      id: addSysMsgId,
      dmChannelId: channel.id,
      userId: actorId,
      content: JSON.stringify({
        event: 'member_added',
        targetUserId: localUser.id,
        targetDisplayName: localUser.displayName ?? addBaseName,
      }),
      type: 'system',
      createdAt: Date.now(),
    }).run();

    connectionManager.sendToDmMembers(channel.id, {
      type: 'dm_message_created',
      message: {
        id: addSysMsgId,
        dmChannelId: channel.id,
        userId: actorId,
        content: JSON.stringify({
          event: 'member_added',
          targetUserId: localUser.id,
          targetDisplayName: localUser.displayName ?? addBaseName,
        }),
        type: 'system',
        createdAt: Date.now(),
        user: actorUser ? sanitizeUser(actorUser) : sanitizeUser(localUser),
        attachments: [],
        embeds: [],
        reactions: [],
      } as any,
    });

    // Broadcast to local WebSocket clients
    connectionManager.sendToDmMembers(channel.id, {
      type: 'dm_member_added',
      dmChannelId: channel.id,
      user: sanitizeUser(localUser),
    });
  }

  accepted.push(event.messageId);
}

function processMemberRemoveEvent(
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

  const channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // Validate authority: owner's instance for kicks, any instance for self-leave
  if (event.membership.reason !== 'leave' && channel.ownerHomeInstance && sourceInstance !== channel.ownerHomeInstance) {
    rejected.push({ messageId: event.messageId, reason: 'unauthorized_source' });
    return;
  }

  const localUser = resolveLocalUser(event.membership.user.homeUserId, db);
  if (!localUser) {
    accepted.push(event.messageId);
    return;
  }

  // Insert system message for member leaving (before deletion)
  const leaveBaseName = localUser.username?.includes('@') ? localUser.username.split('@')[0] : (localUser.username ?? 'Unknown');
  const leaveSysMsgId = generateSnowflake();
  db.insert(schema.dmMessages).values({
    id: leaveSysMsgId,
    dmChannelId: channel.id,
    userId: localUser.id,
    content: JSON.stringify({
      event: 'member_removed',
      targetUserId: localUser.id,
      targetDisplayName: localUser.displayName ?? leaveBaseName,
      reason: event.membership?.reason ?? 'leave',
    }),
    type: 'system',
    createdAt: Date.now(),
  }).run();

  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_message_created',
    message: {
      id: leaveSysMsgId,
      dmChannelId: channel.id,
      userId: localUser.id,
      content: JSON.stringify({
        event: 'member_removed',
        targetUserId: localUser.id,
        targetDisplayName: localUser.displayName ?? leaveBaseName,
        reason: event.membership?.reason ?? 'leave',
      }),
      type: 'system',
      createdAt: Date.now(),
      user: sanitizeUser(localUser),
      attachments: [],
      embeds: [],
      reactions: [],
    } as any,
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

function processOwnershipTransferEvent(
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

  const channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // Validate authority: only the current owner's instance can transfer ownership
  if (channel.ownerHomeInstance && sourceInstance !== channel.ownerHomeInstance) {
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
    { username: event.ownership.newOwner.profile?.username },
  );
  if (!newOwnerLocal) {
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  db.update(schema.dmChannels)
    .set({
      ownerId: newOwnerLocal.id,
      ownerHomeUserId: event.ownership.newOwner.homeUserId,
      ownerHomeInstance: event.ownership.newOwner.homeInstance,
    })
    .where(eq(schema.dmChannels.id, channel.id))
    .run();

  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_owner_updated',
    dmChannelId: channel.id,
    newOwnerId: newOwnerLocal.id,
  });

  const prevOwnerLocal = event.ownership.previousOwner
    ? resolveLocalUser(event.ownership.previousOwner.homeUserId, db)
    : null;
  const ownerSysMsgId = generateSnowflake();
  const newOwnerBaseName = newOwnerLocal?.username?.includes('@') ? newOwnerLocal.username.split('@')[0] : (newOwnerLocal?.username ?? 'Unknown');
  const prevOwnerId = prevOwnerLocal?.id ?? channel.ownerId ?? 'system';

  db.insert(schema.dmMessages).values({
    id: ownerSysMsgId,
    dmChannelId: channel.id,
    userId: prevOwnerId,
    content: JSON.stringify({
      event: 'owner_changed',
      newOwnerId: newOwnerLocal.id,
      newOwnerDisplayName: newOwnerLocal.displayName ?? newOwnerBaseName,
    }),
    type: 'system',
    createdAt: Date.now(),
  }).run();

  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_message_created',
    message: {
      id: ownerSysMsgId,
      dmChannelId: channel.id,
      userId: prevOwnerId,
      content: JSON.stringify({
        event: 'owner_changed',
        newOwnerId: newOwnerLocal?.id ?? event.ownership.newOwner.homeUserId,
        newOwnerDisplayName: newOwnerLocal?.displayName ?? newOwnerBaseName,
      }),
      type: 'system',
      createdAt: Date.now(),
      user: prevOwnerLocal ? sanitizeUser(prevOwnerLocal) : undefined,
      attachments: [],
      embeds: [],
      reactions: [],
    } as any,
  });

  accepted.push(event.messageId);
}

// ─── Friend Event Processors ─────────────────────────────────────────────────

/**
 * Hydrate a replicated user stub with profile data from a relay event.
 * Only updates fields that are currently null/empty on the local row,
 * so manually-set local values are preserved.
 */
function hydrateReplicatedUserProfile(
  user: typeof schema.users.$inferSelect,
  profile: FederationRelayProfileSnapshot | undefined,
  db: ReturnType<typeof getDb>,
): typeof schema.users.$inferSelect {
  if (!profile) return user;
  if (!user.homeInstance) return user; // Don't update native users

  // Resolve bare filenames to absolute URLs pointing to the home instance.
  // The home WS doesn't run normalizeUserAssets on replicated users' avatars,
  // so they must be stored as absolute URLs to render correctly.
  const baseUrl = user.homeInstance!.startsWith('http') ? user.homeInstance! : `https://${user.homeInstance}`;
  const resolveUrl = (filename: string | null | undefined): string | null => {
    if (!filename) return null;
    if (filename.startsWith('http')) return filename;
    return `${baseUrl}/api/uploads/${filename}`;
  };

  const updates: Record<string, string | null> = {};
  // Use displayName from profile, falling back to the home username (without
  // the @domain suffix that the local replicated username carries).  This
  // ensures federated users show a human-readable name instead of the raw
  // "user@instance.example" federation username.
  const effectiveDisplayName = profile.displayName || profile.username || null;
  if (effectiveDisplayName && !user.displayName) updates.displayName = effectiveDisplayName;
  // Overwrite avatar/banner if missing OR if it's a stale bare filename (not an absolute URL)
  if (profile.avatar && (!user.avatar || !user.avatar.startsWith('http'))) updates.avatar = resolveUrl(profile.avatar);
  if (profile.avatarColor) updates.avatarColor = profile.avatarColor;
  if (profile.banner && (!user.banner || !user.banner.startsWith('http'))) updates.banner = resolveUrl(profile.banner);
  if (profile.bio && !user.bio) updates.bio = profile.bio;

  if (Object.keys(updates).length === 0) return user;

  db.update(schema.users)
    .set(updates)
    .where(eq(schema.users.id, user.id))
    .run();

  return { ...user, ...updates };
}

function processFriendRequestCreateEvent(
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
    console.warn(`[federation] Attribution mismatch in friend_request_create: from homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve the sender (create stub if needed — they're on a remote instance)
  const fromUserResolved = resolveOrCreateReplicatedUser(from.homeUserId, from.homeInstance, db, { username: event.friendship.fromProfile?.username });
  if (!fromUserResolved) {
    // Sender's identity has been deleted — silently accept to drop the event
    accepted.push(event.messageId);
    return;
  }
  let fromUser = hydrateReplicatedUserProfile(fromUserResolved, event.friendship.fromProfile, db);

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

  // Idempotency: if a pending request already exists from this sender to this recipient, accept as no-op
  const existingRequest = db
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
  const toUser = resolveOrCreateReplicatedUser(to.homeUserId, to.homeInstance, db, { username: event.friendship.toProfile?.username });
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

function processFriendAddEvent(
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

  // Attribution: acceptor must belong to source instance (FED-010)
  if (!verifyAttribution(to.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_add: to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve both users (create stubs if needed) and hydrate with profile data
  const fromUserResolved = resolveOrCreateReplicatedUser(from.homeUserId, from.homeInstance, db, { username: event.friendship.fromProfile?.username });
  if (!fromUserResolved) {
    // One party's identity is deleted — accept idempotently to drop the event
    accepted.push(event.messageId);
    return;
  }
  let fromUser = hydrateReplicatedUserProfile(fromUserResolved, event.friendship.fromProfile, db);
  const toUserResolved = resolveOrCreateReplicatedUser(to.homeUserId, to.homeInstance, db, { username: event.friendship.toProfile?.username });
  if (!toUserResolved) {
    accepted.push(event.messageId);
    return;
  }
  let toUser = hydrateReplicatedUserProfile(toUserResolved, event.friendship.toProfile, db);

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

  if (!channel) {
    rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
    return;
  }

  const localDmChannelId = channel.id;

  // Resolve caller to local stub
  const callerStub = resolveOrCreateReplicatedUser(
    event.call.caller.homeUserId,
    event.call.caller.homeInstance,
    db,
    { username: event.call.caller.displayName },
  );
  if (!callerStub) {
    // Caller's identity has been deleted — can't initiate a call as a tombstoned user
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  // Create federated call entry in registry
  const entry: FederatedCallEntry = {
    dmChannelId: localDmChannelId,
    federatedId: event.federatedId,
    callerId: callerStub.id,
    callerHomeUserId: event.call.caller.homeUserId,
    federatedCallHost: sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`,
    livekitUrl: event.call.livekitUrl,
    tokens: new Map(Object.entries(event.call.tokens)),
    state: 'ringing',
    startedAt: Date.now(),
  };

  connectionManager.createFederatedCall(entry);

  // Send dm_call_incoming to each local member
  const localMembers = db.select({
    userId: schema.dmMembers.userId,
    homeUserId: schema.users.homeUserId,
  })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, localDmChannelId))
    .all();

  for (const member of localMembers) {
    const homeUserId = member.homeUserId || member.userId;
    const token = event.call!.tokens![homeUserId];

    connectionManager.sendToUser(member.userId, {
      type: 'dm_call_incoming',
      dmChannelId: localDmChannelId,
      callerId: callerStub.id,
      callerName: callerStub.displayName ?? callerStub.username,
      livekitUrl: event.call!.livekitUrl,
      livekitToken: token,
    });
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

  if (!channel) {
    rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
    return;
  }

  const dmChannelId = channel.id;

  // Check if we're the HOST (have a VoiceRoom)
  const room = connectionManager.getRoom(dmChannelId);
  if (room && room.roomType === 'dm') {
    const meta = room.metadata as DmRoomMeta;

    if (meta.state === 'ringing') {
      connectionManager.activateDmRoom(dmChannelId);

      // Join caller to room
      connectionManager.leaveCurrentRoom(meta.callerId);
      connectionManager.joinRoom(dmChannelId, meta.callerId);

      connectionManager.sendToDmMembers(dmChannelId, {
        type: 'voice_state_update',
        channelId: dmChannelId,
        userId: meta.callerId,
        action: 'join',
      });
    }

    // Broadcast accepted locally
    connectionManager.sendToDmMembers(dmChannelId, {
      type: 'dm_call_accepted',
      dmChannelId,
    });

    // Fan out to ALL other remote instances (exclude the one that sent the accept)
    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    fanOutCallEvent(dmChannelId, event.federatedId, 'dm_call_accept', {
      call: { acceptor: event.call.acceptor },
    }, normalizedSource, db).catch(err =>
      console.error('[federation] Fan-out dm_call_accept failed:', err)
    );
  } else {
    // We're a REMOTE instance receiving fan-out — transition local state
    const fedCall = connectionManager.getFederatedCall(dmChannelId);
    if (fedCall) {
      connectionManager.activateFederatedCall(dmChannelId);
      connectionManager.sendToDmMembers(dmChannelId, {
        type: 'dm_call_accepted',
        dmChannelId,
      });
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

  if (!channel) {
    rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
    return;
  }

  const dmChannelId = channel.id;

  const room = connectionManager.getRoom(dmChannelId);
  if (room && room.roomType === 'dm') {
    const meta = room.metadata as DmRoomMeta;
    connectionManager.clearVoiceWs(meta.callerId);
    connectionManager.destroyRoom(dmChannelId);

    connectionManager.sendToDmMembers(dmChannelId, {
      type: 'dm_call_rejected',
      dmChannelId,
    });

    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    fanOutCallEvent(dmChannelId, event.federatedId, 'dm_call_end', {
      call: { endedBy: event.call.rejector },
    }, normalizedSource, db).catch(err =>
      console.error('[federation] Fan-out dm_call_end (reject) failed:', err)
    );
  } else {
    const fedCall = connectionManager.getFederatedCall(dmChannelId);
    if (fedCall) {
      connectionManager.clearFederatedCall(dmChannelId);
      connectionManager.sendToDmMembers(dmChannelId, {
        type: 'dm_call_rejected',
        dmChannelId,
      });
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

  if (!channel) {
    rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
    return;
  }

  const dmChannelId = channel.id;

  const room = connectionManager.getRoom(dmChannelId);
  if (room && room.roomType === 'dm') {
    const meta = room.metadata as DmRoomMeta;
    connectionManager.clearVoiceWs(meta.callerId);
    for (const pid of room.participants) {
      connectionManager.clearVoiceUserStatus(pid);
      connectionManager.clearVoiceWs(pid);
    }
    connectionManager.destroyRoom(dmChannelId);

    connectionManager.sendToDmMembers(dmChannelId, {
      type: 'dm_call_ended',
      dmChannelId,
    });

    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    fanOutCallEvent(dmChannelId, event.federatedId, 'dm_call_end', {
      call: { endedBy: event.call.endedBy },
    }, normalizedSource, db).catch(err =>
      console.error('[federation] Fan-out dm_call_end failed:', err)
    );
  } else {
    const fedCall = connectionManager.getFederatedCall(dmChannelId);
    if (fedCall) {
      connectionManager.clearFederatedCall(dmChannelId);
      connectionManager.sendToDmMembers(dmChannelId, {
        type: 'dm_call_ended',
        dmChannelId,
      });
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

function processProfileUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
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

  // Authoritative overwrite — home instance is always right
  db.update(schema.users)
    .set({
      displayName: payload.displayName,
      avatar: payload.avatar,
      banner: payload.banner,
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
): Promise<void> {
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
  if (targets.size === 0) return;

  const relayEvent: FederationRelayEvent = {
    eventType,
    messageId: generateSnowflake(),
    encryptionVersion: 0,
    timestamp: Date.now(),
    federatedId,
    ...extraFields,
  } as FederationRelayEvent;

  await Promise.all(
    Array.from(targets).map(origin =>
      sendCallRelay(origin, [relayEvent]).catch(err =>
        console.error(`[federation] Fan-out ${eventType} to ${origin} failed:`, err)
      )
    )
  );
}
