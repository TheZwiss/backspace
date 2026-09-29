import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors';
import { hasPermission, isBanned, isSpaceOwner, PermissionBits } from '../utils/permissions.js';
import { canActOnMemberInSpace } from '../utils/roleHierarchy.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { connectionManager } from '../ws/handler.js';

export function spaceBanRoutes(app: FastifyInstance): void {
  // GET /api/spaces/:id/bans - List bans
  app.get<{ Params: { id: string } }>('/api/spaces/:id/bans', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.BAN_MEMBERS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'BAN_MEMBERS' });
    }

    const banRows = db.select().from(schema.bans)
      .where(eq(schema.bans.spaceId, id))
      .all();

    if (banRows.length === 0) return reply.code(200).send([]);

    const userIds = [...new Set(banRows.map(b => b.userId))];
    const bannedByIds = [...new Set(banRows.map(b => b.bannedBy))];
    const allUserIds = [...new Set([...userIds, ...bannedByIds].filter((id): id is string => id !== null))];
    const users = allUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, allUserIds)).all()
      : [];
    const userMap = new Map(users.map(u => [u.id, u]));

    const bans = banRows.map(b => {
      const user = userMap.get(b.userId);
      const moderator = b.bannedBy ? userMap.get(b.bannedBy) : undefined;
      return {
        spaceId: b.spaceId,
        userId: b.userId,
        reason: b.reason,
        bannedBy: b.bannedBy,
        createdAt: b.createdAt,
        user: user ? sanitizeUser(user) : null,
        moderator: moderator ? sanitizeUser(moderator) : null,
      };
    });

    return reply.code(200).send(bans);
  });

  // POST /api/spaces/:id/bans - Ban a member
  app.post<{ Params: { id: string }; Body: { userId: string; reason?: string } }>('/api/spaces/:id/bans', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { userId: targetId, reason } = request.body;
    const db = getDb();

    if (!targetId || typeof targetId !== 'string') {
      return sendError(reply, 400, 'user_id_required');
    }

    if (!hasPermission(request.userId, id, PermissionBits.BAN_MEMBERS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'BAN_MEMBERS' });
    }

    // Cannot ban the space owner
    if (isSpaceOwner(id, targetId)) {
      return sendError(reply, 400, 'cannot_target_owner');
    }

    // Cannot ban yourself
    if (targetId === request.userId) {
      return sendError(reply, 400, 'cannot_target_self');
    }

    // Banning needs a higher top role than the target's
    if (!canActOnMemberInSpace(id, request.userId, targetId)) {
      return sendError(reply, 403, 'role_hierarchy');
    }

    // Check if already banned
    if (isBanned(id, targetId)) {
      return sendError(reply, 409, 'already_banned');
    }

    const now = Date.now();

    // Fetch channel IDs before the transaction for read_states cleanup
    const banChannelIds = db.select({ id: schema.channels.id })
      .from(schema.channels).where(eq(schema.channels.spaceId, id)).all().map(c => c.id);

    db.transaction((tx) => {
      // Insert ban record
      tx.insert(schema.bans).values({
        spaceId: id,
        userId: targetId,
        reason: reason?.trim() || null,
        bannedBy: request.userId,
        createdAt: now,
      }).run();

      // Remove member from space
      tx.delete(schema.spaceMembers).where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, targetId),
      )).run();

      // Remove member's role assignments
      tx.delete(schema.memberRoles).where(and(
        eq(schema.memberRoles.spaceId, id),
        eq(schema.memberRoles.userId, targetId),
      )).run();

      // Clean up read_states for the banned user in this space's channels
      if (banChannelIds.length > 0) {
        tx.delete(schema.readStates).where(and(
          eq(schema.readStates.userId, targetId),
          inArray(schema.readStates.channelId, banChannelIds),
        )).run();
      }

      // Clean up any voice restrictions for the banned member
      tx.delete(schema.voiceRestrictions).where(and(
        eq(schema.voiceRestrictions.spaceId, id),
        eq(schema.voiceRestrictions.userId, targetId),
      )).run();
    });

    // Broadcast member_left event so other clients update their member list
    connectionManager.sendToSpace(id, {
      type: 'member_left',
      spaceId: id,
      userId: targetId,
    });

    // Notify the banned user
    connectionManager.sendToUser(targetId, {
      type: 'member_banned',
      spaceId: id,
      reason: reason?.trim() || null,
    });

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/spaces/:id/bans/:uid - Unban a user
  app.delete<{ Params: { id: string; uid: string } }>('/api/spaces/:id/bans/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.BAN_MEMBERS)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'BAN_MEMBERS' });
    }

    const result = db.delete(schema.bans).where(and(
      eq(schema.bans.spaceId, id),
      eq(schema.bans.userId, uid),
    )).run();

    if (result.changes === 0) {
      return sendError(reply, 404, 'ban_not_found');
    }

    return reply.code(200).send({ success: true });
  });
}
