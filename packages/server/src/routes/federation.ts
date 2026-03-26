import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { eq, and, or, isNull } from 'drizzle-orm';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { generateHmacSecret, parseFederationHeaders, verifySignature } from '../utils/federationAuth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { getDb, getRawDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { connectionManager } from '../ws/handler.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { deleteAttachmentFiles } from '../utils/fileCleanup.js';
import { canonicalDmPairId } from '../utils/federationOutbox.js';
import { broadcastDmMessage } from './dm.js';
import type { FederationRelayRequest, FederationRelayResponse, FederationRelayEvent, FederationRelayAttachment, FederationSyncRequest, FederationSyncResponse, DmMessageWithUser } from '@backspace/shared';

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
    // origin is scheme + host (+ port if non-default) — no trailing slash
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

// Periodically clean stale buckets to prevent unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - ACCEPT_RATE_WINDOW_MS;
  for (const [ip, timestamps] of acceptRateBuckets) {
    // Remove expired entries
    while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) {
      acceptRateBuckets.delete(ip);
    }
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
        return reply.code(400).send({ error: 'remoteOrigin must be a valid HTTP/HTTPS URL', statusCode: 400 });
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
      const challenge = randomBytes(16).toString('hex');
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
            challenge,
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
  app.post<{ Body: { sourceOrigin: string; challenge: string; hmacSecret: string } }>(
    '/api/federation/peer/accept',
    async (request, reply) => {
      const clientIp = request.ip;
      if (isAcceptRateLimited(clientIp)) {
        return reply.code(429).send({
          error: 'Too many peering requests — try again later',
          statusCode: 429,
        });
      }

      const { sourceOrigin: rawOrigin, challenge, hmacSecret } = request.body ?? {};

      if (!rawOrigin || typeof rawOrigin !== 'string') {
        return reply.code(400).send({ error: 'sourceOrigin is required', statusCode: 400 });
      }
      if (!challenge || typeof challenge !== 'string') {
        return reply.code(400).send({ error: 'challenge is required', statusCode: 400 });
      }
      if (!hmacSecret || typeof hmacSecret !== 'string') {
        return reply.code(400).send({ error: 'hmacSecret is required', statusCode: 400 });
      }

      const sourceOrigin = validateOrigin(rawOrigin);
      if (!sourceOrigin) {
        return reply.code(400).send({ error: 'sourceOrigin must be a valid HTTP/HTTPS URL', statusCode: 400 });
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

      // Serialize body back to JSON for HMAC verification (we control both sides)
      const bodyString = JSON.stringify(request.body);
      if (!verifySignature(bodyString, fedHeaders.signature, peer.hmacSecret, fedHeaders.timestamp)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
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
      const accepted: string[] = [];
      const rejected: Array<{ messageId: string; reason: string }> = [];

      for (const event of body.events) {
        try {
          switch (event.eventType) {
            case 'create':
              processCreateEvent(event, sourceInstance, peer.origin, db, accepted, rejected);
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

      // 4. Update peer status
      db.update(schema.federationPeers)
        .set({
          lastSeenAt: Date.now(),
          consecutiveFailures: 0,
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
      if (!verifySignature(bodyString, fedHeaders.signature, peer.hmacSecret, fedHeaders.timestamp)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // 2. Validate & normalize request body
      const body = request.body;
      if (!body || typeof body.sinceTimestamp !== 'number' || body.sinceTimestamp < 0) {
        return reply.code(400).send({ error: 'sinceTimestamp must be a non-negative number', statusCode: 400 });
      }

      const sinceTimestamp = body.sinceTimestamp;
      const dmChannelIdFilter = body.dmChannelId && typeof body.dmChannelId === 'string' ? body.dmChannelId : null;

      // Clamp limit: min 1, max 500, default 100
      let limit = typeof body.limit === 'number' ? body.limit : 100;
      limit = Math.max(1, Math.min(500, Math.floor(limit)));

      // 3. Determine which DM channels to sync.
      //    Use canonical_pair_id: any channel with a pair ID is a federated 1-on-1 DM
      //    that should be synced. The peer's relay endpoint will create the channel
      //    if it doesn't exist, or match by canonical_pair_id if it does.
      const sharedChannelRows = rawDb.prepare(`
        SELECT id as dm_channel_id FROM dm_channels WHERE canonical_pair_id IS NOT NULL
      `).all() as Array<{ dm_channel_id: string }>;

      const sharedChannelIds = sharedChannelRows.map(r => r.dm_channel_id);

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
      let mutationRows: Array<{
        id: string;
        dm_message_id: string;
        dm_channel_id: string;
        mutation_type: string;
        mutated_at: number;
        payload: string | null;
      }>;

      if (dmChannelIdFilter) {
        // Validate that the requested channel is actually shared with this peer
        if (!sharedChannelIds.includes(dmChannelIdFilter)) {
          const syncResponse: FederationSyncResponse = {
            events: [],
            hasMore: false,
            checkpoint: sinceTimestamp,
          };
          return reply.code(200).send(syncResponse);
        }

        mutationRows = rawDb.prepare(`
          SELECT ml.id, ml.dm_message_id, ml.dm_channel_id, ml.mutation_type, ml.mutated_at, ml.payload
          FROM federation_mutation_log ml
          JOIN dm_messages dm ON ml.dm_message_id = dm.id
          WHERE ml.dm_channel_id = ?
            AND ml.mutated_at > ?
          ORDER BY ml.mutated_at ASC
          LIMIT ?
        `).all(dmChannelIdFilter, sinceTimestamp, limit) as typeof mutationRows;

        // For delete mutations, the dm_messages row won't exist — handle separately
        const deleteMutations = rawDb.prepare(`
          SELECT ml.id, ml.dm_message_id, ml.dm_channel_id, ml.mutation_type, ml.mutated_at, ml.payload
          FROM federation_mutation_log ml
          WHERE ml.dm_channel_id = ?
            AND ml.mutated_at > ?
            AND ml.mutation_type = 'delete'
            AND ml.dm_message_id NOT IN (SELECT dm.id FROM dm_messages dm WHERE dm.id = ml.dm_message_id)
          ORDER BY ml.mutated_at ASC
          LIMIT ?
        `).all(dmChannelIdFilter, sinceTimestamp, limit) as typeof mutationRows;

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
          SELECT ml.id, ml.dm_message_id, ml.dm_channel_id, ml.mutation_type, ml.mutated_at, ml.payload
          FROM federation_mutation_log ml
          JOIN dm_messages dm ON ml.dm_message_id = dm.id
          WHERE ml.dm_channel_id IN (${placeholders})
            AND ml.mutated_at > ?
          ORDER BY ml.mutated_at ASC
          LIMIT ?
        `).all(...sharedChannelIds, sinceTimestamp, limit) as typeof mutationRows;

        // For delete mutations, the dm_messages row won't exist — handle separately
        const deleteMutations = rawDb.prepare(`
          SELECT ml.id, ml.dm_message_id, ml.dm_channel_id, ml.mutation_type, ml.mutated_at, ml.payload
          FROM federation_mutation_log ml
          WHERE ml.dm_channel_id IN (${placeholders})
            AND ml.mutated_at > ?
            AND ml.mutation_type = 'delete'
            AND ml.dm_message_id NOT IN (SELECT dm.id FROM dm_messages dm WHERE dm.id = ml.dm_message_id)
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

      // 5. Build response events from mutation log entries
      const events: FederationRelayEvent[] = [];

      for (const mutation of mutationRows) {
        const mutationType = mutation.mutation_type as 'create' | 'update' | 'delete' | 'reaction_add' | 'reaction_remove';

        if (mutationType === 'delete') {
          // For deletes, we don't need the message content — just the ID and channel
          events.push({
            eventType: 'delete',
            dmChannelId: mutation.dm_channel_id,
            messageId: mutation.dm_message_id,
            encryptionVersion: 0,
            timestamp: mutation.mutated_at,
          });
          continue;
        }

        if (mutationType === 'reaction_add' || mutationType === 'reaction_remove') {
          // Use the stored payload from the mutation log
          if (mutation.payload) {
            let reactionData: { userId: string; homeUserId: string; emoji: string; createdAt?: number } | null = null;
            try {
              reactionData = JSON.parse(mutation.payload) as { userId: string; homeUserId: string; emoji: string; createdAt?: number };
            } catch {
              // Skip malformed payload
              continue;
            }

            events.push({
              eventType: mutationType,
              dmChannelId: mutation.dm_channel_id,
              messageId: mutation.dm_message_id,
              encryptionVersion: 0,
              timestamp: mutation.mutated_at,
              reaction: {
                userId: reactionData.userId,
                homeUserId: reactionData.homeUserId,
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
          .where(eq(schema.dmMessages.id, mutation.dm_message_id))
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
          dmChannelId: mutation.dm_channel_id,
          messageId: message.id,
          encryptionVersion: 0,
          timestamp: mutation.mutated_at,
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

// ─── Relay Event Processors ──────────────────────────────────────────────────

/**
 * Resolve a home user ID to a local user.
 * Matches users where home_user_id = homeUserId, or where
 * the user's own id equals homeUserId and they have no home_instance set (local user).
 */
function resolveLocalUser(
  homeUserId: string,
  db: ReturnType<typeof getDb>,
): typeof schema.users.$inferSelect | undefined {
  return db
    .select()
    .from(schema.users)
    .where(
      or(
        eq(schema.users.homeUserId, homeUserId),
        and(eq(schema.users.id, homeUserId), isNull(schema.users.homeInstance)),
      ),
    )
    .get();
}

/**
 * Find or create a local DM channel for a federated 1-on-1 pair.
 * Uses canonical_pair_id for deterministic cross-instance lookup.
 */
function findOrCreateDmChannel(
  canonicalPairId: string,
  localUserIdA: string,
  localUserIdB: string,
  db: ReturnType<typeof getDb>,
): string {
  // Try to find existing channel by canonical pair ID
  const existing = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.canonicalPairId, canonicalPairId))
    .get();

  if (existing) {
    // Ensure both users are members (they might have been removed)
    for (const userId of [localUserIdA, localUserIdB]) {
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

  // Create new DM channel with canonical pair ID
  const channelId = generateSnowflake();
  const now = Date.now();

  db.insert(schema.dmChannels)
    .values({
      id: channelId,
      canonicalPairId,
      createdAt: now,
    })
    .run();

  for (const userId of [localUserIdA, localUserIdB]) {
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

  // Resolve the message author to a local user
  const authorUser = resolveLocalUser(event.message.homeUserId, db);
  if (!authorUser) {
    rejected.push({ messageId: event.messageId, reason: 'user_not_found' });
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

  // Resolve the DM recipient. Federated DMs are 1-on-1: one side is the author,
  // the other is a local user on this instance. We match via canonical_pair_id.
  const authorHomeUserId = event.message.homeUserId;

  // First, search existing DM channels where the author is already a member
  const authorMemberships = db
    .select({ dmChannelId: schema.dmMembers.dmChannelId })
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.userId, authorUser.id))
    .all();

  let localDmChannelId: string | null = null;

  // Check each of the author's DM channels to find the matching one
  for (const membership of authorMemberships) {
    const channelMembers = db
      .select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, membership.dmChannelId))
      .all();

    // For 1-on-1 DMs, there should be exactly 2 members
    if (channelMembers.length === 2) {
      const otherMember = channelMembers.find(m => m.userId !== authorUser.id);
      if (otherMember) {
        const otherUser = db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, otherMember.userId))
          .get();

        if (otherUser) {
          const otherHomeUserId = otherUser.homeUserId || otherUser.id;
          const pairId = canonicalDmPairId(authorHomeUserId, otherHomeUserId);
          const channel = db
            .select()
            .from(schema.dmChannels)
            .where(eq(schema.dmChannels.id, membership.dmChannelId))
            .get();

          if (channel?.canonicalPairId === pairId) {
            localDmChannelId = membership.dmChannelId;
            break;
          }
        }
      }
    }
  }

  // If no existing channel found, search the author's friends for the recipient.
  // On cold start (first federated DM), we use the friends list as a hint to
  // find the local user and create the DM channel.
  if (!localDmChannelId) {
    const friendRows = db
      .select()
      .from(schema.friends)
      .where(
        or(
          eq(schema.friends.userId, authorUser.id),
          eq(schema.friends.friendId, authorUser.id),
        ),
      )
      .all();

    const friendIds = friendRows.map(f =>
      f.userId === authorUser.id ? f.friendId : f.userId,
    );

    for (const friendId of friendIds) {
      const friendUser = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, friendId))
        .get();

      if (friendUser) {
        const friendHomeUserId = friendUser.homeUserId || friendUser.id;
        const pairId = canonicalDmPairId(authorHomeUserId, friendHomeUserId);

        // Check if a channel already exists with this pair ID
        const existingChannel = db
          .select()
          .from(schema.dmChannels)
          .where(eq(schema.dmChannels.canonicalPairId, pairId))
          .get();

        if (existingChannel) {
          localDmChannelId = existingChannel.id;
          break;
        }
      }
    }

    // If still no channel with a matching canonical pair ID, create one.
    // The recipient must be a local (non-federated) user who is friends with the author.
    if (!localDmChannelId && friendIds.length > 0) {
      for (const friendId of friendIds) {
        const friendUser = db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, friendId))
          .get();

        if (friendUser && !friendUser.homeInstance) {
          // This is a local user — they're a candidate recipient
          const friendHomeUserId = friendUser.homeUserId || friendUser.id;
          const pairId = canonicalDmPairId(authorHomeUserId, friendHomeUserId);

          localDmChannelId = findOrCreateDmChannel(pairId, authorUser.id, friendId, db);
          break;
        }
      }
    }
  }

  if (!localDmChannelId) {
    rejected.push({ messageId: event.messageId, reason: 'recipient_not_found' });
    return;
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

  // Queue attachment downloads (SSRF-validated)
  if (event.message.attachments && event.message.attachments.length > 0) {
    const now = Date.now();
    for (const attachment of event.message.attachments) {
      if (!isUrlFromPeer(attachment.sourceUrl, peerOrigin)) {
        console.warn(
          `[federation-relay] Rejecting attachment URL ${attachment.sourceUrl} — hostname does not match peer ${peerOrigin}`,
        );
        continue;
      }

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

  // Broadcast to local WebSocket clients
  const messagePayload = buildDmMessagePayload(
    {
      id: localMessageId,
      dmChannelId: localDmChannelId,
      userId: authorUser.id,
      content: event.message.content,
      replyToId: null,
      editedAt: null,
      createdAt: event.message.createdAt,
    },
    authorUser,
  );
  broadcastDmMessage(localDmChannelId, messagePayload);

  accepted.push(event.messageId);
}

function processUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
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

  // Find the local message corresponding to the source message
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

  // Find the local message
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
