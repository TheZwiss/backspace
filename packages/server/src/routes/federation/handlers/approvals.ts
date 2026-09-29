import path from 'node:path';
import { getDb, schema } from '../../../db/index.js';
import { authenticate, requireAdmin } from '../../../utils/auth.js';
import { buildFederationHeaders, getOurOrigin } from '../../../utils/federationAuth.js';
import { claimAdminHandshake, releaseAdminHandshake } from '../../../utils/federationPeering.js';
import { insertPeer, readPeerStateByOrigin, transitionPeer } from '../../../utils/federationPeerState.js';
import { prepareAdminHandshakeRow, runOutboundHandshake, type HandshakeOutcome } from '../../../utils/federationHandshake.js';
import { generateSnowflake } from '../../../utils/snowflake.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { ApprovalRequestSubscriberSummary, PeeringTriggerReason } from '@backspace/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sanitizePeer } from '../origin.js';
import { federationFetch } from '../../../utils/federationFetch.js';

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


/** The full peer row, for the API's sanitized view. */
function readPeerRow(peerId: string | null): typeof schema.federationPeers.$inferSelect | null {
  if (!peerId) return null;
  return getDb().select().from(schema.federationPeers).where(eq(schema.federationPeers.id, peerId)).get() ?? null;
}

/**
 * Run the handshake an approval authorizes: claim the origin, prepare the row
 * (`prepareAdminHandshakeRow`), send /peer/accept (forwarding the remote's
 * approval token for an inbound request), and settle the row from the answer.
 * Returns the outcome, or a reply already sent when the origin is busy.
 */
async function runApprovalHandshake(
  approvalReq: typeof schema.peerApprovalRequests.$inferSelect,
  reply: FastifyReply,
): Promise<HandshakeOutcome | FastifyReply> {
  if (!claimAdminHandshake(approvalReq.origin)) {
    return reply.code(409).send({ error: 'A peering handshake with this instance is already in progress', statusCode: 409 });
  }
  try {
    const startedAt = Date.now();
    const prepared = prepareAdminHandshakeRow(approvalReq.origin, 'approve', approvalReq.instanceName);
    if (prepared.kind === 'busy') {
      return reply.code(409).send({ error: prepared.error, statusCode: 409 });
    }
    if (prepared.kind === 'already_active') {
      return { kind: 'active', peerId: prepared.peerId, verified: false };
    }
    // 'asserted': an approval request's origin came from the remote's own
    // /peer/accept body (inbound) or from a handle a local user typed
    // (outbound). The admin approves the request, but no outbound request to
    // that origin has been vetted before now.
    return await runOutboundHandshake({
      peerId: prepared.peerId,
      origin: approvalReq.origin,
      hmacSecret: prepared.hmacSecret,
      // Forward the token our 202 issued when the remote first asked (inbound
      // only), so the remote can verify mutual admin approval. Spec §3.7.
      approvalToken: approvalReq.direction === 'inbound' ? approvalReq.approvalToken : null,
      trust: 'asserted',
      activation: 'approval_handshake',
      startedAt,
      onFailure: prepared.created ? 'remove_unless_queued' : 'release_to_traffic',
    });
  } finally {
    releaseAdminHandshake(approvalReq.origin);
  }
}

/**
 * The reply for an approval handshake that did not complete. An unreachable
 * remote is 503 on the outbound path and 502 on the inbound one (their
 * established shapes); a remote that answered carries its status as
 * `remoteStatus`.
 */
function failureReply(
  reply: FastifyReply,
  outcome: Exclude<HandshakeOutcome, { kind: 'active' | 'awaiting_approval' }>,
  direction: 'inbound' | 'outbound',
): FastifyReply {
  switch (outcome.kind) {
    case 'failed': {
      const code = outcome.timedOut ? 504 : outcome.httpStatus === null && direction === 'outbound' ? 503 : 502;
      return reply.code(code).send({
        error: outcome.error,
        statusCode: code,
        ...(outcome.httpStatus !== null ? { remoteStatus: outcome.httpStatus } : {}),
      });
    }
    case 'rejected':
      return reply.code(502).send({ error: outcome.error, statusCode: 502, peer: sanitizeOrUndefined(outcome.peerId) });
    case 'needs_attention':
      return reply.code(502).send({
        error: 'The remote accepted, but the new peering could not be verified; the peer needs attention',
        statusCode: 502,
        peer: sanitizeOrUndefined(outcome.peerId),
      });
    case 'revoked':
      return reply.code(409).send({ error: 'This peer was revoked meanwhile', statusCode: 409 });
  }
}

function sanitizeOrUndefined(peerId: string | null): ReturnType<typeof sanitizePeer> | undefined {
  const row = readPeerRow(peerId);
  return row ? sanitizePeer(row) : undefined;
}

/**
 * Inbound approve: admin accepts a remote instance's peering request. The
 * request row is deleted once the handshake reached the remote (200 or 202);
 * on a failure it stays so the admin can retry.
 */
export async function handleInboundApprove(
  approvalReq: typeof schema.peerApprovalRequests.$inferSelect,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const outcome = await runApprovalHandshake(approvalReq, reply);
  if (!('kind' in outcome)) return outcome;

  const deleteRequest = (): void => {
    getDb().delete(schema.peerApprovalRequests)
      .where(eq(schema.peerApprovalRequests.id, approvalReq.id))
      .run();
  };

  if (outcome.kind === 'active') {
    deleteRequest();
    return reply.code(200).send({ success: true, peer: sanitizeOrUndefined(outcome.peerId) });
  }
  if (outcome.kind === 'awaiting_approval') {
    // The remote also has auto-accept off and queued our request.
    deleteRequest();
    return reply.code(200).send({
      success: true,
      awaitingRemoteApproval: true,
      message: 'Remote instance also requires admin approval. Your request has been queued on their side.',
    });
  }
  return failureReply(reply, outcome, 'inbound');
}

/**
 * Outbound approve — admin authorizes the local instance to peer with a
 * remote that one or more of its users have requested.
 *   - active → `onPeerActivated` fans out approved-notifications to the
 *     outbound subscribers and deletes the queue row. The handler does not
 *     duplicate that cleanup.
 *   - awaiting_approval → the remote also gates; the queue row and its
 *     subscribers stay until the eventual activation fans out.
 *   - failure → the queue row stays so the admin can retry.
 */
export async function handleOutboundApprove(
  approvalReq: typeof schema.peerApprovalRequests.$inferSelect,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const outcome = await runApprovalHandshake(approvalReq, reply);
  if (!('kind' in outcome)) return outcome;

  if (outcome.kind === 'active') {
    return reply.code(200).send({
      success: true,
      peerStatus: 'active' as const,
      peer: sanitizeOrUndefined(outcome.peerId),
    });
  }
  if (outcome.kind === 'awaiting_approval') {
    return reply.code(200).send({
      success: true,
      peerStatus: 'awaiting_approval' as const,
      awaitingRemoteApproval: true,
      message: 'Remote instance also requires admin approval. Your request has been queued on their side.',
      peer: sanitizeOrUndefined(outcome.peerId),
    });
  }
  return failureReply(reply, outcome, 'outbound');
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
    // 'asserted': same row, same provenance as the approve path above.
    const response = await federationFetch(approvalReq.origin, '/api/federation/peer/denied', {
      method: 'POST',
      headers,
      body: denialBody,
      signal: AbortSignal.timeout(10_000),
    }, 'asserted');
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

  // Record our admin's refusal. It keeps the origin blocked (403
  // PEERING_REQUIRES_APPROVAL) until an admin clears it, whatever the
  // auto-accept setting. An established peering, or a revoked one, is left as
  // it is: those answer the origin's handshakes already.
  const existingPeer = readPeerStateByOrigin(approvalReq.origin);
  if (!existingPeer) {
    insertPeer({
      origin: approvalReq.origin,
      instanceName: approvalReq.instanceName,
      hmacSecret: approvalReq.hmacSecret,
      initiatedBy: 'admin',
      status: 'rejected',
      reason: 'denied_by_local_admin',
    });
  } else {
    transitionPeer(existingPeer.id, {
      from: ['pending', 'awaiting_approval', 'rejected'],
      to: 'rejected',
      reason: 'denied_by_local_admin',
      cause: 'local_admin_denied',
    });
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

      if (approvalReq.direction === 'outbound') {
        return await handleOutboundApprove(approvalReq, reply);
      }

      return await handleInboundApprove(approvalReq, reply);
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
