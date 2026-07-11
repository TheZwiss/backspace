import path from 'node:path';
import { getDb, schema } from '../../../db/index.js';
import { authenticate, requireAdmin } from '../../../utils/auth.js';
import { generateHmacSecret, parseFederationHeaders, verifyPeerSignature } from '../../../utils/federationAuth.js';
import { fetchPeerEpoch, getInstanceId } from '../../../utils/federationEpoch.js';
import { onPeerActivated } from '../../../utils/federationPeerActivation.js';
import { markPeerReset } from '../../../utils/federationReset.js';
import { generateSnowflake } from '../../../utils/snowflake.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { queueApprovalRequest } from './approvals.js';
import { resolveLocalOrigin, sanitizePeer, validateOrigin } from '../origin.js';
import { isAcceptRateLimited, isEnsureRateLimited } from '../rateLimits.js';

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
        if (existing.status === 'awaiting_approval') {
          return reply.code(409).send({
            error: "A peering handshake with this instance is awaiting the remote admin's approval",
            statusCode: 409,
          });
        }
        // Every remaining terminal/parked state is safe to clear and re-initiate
        // from — falling through here (rather than to the db.insert below) is what
        // keeps this route from violating UNIQUE(origin) and 500-ing.
        //  - revoked: local admin revoked; re-initiate cleanly.
        //  - rejected: a prior attempt was rejected; allow the local admin's
        //    authenticated retry (mirrors revoked).
        //  - needs_attention: this IS the one-click Re-peer step (resetPeer +
        //    initiate). Deleting the row here is equivalent to the documented
        //    reset: the reset-heal snapshot lives on users.federation_heal_pending
        //    (not the peer row) and the federation_reset_events journal is designed
        //    to survive peer-row deletion (design §4.2/§6.1), and onPeerActivated
        //    after the fresh handshake re-triggers the heal — so no recovery state
        //    is lost by removing the local needs_attention peer row here.
        if (
          existing.status === 'revoked' ||
          existing.status === 'rejected' ||
          existing.status === 'needs_attention'
        ) {
          db.delete(schema.federationPeers).where(eq(schema.federationPeers.id, existing.id)).run();
        }
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
          // Read the body exactly ONCE here — response.json()/text() consumes the
          // stream, so both the honest-409 branch and the generic branch below
          // share this single parse (no double-read of the same Response).
          const rawBody = await response.text().catch(() => '');
          let parsed: { error?: string; code?: string } = {};
          try { parsed = JSON.parse(rawBody) as { error?: string; code?: string }; } catch { /* non-JSON body */ }

          // Responder honestly refused: it already holds peering for us and will
          // not rekey (anti-hijack). Do NOT create a conflicting row — delete the
          // pending row so our slot stays clean and the remote's own later Re-peer
          // can land on a fresh responder slot. Surface an actionable reason.
          if (response.status === 409 && parsed.code === 'PEER_EXISTS_RESET_REQUIRED') {
            db.delete(schema.federationPeers).where(eq(schema.federationPeers.id, peerId)).run();
            return reply.code(409).send({
              error: 'The remote instance still holds stale peering for you. Ask its admin to reset (or Re-peer) their side, then try again.',
              code: 'PEER_EXISTS_RESET_REQUIRED',
              statusCode: 409,
            });
          }

          const errorMessage = parsed.error || `Remote instance rejected peering (HTTP ${response.status})`;
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

        // The responder returned 200 → it claims it adopted our secret. PROVE it
        // with a signed round-trip before trusting the peering (catches BUG-1: a
        // responder that reported success without adopting, and any residual
        // desync). fetchPeerEpoch signs with the just-negotiated secret; a desync
        // → 401/403 → null. Park the peer in needs_attention instead of falsely
        // activating so the admin sees "re-peer incomplete", not a dead-active row.
        const verifiedEpoch = await fetchPeerEpoch({ origin: remoteOrigin, hmacSecret });
        if (!verifiedEpoch) {
          db.update(schema.federationPeers)
            .set({ status: 'needs_attention', needsAttentionReason: 'repeer_incomplete', lastSeenAt: Date.now() })
            .where(eq(schema.federationPeers.id, peerId))
            .run();
          connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });
          const parked = db.select().from(schema.federationPeers).where(eq(schema.federationPeers.id, peerId)).get();
          return reply.code(200).send({ peer: parked ? sanitizePeer(parked) : null, verified: false });
        }

        db.update(schema.federationPeers)
          // The baseline is trust-consequential (design §9 — a poisoned baseline can drive
          // a spurious heal), so store the epoch we cryptographically verified via the signed
          // /epoch round-trip, not the unverified handshake-response body. They are normally
          // identical; the verified one is authoritative if they ever differ.
          .set({ status: 'active', lastSeenAt: Date.now(), instanceName: remoteInstanceName, peerInstanceId: verifiedEpoch, needsAttentionReason: null, approvalToken: null })
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

        return reply.code(200).send({ peer: sanitizePeer(peer), verified: true });
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
          // journal — but STILL return 409 (PEER_EXISTS_RESET_REQUIRED) and
          // STILL do not rekey. The anti-hijack guard above is preserved
          // verbatim; detection never grants capability.
          if (reqInstanceId && existing.peerInstanceId && reqInstanceId !== existing.peerInstanceId) {
            markPeerReset(existing.id, sourceOrigin, existing.peerInstanceId, reqInstanceId);
          }
          // Anti-hijack: we did NOT adopt the caller's secret. Report that
          // honestly (409) instead of a false success (was 200 {accepted:true}),
          // so the initiator does not false-activate into a permanent HMAC
          // desync. Legacy initiators read only response.ok → they fail loudly
          // (never a silent desync); new initiators special-case this code.
          return reply.code(409).send({
            accepted: false,
            code: 'PEER_EXISTS_RESET_REQUIRED',
            error: 'This instance already holds peering for you; its admin must reset that peering before a new handshake can be accepted.',
            instanceName: ourInstanceName,
            instanceId: ourInstanceId,
            statusCode: 409,
          });
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

      const { ensurePeered } = await import('../../../utils/federationPeering.js');
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
        const { pushPeerRejectedEvent } = await import('../../../utils/federationWorker.js');
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

}
