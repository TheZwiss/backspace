import path from 'node:path';
import { getDb, schema } from '../../../db/index.js';
import { authenticate, requireAdmin } from '../../../utils/auth.js';
import { buildFederationHeaders, generateHmacSecret, getOurOrigin } from '../../../utils/federationAuth.js';
import { getInstanceId } from '../../../utils/federationEpoch.js';
import { onPeerActivated } from '../../../utils/federationPeerActivation.js';
import { generateSnowflake } from '../../../utils/snowflake.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { ApprovalRequestSubscriberSummary, PeeringTriggerReason } from '@backspace/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { resolveLocalOrigin, sanitizePeer } from '../origin.js';

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
export function queueApprovalRequest(
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
export async function handleInboundApprove(
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
export async function handleOutboundApprove(
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
export async function handleInboundDeny(
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
export async function handleOutboundDeny(
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


export function registerApprovalRoutes(app: FastifyInstance): void {
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
        localOrigin = resolveLocalOrigin();
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

}
