import type { JoinSpaceRequest, MemberWithUser } from '@backspace/shared';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors';
import { hasPermission, isBanned, isMember, PermissionBits } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { getLocalInviteSnapshot } from '../utils/spaceInviteSnapshot.js';
import { connectionManager } from '../ws/handler.js';
import { rowToSpace } from './spaceSerialization.js';

export function spaceInviteRoutes(app: FastifyInstance): void {
  // POST /api/spaces/:id/invite - Generate invite code (admin+)
  app.post<{ Params: { id: string } }>('/api/spaces/:id/invite', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!hasPermission(request.userId, id, PermissionBits.CREATE_INVITE)) {
      // Owners and instance admins always pass hasPermission, so anyone who lands
      // here is either a non-member or a member without CREATE_INVITE. Give the
      // non-member a clearer "go join first" message instead of a permission error.
      if (!isMember(id, request.userId)) {
        return sendError(reply, 403, 'not_space_member');
      }
      return sendError(reply, 403, 'missing_permission', { permission: 'CREATE_INVITE' });
    }

    // Request-only spaces are approval-gated and never joinable by invite code
    // (see the join endpoints), so they have no usable invite links. Refuse to
    // hand one out rather than mint a code that would dead-end at the join guard.
    if (server.visibility === 'request') {
      return sendError(reply, 403, 'space_uses_join_requests');
    }

    // Return existing invite code if one exists, otherwise generate a new one
    if (server.inviteCode) {
      return reply.code(200).send({ inviteCode: server.inviteCode });
    }

    const inviteCode = crypto.randomBytes(4).toString('hex');
    db.update(schema.spaces).set({ inviteCode }).where(eq(schema.spaces.id, id)).run();

    return reply.code(200).send({ inviteCode });
  });

  // POST /api/spaces/:id/join - Join server by invite code
  app.post<{ Params: { id: string }; Body: JoinSpaceRequest }>('/api/spaces/:id/join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { inviteCode } = request.body;

    if (!inviteCode || typeof inviteCode !== 'string') {
      return sendError(reply, 400, 'invite_code_required');
    }

    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (server.inviteCode !== inviteCode) {
      return sendError(reply, 400, 'invite_not_found');
    }

    if (isBanned(id, request.userId)) {
      return sendError(reply, 403, 'user_banned');
    }

    if (isMember(id, request.userId)) {
      return sendError(reply, 409, 'already_member');
    }

    // Request-only spaces are gated by manager approval: entry must go through
    // POST /request-join + approval, never a bearer invite code. (Private spaces
    // remain invite-joinable — that is their only entry path; public too.)
    if (server.visibility === 'request') {
      return sendError(reply, 403, 'join_request_required');
    }

    const now = Date.now();
    db.insert(schema.spaceMembers).values({
      spaceId: id,
      userId: request.userId,
      joinedAt: now,
    }).run();

    // Register the user in connectionManager so they receive WS broadcasts for this server
    connectionManager.addUserSpace(request.userId, id);

    // Broadcast member_joined to existing server members
    const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (joiningUser) {
      const memberPayload: MemberWithUser = {
        spaceId: id,
        userId: request.userId,
        nickname: null,
        joinedAt: now,
        user: sanitizeUser(joiningUser),
        roles: [],
      };
      connectionManager.sendToSpace(id, {
        type: 'member_joined',
        spaceId: id,
        member: memberPayload,
      });
    }

    return reply.code(200).send(rowToSpace(server));
  });

  // POST /api/spaces/join - Join server by invite code (no server ID needed)
  app.post<{ Body: JoinSpaceRequest }>('/api/spaces/join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { inviteCode } = request.body;

    if (!inviteCode || typeof inviteCode !== 'string') {
      return sendError(reply, 400, 'invite_code_required');
    }

    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.inviteCode, inviteCode)).get();
    if (!server) {
      return sendError(reply, 404, 'invite_not_found');
    }

    if (isBanned(server.id, request.userId)) {
      return sendError(reply, 403, 'user_banned');
    }

    if (isMember(server.id, request.userId)) {
      return sendError(reply, 409, 'already_member');
    }

    // Request-only spaces are gated by manager approval (see POST /:id/join).
    if (server.visibility === 'request') {
      return sendError(reply, 403, 'join_request_required');
    }

    const now = Date.now();
    db.insert(schema.spaceMembers).values({
      spaceId: server.id,
      userId: request.userId,
      joinedAt: now,
    }).run();

    // Register the user in connectionManager so they receive WS broadcasts for this server
    connectionManager.addUserSpace(request.userId, server.id);

    // Broadcast member_joined to existing server members
    const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (joiningUser) {
      const memberPayload: MemberWithUser = {
        spaceId: server.id,
        userId: request.userId,
        nickname: null,
        joinedAt: now,
        user: sanitizeUser(joiningUser),
        roles: [],
      };
      connectionManager.sendToSpace(server.id, {
        type: 'member_joined',
        spaceId: server.id,
        member: memberPayload,
      });
    }

    return reply.code(200).send(rowToSpace(server));
  });

  // GET /api/spaces/invite/:code/preview — Public invite preview (no auth)
  app.get<{ Params: { code: string } }>('/api/spaces/invite/:code/preview', async (request, reply) => {
    const { code } = request.params;
    const snapshot = getLocalInviteSnapshot(code);
    if (!snapshot) {
      return sendError(reply, 404, 'invite_not_found');
    }
    return reply.code(200).send(snapshot);
  });

  // ─── Ban Management ───────────────────────────────────────────────────────
}
