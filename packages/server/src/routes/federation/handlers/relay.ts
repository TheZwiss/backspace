import path from 'node:path';
import { config } from '../../../config.js';
import { getDb, getRawDb, schema } from '../../../db/index.js';
import { buildFederationHeaders, getOurOrigin, parseFederationHeaders, verifyPeerSignature } from '../../../utils/federationAuth.js';
import { getInstanceId } from '../../../utils/federationEpoch.js';
import { getDmParticipants } from '../../../utils/federationOutbox.js';
import { deleteAttachmentFiles } from '../../../utils/fileCleanup.js';
import { sanitizeUser } from '../../../utils/sanitize.js';
import { collectDeletionBroadcastTargets, tombstoneUser } from '../../../utils/userDeletion.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FederationIdentityDeleteS2SRequest, FederationRelayAttachment, FederationRelayEvent, FederationRelayRequest, FederationRelayResponse, FederationSyncRequest, FederationSyncResponse } from '@backspace/shared';
import type { FastifyInstance } from 'fastify';
import { processRelayEvents } from '../events/dispatch.js';
import { extractDomain } from '../identity.js';
import { resolveLocalOrigin } from '../origin.js';
import { isNonceDuplicate, isRelayRateLimited } from '../rateLimits.js';

export function registerRelayRoutes(app: FastifyInstance): void {
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

      // Detached (home-orphaned) accounts are sovereign local accounts. The
      // domain's new incarnation must not delete them by replaying old
      // homeUserIds. Idempotent 200: from the caller's perspective this
      // identity does not exist here.
      if (user.federationHomeOrphaned === 1) {
        console.log(`[federation] Ignoring S2S identity delete for detached account ${user.id} from ${fedHeaders.origin}`);
        return reply.code(200).send({ success: true });
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

      // Friend-branch pagination must be computed from PRE-filter rows —
      // filtering in place would stall the checkpoint / drop pages (spec §3.2).
      let prefilterCount: number | null = null;
      let prefilterLastTs: number | null = null;

      if (contextTypeFilter === 'friend') {
        // ── Friend event sync: relevance-scoped to the requesting peer ──
        const fetchedFriendRows = rawDb.prepare(`
          SELECT id, entity_id, context_id, context_type, mutation_type, mutated_at, payload
          FROM federation_mutation_log
          WHERE context_type = 'friend' AND mutated_at > ?
          ORDER BY mutated_at ASC
          LIMIT ?
        `).all(sinceTimestamp, limit) as typeof mutationRows;

        prefilterCount = fetchedFriendRows.length;
        prefilterLastTs = fetchedFriendRows.length > 0
          ? fetchedFriendRows[fetchedFriendRows.length - 1]!.mutated_at
          : null;

        const peerDomainFriend = extractDomain(peer.origin).toLowerCase();
        const normHome = `lower(replace(replace(coalesce(home_instance, ''), 'https://', ''), 'http://', ''))`;
        const localRowStmt = rawDb.prepare(`
          SELECT is_deleted, federation_home_orphaned FROM users
          WHERE home_user_id = ? AND ${normHome} = ?
        `);

        // An event qualifies iff at least one side is homed at the requester's
        // domain AND that side, when it resolves to a local row, is live and
        // non-detached. A detached/tombstoned row belongs to a dead incarnation
        // of the requester, not to the requester (spec §3.2).
        const sideQualifies = (side: { homeUserId?: string; homeInstance?: string } | undefined): boolean => {
          if (!side?.homeUserId || !side.homeInstance) return false;
          if (extractDomain(side.homeInstance).toLowerCase() !== peerDomainFriend) return false;
          const local = localRowStmt.get(side.homeUserId, peerDomainFriend) as
            { is_deleted: number; federation_home_orphaned: number } | undefined;
          if (local && (local.is_deleted === 1 || local.federation_home_orphaned === 1)) return false;
          return true;
        };

        mutationRows = fetchedFriendRows.filter((row) => {
          if (!row.payload) return false;
          let friendship: { from?: { homeUserId?: string; homeInstance?: string }; to?: { homeUserId?: string; homeInstance?: string } } | undefined;
          try {
            friendship = (JSON.parse(row.payload) as { friendship?: typeof friendship }).friendship;
          } catch {
            return false;
          }
          if (!friendship) return false;
          return sideQualifies(friendship.from) || sideQualifies(friendship.to);
        });
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
        // Relevance scoping (dead-incarnation spec §3.2): only offer channels
        // with at least one LIVE member homed at the requesting peer's domain.
        // A reset peer's former users are detached (federation_home_orphaned=1)
        // or tombstoned here — their channels are our history, not the new
        // incarnation's. Channels not involving the requester at all are none
        // of its business either (third-instance over-broadcast).
        const peerDomain = extractDomain(peer.origin).toLowerCase();
        const sharedChannelRows = rawDb.prepare(`
          SELECT DISTINCT c.id as dm_channel_id, c.federated_id
          FROM dm_channels c
          JOIN dm_members m ON m.dm_channel_id = c.id
          JOIN users u ON u.id = m.user_id
          WHERE c.federated_id IS NOT NULL AND c.deleted_at IS NULL
            AND u.is_deleted = 0
            AND u.federation_home_orphaned = 0
            AND lower(replace(replace(coalesce(u.home_instance, ''), 'https://', ''), 'http://', '')) = ?
        `).all(peerDomain) as Array<{ dm_channel_id: string; federated_id: string }>;

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
          localOrigin = resolveLocalOrigin();
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

      // 6. Compute pagination metadata — from PRE-filter rows when the friend
      //    branch filtered, so filtered-out events still advance the cursor.
      const hasMore = (prefilterCount ?? mutationRows.length) >= limit;
      const checkpoint = prefilterLastTs
        ?? (mutationRows.length > 0
          ? mutationRows[mutationRows.length - 1]!.mutated_at
          : sinceTimestamp);

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
