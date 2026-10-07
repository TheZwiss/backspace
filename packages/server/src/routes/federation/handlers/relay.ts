import { config } from '../../../config.js';
import { getDb, schema } from '../../../db/index.js';
import { normalizeOriginForCompare, parseFederationHeaders, verifyPeerSignature } from '../../../utils/federationAuth.js';
import { sendSignedJson } from './signedResponse.js';
import { getInstanceId } from '../../../utils/federationEpoch.js';
import { deleteAttachmentFiles } from '../../../utils/fileCleanup.js';
import { sanitizeUser } from '../../../utils/sanitize.js';
import { collectDeletionBroadcastTargets, tombstoneUser } from '../../../utils/userDeletion.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, eq, isNull } from 'drizzle-orm';
import type { FederationIdentityDeleteS2SRequest, FederationRelayRequest, FederationRelayResponse, FederationSyncRequest, FederationSyncResponse } from '@backspace/shared';
import type { FastifyInstance } from 'fastify';
import { processRelayEvents } from '../events/dispatch.js';
import { extractDomain } from '../identity.js';
import { isRelayRateLimited } from '../rateLimits.js';
import { markOutboxOfferedForPeer } from '../../../utils/federationOutboxQueue.js';
import { authenticateS2SPeer } from './s2sAuth.js';
import { buildSyncResponse, type SyncPosition } from './syncPage.js';

/**
 * The rejection list as it goes on the wire to the sender of this batch.
 *
 * `attribution_unproven` is only sent to a sender that listed it in
 * `FederationRelayRequest.capabilities`. Any other sender receives v1's
 * `attribution_mismatch` for the same case, which it already treats as final.
 * Sending it the new reason instead would be worse than the old answer: a
 * sender that predates it does not recognise it, keeps the outbox row, and
 * (having no backoff for rejections it does not recognise) resends it on every
 * outbox tick until the row expires.
 *
 * `capabilities` comes from the request body and is untrusted; anything other
 * than an array counts as an empty list.
 */
function rejectionsForSender(
  rejected: Array<{ messageId: string; reason: string }>,
  capabilities: unknown,
): Array<{ messageId: string; reason: string }> {
  const retriesUnproven = Array.isArray(capabilities) && capabilities.includes('attribution_unproven');
  if (retriesUnproven) return rejected;
  return rejected.map(r => (r.reason === 'attribution_unproven' ? { ...r, reason: 'attribution_mismatch' } : r));
}

export function registerRelayRoutes(app: FastifyInstance): void {
  // ─── DELETE /api/federation/identity ──────────────────────────────────────
  // S2S endpoint: delete a federated user's identity on this instance.
  // Called by the user's home instance via HMAC-signed request.
  app.delete<{ Body: FederationIdentityDeleteS2SRequest }>(
    '/api/federation/identity',
    async (request, reply) => {
      const db = getDb();

      // Shared inbound S2S-auth preamble: headers → active peer → signature →
      // nonce replay. No rate limiter; warns on a legacy peer's missing nonce.
      const auth = authenticateS2SPeer(request, reply, { logMissingNonce: true });
      if (!auth.ok) return;
      const { peer } = auth;

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
      if (!user.homeInstance || extractDomain(user.homeInstance) !== extractDomain(peer.origin)) {
        return reply.code(403).send({ error: 'Attribution mismatch: you can only delete users from your own instance', statusCode: 403 });
      }

      // Detached (home-orphaned) accounts are sovereign local accounts. The
      // domain's new incarnation must not delete them by replaying old
      // homeUserIds. Idempotent 200: from the caller's perspective this
      // identity does not exist here.
      if (user.federationHomeOrphaned === 1) {
        console.log(`[federation] Ignoring S2S identity delete for detached account ${user.id} from ${peer.origin}`);
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

      console.log(`[federation] Identity deleted for user ${user.id} (${user.username}) via S2S from ${peer.origin}, mode=${mode}`);

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

      // Shared inbound S2S-auth preamble: headers → active peer → rate limit →
      // signature → nonce replay. The per-peer relay rate limiter runs BEFORE
      // signature verification (avoid HMAC work on a flood); warns on a legacy
      // peer's missing nonce.
      const auth = authenticateS2SPeer(request, reply, {
        rateLimiter: { limited: isRelayRateLimited },
        logMissingNonce: true,
      });
      if (!auth.ok) return;
      const { peer } = auth;

      // 1b-epoch. Fast-path baseline population (design §3.2). The signature the
      // preamble verified proves the peer holds the current shared secret, so the
      // epoch it carries in `sourceInstanceId` is authentic. Populate-if-null
      // ONLY: a valid relay can never carry an epoch differing from a non-null
      // baseline (a different incarnation implies a different secret that fails
      // HMAC), so we only ever fill a NULL — never overwrite. Independent of
      // per-event processing; does not affect relay accept/reject in any way. Old
      // peers omit the field → skip (backward-compatible no-op).
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

      // 2b. Bind the batch's claimed origin to the peer that actually signed it.
      // The HMAC proves WHO sent this request; `sourceInstance` is only what the
      // body CLAIMS, and every downstream attribution check reads it. An honest
      // peer always sends its own `getOurOrigin()` here, so a mismatch is never
      // a legitimate configuration — it is one peer speaking as another.
      if (normalizeOriginForCompare(sourceInstance) !== normalizeOriginForCompare(peer.origin)) {
        console.warn(`[federation] Relay source rejected: peer ${peer.origin} claimed sourceInstance=${sourceInstance}`);
        return reply.code(403).send({ error: 'sourceInstance does not match the authenticated peer', statusCode: 403 });
      }

      // 3. Process each event
      const { accepted, rejected, undeliverable } = await processRelayEvents(body.events, sourceInstance, peer.origin, db);

      // 4. Update peer status
      db.update(schema.federationPeers)
        .set({
          lastSeenAt: Date.now(),
          consecutiveFailures: 0,
          ...(auth.nonce && !peer.nonceSupported ? { nonceSupported: 1 } : {}),
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
        rejected: rejectionsForSender(rejected, body.capabilities),
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
  //
  // NON-ADOPTER of authenticateS2SPeer (deliberate): gates on status !== 'revoked'
  // (ANY non-revoked peer must answer so a needs_attention/unreachable peer can
  // drive RECOVERY via this signed round-trip), returns 400 (not 401) on missing
  // headers, and runs NO nonce check. Folding it into the helper would flatten the
  // recovery gate and the status code.
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
      return sendSignedJson(reply, { instanceId: getInstanceId() }, peer.hmacSecret);
    },
  );

  // ─── POST /api/federation/sync ──────────────────────────────────────────────
  // Server-to-server: a page of this instance's mutation log for the requesting
  // peer, which pulls it (utils/federationSync.ts) to catch up on events its
  // live relay lost. Authenticated via HMAC-SHA256 signature, same as /relay.
  // Rows are served in (mutated_at, id) order; `afterId` continues after a row
  // (keyset), and `checkpointId` names the last row read. See
  // docs/systems/federation.md, "Sync Endpoint".
  app.post<{ Body: FederationSyncRequest }>(
    '/api/federation/sync',
    { bodyLimit: 1024 * 64 },
    async (request, reply) => {
      const db = getDb();

      // Shared inbound S2S-auth preamble: headers → active peer → signature →
      // nonce replay. No rate limiter; warns (with the ` [sync]` tag) on a legacy
      // peer's missing nonce.
      const auth = authenticateS2SPeer(request, reply, { logMissingNonce: true, logContext: 'sync' });
      if (!auth.ok) return;
      const { peer } = auth;

      // Ratchet: mark peer as nonce-supporting if this is the first nonce we've seen
      if (auth.nonce && !peer.nonceSupported) {
        db.update(schema.federationPeers)
          .set({ nonceSupported: 1 })
          .where(eq(schema.federationPeers.id, peer.id))
          .run();
      }

      // Validate & normalize request body
      const body = request.body;
      if (!body || typeof body.sinceTimestamp !== 'number' || body.sinceTimestamp < 0) {
        return reply.code(400).send({ error: 'sinceTimestamp must be a non-negative number', statusCode: 400 });
      }

      const after: SyncPosition = {
        ts: body.sinceTimestamp,
        id: typeof body.afterId === 'string' && body.afterId.length > 0 ? body.afterId : null,
      };
      const dmChannelIdFilter = body.dmChannelId && typeof body.dmChannelId === 'string' ? body.dmChannelId : null;
      const federatedIdFilter = body.federatedId && typeof body.federatedId === 'string' ? body.federatedId : null;
      const contextType = body.contextType === 'friend' || body.contextType === 'profile' ? body.contextType : 'dm';

      // Clamp limit: min 1, max 500, default 100
      let limit = typeof body.limit === 'number' ? body.limit : 100;
      limit = Math.max(1, Math.min(500, Math.floor(limit)));

      // What this page serves may already sit in our outbox for the peer.
      markOutboxOfferedForPeer(peer.id, Date.now(), contextType);

      const syncResponse: FederationSyncResponse = await buildSyncResponse(
        peer.origin,
        { contextType, dmChannelId: dmChannelIdFilter, federatedId: federatedIdFilter },
        after,
        limit,
      );

      // Update peer last-seen timestamp
      db.update(schema.federationPeers)
        .set({ lastSeenAt: Date.now() })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();

      return reply.code(200).send(syncResponse);
    },
  );

}
