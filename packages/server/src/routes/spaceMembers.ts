import type { MemberWithUser, UpdateMemberRequest } from '@backspace/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors';
import { hasPermission, isMember, isSpaceOwner, PermissionBits } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { canActOnMember, canManageRoleAt } from '@backspace/shared/src/permissions.js';
import { canActOnMemberInSpace, getHierarchyStanding } from '../utils/roleHierarchy.js';
import { roleGrantRefusal } from './spaceRoles.js';
import { checkVoicePermissions } from '../ws/events.js';
import { connectionManager } from '../ws/handler.js';

export function listSpaceMemberRoutes(app: FastifyInstance): void {
  // GET /api/spaces/:id/members - List server members
  app.get<{ Params: { id: string } }>('/api/spaces/:id/members', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!isMember(id, request.userId)) {
      return sendError(reply, 403, 'not_space_member');
    }

    const memberRows = db.select()
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.spaceId, id))
      .all();

    const memberUserIds = memberRows.map(m => m.userId);
    const users = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const userMap = new Map(users.map(u => [u.id, u]));

    const roles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.spaceId, id))
      .orderBy(schema.roles.position)
      .all();

    const memberRoleRows = db.select()
      .from(schema.memberRoles)
      .where(eq(schema.memberRoles.spaceId, id))
      .all();

    const members: MemberWithUser[] = memberRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;

        const assignedRoleIds = memberRoleRows
          .filter(mr => mr.userId === m.userId)
          .map(mr => mr.roleId);

        const assignedRoles = roles
          .filter(r => assignedRoleIds.includes(r.id))
          .map(r => ({
            id: r.id,
            spaceId: r.spaceId,
            name: r.name,
            color: r.color ?? '#b9bbbe',
            position: r.position ?? 0,
            createdAt: r.createdAt,
          }));

        return {
          spaceId: m.spaceId,
          userId: m.userId,
          nickname: m.nickname,
          joinedAt: m.joinedAt,
          user: sanitizeUser(user),
          roles: assignedRoles,
        };
      })
      .filter((m): m is MemberWithUser => m !== null);

    return reply.code(200).send(members);
  });
}

export function updateSpaceMemberRoutes(app: FastifyInstance): void {
  // PATCH /api/spaces/:id/members/:uid - Update member roles
  app.patch<{ Params: { id: string; uid: string }; Body: UpdateMemberRequest }>('/api/spaces/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { roleIds } = request.body;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    }

    if (uid === request.userId) {
      return sendError(reply, 400, 'cannot_change_own_roles');
    }

    if (!Array.isArray(roleIds)) {
      return sendError(reply, 400, 'role_ids_invalid');
    }

    // Cannot modify the server owner's roles unless you are the owner
    if (isSpaceOwner(id, uid) && !isSpaceOwner(id, request.userId)) {
      return sendError(reply, 403, 'space_owner_only');
    }

    const member = db.select()
      .from(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .get();

    if (!member) {
      return sendError(reply, 404, 'member_not_found');
    }

    // Validate all roleIds belong to this server and are not @everyone
    const spaceRoles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.spaceId, id))
      .all();
    const spaceRolePositions = new Map(spaceRoles.map(r => [r.id, r.position ?? 0]));

    for (const roleId of roleIds) {
      if (!spaceRolePositions.has(roleId)) {
        return sendError(reply, 400, 'role_not_in_space', { roleId });
      }
      if (roleId === id) {
        return sendError(reply, 400, 'everyone_role_not_assignable');
      }
    }

    // Role hierarchy: the member must rank below the actor, and every role
    // this request adds or removes must sit below the actor's top role.
    const actorStanding = getHierarchyStanding(id, request.userId);
    if (!canActOnMember(actorStanding, getHierarchyStanding(id, uid))) {
      return sendError(reply, 403, 'role_hierarchy');
    }
    const currentRoleIds = new Set(
      db.select({ roleId: schema.memberRoles.roleId })
        .from(schema.memberRoles)
        .where(and(eq(schema.memberRoles.spaceId, id), eq(schema.memberRoles.userId, uid)))
        .all()
        .map(r => r.roleId),
    );
    const requestedRoleIds = new Set(roleIds);
    const changedRoleIds = [
      ...roleIds.filter(r => !currentRoleIds.has(r)),
      ...[...currentRoleIds].filter(r => !requestedRoleIds.has(r)),
    ];
    for (const roleId of changedRoleIds) {
      if (!canManageRoleAt(actorStanding, spaceRolePositions.get(roleId) ?? 0)) {
        return sendError(reply, 403, 'role_hierarchy');
      }
    }
    // Held-bits rule: a role this request adds must carry only bits the actor holds.
    for (const roleId of roleIds.filter(r => !currentRoleIds.has(r))) {
      const refusal = roleGrantRefusal(id, request.userId, spaceRoles.find(r => r.id === roleId)?.permissions ?? null);
      if (refusal) {
        return sendError(reply, 403, refusal);
      }
    }

    // Atomically replace member's role assignments
    db.transaction((tx) => {
      // Remove all existing role assignments for this member in this server
      tx.delete(schema.memberRoles)
        .where(and(
          eq(schema.memberRoles.spaceId, id),
          eq(schema.memberRoles.userId, uid),
        ))
        .run();

      // Insert new role assignments
      for (const roleId of roleIds) {
        tx.insert(schema.memberRoles).values({
          spaceId: id,
          userId: uid,
          roleId,
        }).run();
      }
    });

    // Force target user's client to re-sync with their new permissions
    connectionManager.pushReadyPayload(uid);
    checkVoicePermissions(id);

    // Build response with populated roles
    const updatedMember = db.select()
      .from(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .get();

    if (!updatedMember) {
      return sendError(reply, 500, 'member_update_failed');
    }

    const user = db.select().from(schema.users).where(eq(schema.users.id, uid)).get();
    if (!user) {
      return sendError(reply, 500, 'user_not_found');
    }

    const updatedRoleRows = db.select()
      .from(schema.memberRoles)
      .where(and(
        eq(schema.memberRoles.spaceId, id),
        eq(schema.memberRoles.userId, uid),
      ))
      .all();

    const updatedRoleIds = updatedRoleRows.map(r => r.roleId);
    const allRoles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.spaceId, id))
      .orderBy(schema.roles.position)
      .all();

    const memberRoles = allRoles
      .filter(r => updatedRoleIds.includes(r.id))
      .map(r => ({
        id: r.id,
        spaceId: r.spaceId,
        name: r.name,
        color: r.color ?? '#b9bbbe',
        position: r.position ?? 0,
        createdAt: r.createdAt,
      }));

    const result: MemberWithUser = {
      spaceId: updatedMember.spaceId,
      userId: updatedMember.userId,
      nickname: updatedMember.nickname,
      joinedAt: updatedMember.joinedAt,
      user: sanitizeUser(user),
      roles: memberRoles,
    };

    return reply.code(200).send(result);
  });

}

export function removeSpaceMemberRoutes(app: FastifyInstance): void {
  // DELETE /api/spaces/:id/members/:uid - Kick member (owner) or leave (self)
  app.delete<{ Params: { id: string; uid: string } }>('/api/spaces/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return sendError(reply, 404, 'space_not_found');
    }

    const isSelf = uid === request.userId;
    const isOwnerUser = isSpaceOwner(id, request.userId);
    const canKick = hasPermission(request.userId, id, PermissionBits.KICK_MEMBERS);

    if (!isSelf && !canKick) {
      return sendError(reply, 403, 'missing_permission', { permission: 'KICK_MEMBERS' });
    }

    // Owner cannot leave their own server - they must delete it
    if (isSelf && isOwnerUser) {
      return sendError(reply, 400, 'space_owner_cannot_leave');
    }

    const member = db.select()
      .from(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .get();

    if (!member) {
      return sendError(reply, 404, 'member_not_found');
    }

    // Cannot kick the owner
    if (isSpaceOwner(id, uid)) {
      return sendError(reply, 400, 'cannot_target_owner');
    }

    // Kicking someone else needs a higher top role than theirs
    if (!isSelf && !canActOnMemberInSpace(id, request.userId, uid)) {
      return sendError(reply, 403, 'role_hierarchy');
    }

    db.delete(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .run();

    // Clean up any voice restrictions for the removed member
    db.delete(schema.voiceRestrictions).where(
      and(
        eq(schema.voiceRestrictions.spaceId, id),
        eq(schema.voiceRestrictions.userId, uid),
      )
    ).run();

    // Clean up read_states for the departing user in this space's channels
    const spaceChannelIds = db.select({ id: schema.channels.id })
      .from(schema.channels).where(eq(schema.channels.spaceId, id)).all().map(c => c.id);
    if (spaceChannelIds.length > 0) {
      db.delete(schema.readStates).where(and(
        eq(schema.readStates.userId, uid),
        inArray(schema.readStates.channelId, spaceChannelIds),
      )).run();
    }

    // Broadcast member_left event
    connectionManager.sendToSpace(id, {
      type: 'member_left',
      spaceId: id,
      userId: uid,
    });

    return reply.code(200).send({ success: true });
  });

  // Role Management
}
