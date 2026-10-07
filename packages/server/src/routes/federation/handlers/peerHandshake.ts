import path from 'node:path';
import { getDb, schema } from '../../../db/index.js';
import { authenticate, requireAdmin } from '../../../utils/auth.js';
import { parseFederationHeaders, verifyPeerSignature } from '../../../utils/federationAuth.js';
import { getInstanceId } from '../../../utils/federationEpoch.js';
import { markPeerReset } from '../../../utils/federationReset.js';
import { claimAdminHandshake, isHandshakeInFlight, releaseAdminHandshake } from '../../../utils/federationPeering.js';
import { decideInboundHandshake, insertPeer, transitionPeer } from '../../../utils/federationPeerState.js';
import { prepareAdminHandshakeRow, runOutboundHandshake } from '../../../utils/federationHandshake.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { queueApprovalRequest } from './approvals.js';
import { resolveLocalOrigin, sanitizePeer, validateOrigin } from '../origin.js';
import { isAcceptRateLimited, isEnsureRateLimited } from '../rateLimits.js';
import { federationFetch } from '../../../utils/federationFetch.js';
import { sendError } from '../../../utils/httpErrors.js';
import { PEER_ENSURE_REASONS, type PeerEnsureReason } from '@backspace/shared';

/**
 * The reason a `/peer/ensure` request states, or `null` when it states one a
 * client may not. A request with no reason comes from a client that predates
 * the field, and those only ever called the endpoint when opening a session
 * on a remote, so it reads as `instance_connect`.
 */
function parsePeerEnsureReason(raw: unknown): PeerEnsureReason | null {
  if (raw === undefined) return 'instance_connect';
  return PEER_ENSURE_REASONS.find((reason) => reason === raw) ?? null;
}

/**
 * The target the admin's approval queue shows for a reason a client stated.
 * Derived here and never read from the request, so the queue only shows what
 * this instance can vouch for.
 */
function peerEnsureTarget(reason: PeerEnsureReason, remoteOrigin: string): string {
  switch (reason) {
    case 'instance_connect':
      return remoteOrigin;
  }
}

/** The full peer row, for the API's sanitized view. */
function readPeerRow(peerId: string): typeof schema.federationPeers.$inferSelect | null {
  return getDb().select().from(schema.federationPeers).where(eq(schema.federationPeers.id, peerId)).get() ?? null;
}

export function registerPeerHandshakeRoutes(app: FastifyInstance): void {
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

      let localOrigin: string;
      try {
        localOrigin = resolveLocalOrigin();
      } catch {
        return reply.code(500).send({
          error: 'Cannot determine local instance origin. Set the DOMAIN environment variable.',
          statusCode: 500,
        });
      }
      if (localOrigin === remoteOrigin) {
        return reply.code(400).send({ error: 'Cannot peer with yourself', statusCode: 400 });
      }

      // One handshake per origin: an exchange already running (ensurePeered for
      // local traffic, or another admin request) settles the row itself, and a
      // second /peer/accept would race it on the remote.
      if (!claimAdminHandshake(remoteOrigin)) {
        return reply.code(409).send({
          error: 'A peering handshake with this instance is already in progress',
          statusCode: 409,
        });
      }

      try {
        const startedAt = Date.now();
        const prepared = prepareAdminHandshakeRow(remoteOrigin, 'initiate');
        if (prepared.kind === 'already_active') {
          const peer = readPeerRow(prepared.peerId);
          return peer
            ? reply.code(200).send({ peer: sanitizePeer(peer) })
            : reply.code(409).send({ error: 'The peer changed; try again', statusCode: 409 });
        }
        if (prepared.kind === 'busy') {
          return reply.code(409).send({ error: prepared.error, statusCode: 409 });
        }

        // 'approved': remoteOrigin is the body of an admin-authenticated
        // request on this route, so a private peer address is allowed.
        const outcome = await runOutboundHandshake({
          peerId: prepared.peerId,
          origin: remoteOrigin,
          hmacSecret: prepared.hmacSecret,
          trust: 'approved',
          activation: 'initiate_accepted',
          startedAt,
          onFailure: prepared.onFailure,
        });
        const peer = outcome.peerId ? readPeerRow(outcome.peerId) : null;
        const sanitized = peer ? sanitizePeer(peer) : null;

        switch (outcome.kind) {
          case 'active':
            return reply.code(200).send({ peer: sanitized, ...(outcome.verified ? { verified: true } : {}) });
          case 'needs_attention':
            return reply.code(200).send({ peer: sanitized, verified: false });
          case 'awaiting_approval':
            return reply.code(202).send({ peer: sanitized });
          case 'rejected':
            if (outcome.reason === 'stale_peering_on_remote') {
              return reply.code(409).send({
                error: 'The remote instance still holds stale peering for you. Ask its admin to reset (or Re-peer) their side; this instance checks every 15 minutes and completes the peering once they have.',
                code: 'PEER_EXISTS_RESET_REQUIRED',
                statusCode: 409,
                peer: sanitized,
              });
            }
            return reply.code(502).send({ error: outcome.error, statusCode: 502, peer: sanitized });
          case 'revoked':
            return reply.code(409).send({ error: 'This peer was revoked meanwhile', statusCode: 409 });
          case 'failed':
            return reply.code(outcome.timedOut ? 504 : 502).send({ error: outcome.error, statusCode: outcome.timedOut ? 504 : 502 });
        }
      } finally {
        releaseAdminHandshake(remoteOrigin);
      }
    },
  );

  // ─── POST /api/federation/peer/accept ──────────────────────────────────────
  // Server-to-server: accept a peering request from a remote instance.
  // No JWT auth: this is first contact. Rate-limited by IP. What it answers
  // for each state of our row is decideInboundHandshake's table
  // (docs/systems/federation.md, "Answering a handshake").
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
      const autoAccept = (settings?.autoAcceptPeering ?? 1) === 1;

      const existing = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, sourceOrigin))
        .get() ?? null;

      const decision = decideInboundHandshake({
        row: existing,
        autoAccept,
        inboundToken,
        ownHandshakeInFlight: isHandshakeInFlight(sourceOrigin),
        ourOrigin: resolveLocalOrigin(),
        sourceOrigin,
      });

      const accepted = { accepted: true, instanceName: ourInstanceName, instanceId: ourInstanceId };
      const theirs = {
        hmacSecret,
        instanceName: reqInstanceName ?? null,
        peerInstanceId: reqInstanceId ?? null,
        lastSeenAt: Date.now(),
        approvalToken: null,
      };

      switch (decision.kind) {
        case 'create': {
          const inserted = insertPeer({
            origin: sourceOrigin,
            hmacSecret,
            instanceName: reqInstanceName ?? null,
            peerInstanceId: reqInstanceId ?? null,
            lastSeenAt: Date.now(),
            initiatedBy: 'remote',
            status: 'active',
            cause: 'accept_new',
          });
          if (!inserted) {
            return reply.code(409).send({ error: 'A peering handshake with this instance is already in progress', code: 'PEER_HANDSHAKE_IN_PROGRESS', statusCode: 409 });
          }
          return reply.code(200).send(accepted);
        }

        case 'activate': {
          if (!existing) return reply.code(500).send({ error: 'Peer row missing', statusCode: 500 });
          const outcome = transitionPeer(existing.id, {
            from: [decision.from],
            expectSecret: existing.hmacSecret,
            to: 'active',
            cause: decision.cause,
            fields: theirs,
          });
          if (!outcome.applied) {
            return reply.code(409).send({ error: 'A peering handshake with this instance is already in progress', code: 'PEER_HANDSHAKE_IN_PROGRESS', statusCode: 409 });
          }
          if (decision.from === 'awaiting_approval') {
            // Debris from an earlier unverifiable attempt that was queued.
            db.delete(schema.peerApprovalRequests)
              .where(eq(schema.peerApprovalRequests.origin, sourceOrigin))
              .run();
          }
          return reply.code(200).send(accepted);
        }

        case 'queue':
          return queueApprovalRequest(db, reply, sourceOrigin, hmacSecret, reqInstanceName ?? null);

        case 'refuse_exists':
          // We hold an established peering for the caller (active, unreachable
          // or needs_attention) and do not adopt a secret from an unauthenticated
          // request over it. Reported honestly (409) so the initiator never
          // activates on a secret we did not take. Detection only: a different
          // epoch means a new incarnation on that domain (markPeerReset routes
          // the row to needs_attention and journals it; it never re-keys).
          if (existing && reqInstanceId && existing.peerInstanceId && reqInstanceId !== existing.peerInstanceId) {
            markPeerReset(existing.id, sourceOrigin, existing.peerInstanceId, reqInstanceId);
          }
          return reply.code(409).send({
            accepted: false,
            code: 'PEER_EXISTS_RESET_REQUIRED',
            error: 'This instance already holds peering for you; its admin must reset that peering before a new handshake can be accepted.',
            instanceName: ourInstanceName,
            instanceId: ourInstanceId,
            statusCode: 409,
          });

        case 'refuse_revoked':
          // The error text is what releases before PEER_REVOKED match on.
          return reply.code(403).send({
            error: 'Peering with this instance has been revoked',
            code: 'PEER_REVOKED',
            statusCode: 403,
          });

        case 'refuse_denied':
          return reply.code(403).send({
            error: 'This instance requires manual peering approval',
            code: 'PEERING_REQUIRES_APPROVAL',
            statusCode: 403,
          });

        case 'refuse_in_progress':
          // Both sides are handshaking at once and ours wins (the lower origin's
          // does, on both sides). Our /peer/accept on the remote settles both rows.
          return reply.code(409).send({
            error: 'This instance is completing its own peering handshake with you',
            code: 'PEER_HANDSHAKE_IN_PROGRESS',
            statusCode: 409,
          });
      }
    },
  );

  // ─── POST /api/federation/peer/ensure ──────────────────────────────────────
  // JWT-authenticated (any user): trigger auto-peering with a remote instance.
  // Rate-limited per user (3 requests per 15 minutes) when the call can start a
  // handshake; confirming a settled peering is not counted.
  app.post<{ Body: { remoteOrigin?: unknown; reason?: unknown } }>(
    '/api/federation/peer/ensure',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { remoteOrigin: rawOrigin, reason: rawReason } = request.body ?? {};
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

      const reason = parsePeerEnsureReason(rawReason);
      if (!reason) {
        return sendError(reply, 400, 'validation_failed');
      }

      const { ensurePeered, settledPeeringResult } = await import('../../../utils/federationPeering.js');

      // The limit bounds handshakes a user can make this instance start. A
      // client asks on every session it opens, including one per connection
      // at app start, so confirming a peering that already exists (no network,
      // no writes) must not use up the allowance a new connection needs.
      if (!settledPeeringResult(remoteOrigin) && isEnsureRateLimited(request.userId)) {
        return reply.code(429).send({
          error: 'Too many peering requests — try again later',
          statusCode: 429,
        });
      }

      // The reason is what the local admin's approval queue and the user's
      // pending list show when the outbound gate fires. It is the caller's
      // stated reason, checked against PEER_ENSURE_REASONS; a new client
      // caller adds its reason there and its target to peerEnsureTarget.
      const result = await ensurePeered(remoteOrigin, {
        kind: 'user_action',
        userId: request.userId,
        reason,
        target: peerEnsureTarget(reason, remoteOrigin),
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
  // NON-ADOPTER of authenticateS2SPeer (deliberate): active-only like the helper
  // but runs NO nonce replay check (the rotation body is its own replay unit);
  // sharing the helper would add a nonce gate this endpoint never had.
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
  // NON-ADOPTER of authenticateS2SPeer (deliberate): gates on 'awaiting_approval'
  // (404 on no peer row, 409 on wrong status — not the helper's active-only 403),
  // verifies against a SYNTHETIC no-grace secret object, and runs no nonce check.
  // Entirely different control flow.
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

      const { reason } = request.body;

      // The remote's admin refused our request (or it expired unanswered).
      // Entering rejected purges the outbox and tells the affected users.
      transitionPeer(peer.id, {
        from: ['awaiting_approval'],
        to: 'rejected',
        reason: reason === 'expired' ? 'expired_on_remote' : 'denied_by_remote',
        cause: 'remote_denied_request',
      });

      return reply.code(200).send({ acknowledged: true });
    },
  );

}
