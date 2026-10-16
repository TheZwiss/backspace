import type { MemberWithUser, UpdateMemberRequest } from '@backspace/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { MAX_MEMBER_NICKNAME_LENGTH, normalizeMemberNickname } from '@backspace/shared/src/constants.js';
import { canActOnMember, canManageRoleAt, roleBitsChangeRefusal, stringToPermissions, type HeldBitsRefusal } from '@backspace/shared/src/permissions.js';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { hasPermission, computePermissions, PermissionBits } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { getHierarchyStanding } from '../utils/roleHierarchy.js';
import { memberRolesView } from '../utils/permissionDataView.js';
import { connectionManager } from '../ws/handler.js';
import { checkVoicePermissions } from '../ws/events.js';

/**
 * Held-bits rule for handing out a role (permissions.md, "Held-bits rule"):
 * giving a member a role gives them its bits, so the actor must hold every
 * one of them. Taking a role away is governed by the hierarchy alone.
 */
export function roleGrantRefusal(spaceId: string, actorId: string, rolePermissions: string | null): HeldBitsRefusal | null {
  return roleBitsChangeRefusal(computePermissions(actorId, spaceId), 0n, stringToPermissions(rolePermissions));
}

interface MemberUpdateContext {
  spaceId: string;
  actorId: string;
  targetId: string;
  ownerId: string;
  reply: FastifyReply;
}

/**
 * Checks a whole role set for a member. Answers the set to store, or null
 * after sending a refusal. A bot's managed role is not part of what the set
 * controls: it stays on its bot whether the set names it or not, and naming
 * it for anyone else is refused (bots.md, "Permissions on invite").
 */
function validateRoleUpdate(context: MemberUpdateContext, roleIds: unknown): string[] | null {
  const { spaceId, actorId, targetId, ownerId, reply } = context;
  if (!hasPermission(actorId, spaceId, PermissionBits.MANAGE_ROLES)) {
    sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_ROLES' });
    return null;
  }
  if (targetId === actorId) {
    sendError(reply, 400, 'cannot_change_own_roles');
    return null;
  }
  if (targetId === ownerId) {
    sendError(reply, 403, 'space_owner_only');
    return null;
  }
  if (!Array.isArray(roleIds) || roleIds.some((id) => typeof id !== 'string') || new Set(roleIds).size !== roleIds.length) {
    sendError(reply, 400, 'role_ids_invalid');
    return null;
  }
  const db = getDb();
  const spaceRoles = db.select().from(schema.roles).where(eq(schema.roles.spaceId, spaceId)).all();
  const spaceRolePositions = new Map(spaceRoles.map(r => [r.id, r.position ?? 0]));
  const managedBotOf = new Map(spaceRoles.flatMap(r => (r.managedBotId ? [[r.id, r.managedBotId] as const] : [])));
  for (const roleId of roleIds) {
    if (!spaceRolePositions.has(roleId)) {
      sendError(reply, 400, 'role_not_in_space', { roleId });
      return null;
    }
    if (roleId === spaceId) {
      sendError(reply, 400, 'everyone_role_not_assignable');
      return null;
    }
    const managedBot = managedBotOf.get(roleId);
    if (managedBot !== undefined && managedBot !== targetId) {
      sendError(reply, 400, 'role_managed_by_bot');
      return null;
    }
  }
  // The target's own managed role is kept, named or not.
  const roleSet = [...new Set([
    ...roleIds,
    ...[...managedBotOf].filter(([, botId]) => botId === targetId).map(([roleId]) => roleId),
  ])];

  // Role hierarchy: the member must rank below the actor, and every role
  // this request adds or removes must sit below the actor's top role.
  const actorStanding = getHierarchyStanding(spaceId, actorId);
  if (!canActOnMember(actorStanding, getHierarchyStanding(spaceId, targetId))) {
    sendError(reply, 403, 'role_hierarchy');
    return null;
  }
  const currentRoleIds = new Set(
    db.select({ roleId: schema.memberRoles.roleId })
      .from(schema.memberRoles)
      .where(and(eq(schema.memberRoles.spaceId, spaceId), eq(schema.memberRoles.userId, targetId)))
      .all()
      .map(r => r.roleId),
  );
  const requestedRoleIds = new Set(roleSet);
  const changedRoleIds = [
    ...roleSet.filter(r => !currentRoleIds.has(r)),
    ...[...currentRoleIds].filter(r => !requestedRoleIds.has(r)),
  ];
  for (const roleId of changedRoleIds) {
    if (!canManageRoleAt(actorStanding, spaceRolePositions.get(roleId) ?? 0)) {
      sendError(reply, 403, 'role_hierarchy');
      return null;
    }
  }
  // Held-bits rule: a role this request adds must carry only bits the actor holds.
  for (const roleId of roleSet.filter(r => !currentRoleIds.has(r))) {
    const refusal = roleGrantRefusal(spaceId, actorId, spaceRoles.find(r => r.id === roleId)?.permissions ?? null);
    if (refusal) {
      sendError(reply, 403, refusal);
      return null;
    }
  }
  return roleSet;
}

/**
 * Who may set whose nickname: anyone their own; another member's needs
 * MANAGE_SPACE, never reaches the owner, and follows the role hierarchy like
 * every other action on a member (permissions.md, "Role hierarchy").
 * Answers the stored form (null clears), or undefined after sending a refusal.
 */
function validateNicknameUpdate(context: MemberUpdateContext, nickname: unknown): string | null | undefined {
  const { spaceId, actorId, targetId, ownerId, reply } = context;
  if (actorId !== targetId) {
    if (!hasPermission(actorId, spaceId, PermissionBits.MANAGE_SPACE)) {
      sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_SPACE' });
      return undefined;
    }
    if (targetId === ownerId) {
      sendError(reply, 403, 'space_owner_only');
      return undefined;
    }
    if (!canActOnMember(getHierarchyStanding(spaceId, actorId), getHierarchyStanding(spaceId, targetId))) {
      sendError(reply, 403, 'role_hierarchy');
      return undefined;
    }
  }
  const stored = normalizeMemberNickname(nickname);
  if (stored === undefined) {
    sendError(reply, 400, 'member_nickname_invalid', { max: MAX_MEMBER_NICKNAME_LENGTH });
    return undefined;
  }
  return stored;
}

/** What a valid PATCH writes: the role set and the nickname in its stored form, each only when sent. */
interface MemberWrite {
  roleIds?: string[];
  nickname?: string | null;
}

/**
 * Checks every field before anything is written, so a request that changes
 * roles and the nickname together never half succeeds. Answers the write, or
 * null after sending a refusal.
 */
function validateMemberPatch(context: MemberUpdateContext, patch: UpdateMemberRequest): MemberWrite | null {
  const { roleIds, nickname } = patch;
  if (roleIds === undefined && nickname === undefined) {
    sendError(context.reply, 400, 'validation_failed');
    return null;
  }
  const write: MemberWrite = {};
  if (roleIds !== undefined) {
    const roleSet = validateRoleUpdate(context, roleIds);
    if (!roleSet) return null;
    write.roleIds = roleSet;
  }
  if (nickname !== undefined) {
    const stored = validateNicknameUpdate(context, nickname);
    if (stored === undefined) return null;
    write.nickname = stored;
  }
  return write;
}

function persistMemberUpdate(target: { spaceId: string; userId: string }, write: MemberWrite): void {
  const { spaceId: id, userId: uid } = target;
  const { roleIds, nickname } = write;
  const db = getDb();
  db.transaction((tx) => {
    if (roleIds !== undefined) {
      tx.delete(schema.memberRoles)
        .where(and(eq(schema.memberRoles.spaceId, id), eq(schema.memberRoles.userId, uid))).run();
      for (const roleId of roleIds) {
        tx.insert(schema.memberRoles).values({ spaceId: id, userId: uid, roleId }).run();
      }
    }
    if (nickname !== undefined) {
      tx.update(schema.spaceMembers).set({ nickname })
        .where(and(eq(schema.spaceMembers.spaceId, id), eq(schema.spaceMembers.userId, uid))).run();
    }
  });
}

export function updateSpaceMemberRoutes(app: FastifyInstance): void {
  app.patch<{ Params: { id: string; uid: string }; Body: UpdateMemberRequest }>('/api/spaces/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return sendError(reply, 400, 'validation_failed');
    }
    const db = getDb();
    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) return sendError(reply, 404, 'space_not_found');

    // No membership check on the actor: the permission checks decide, as
    // before nicknames, so an instance admin keeps managing roles in a space
    // they have not joined. A nickname of one's own needs a member row (404).
    const context = { spaceId: id, actorId: request.userId, targetId: uid, ownerId: server.ownerId, reply };
    const write = validateMemberPatch(context, request.body);
    if (!write) return reply;
    const member = db.select().from(schema.spaceMembers)
      .where(and(eq(schema.spaceMembers.spaceId, id), eq(schema.spaceMembers.userId, uid))).get();
    if (!member) return sendError(reply, 404, 'member_not_found');

    persistMemberUpdate({ spaceId: id, userId: uid }, write);

    if (write.roleIds !== undefined) {
      // Recompute the target's permissions in addition to refreshing everyone's member display.
      connectionManager.announceSpaceAccessChange(id, [uid]);
      checkVoicePermissions(id);
    }

    return publishUpdatedMember(id, uid, reply);
  });
}

function publishUpdatedMember(id: string, uid: string, reply: FastifyReply) {
  const db = getDb();
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

  const result: MemberWithUser = {
    spaceId: updatedMember.spaceId,
    userId: updatedMember.userId,
    nickname: updatedMember.nickname,
    joinedAt: updatedMember.joinedAt,
    user: sanitizeUser(user),
    roles: memberRolesView(allRoles, new Set(updatedRoleIds)),
  };

  connectionManager.sendToSpace(id, { type: 'member_updated', spaceId: id, member: result });
  return reply.code(200).send(result);
}

