import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, isSpaceOwner, hasPermission, computePermissions, PermissionBits } from '../utils/permissions.js';
import { DEFAULT_EVERYONE_PERMISSIONS, ALL_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';
import crypto from 'crypto';
import { connectionManager } from '../ws/handler.js';
import type {
  CreateSpaceRequest,
  UpdateSpaceRequest,
  JoinSpaceRequest,
  UpdateMemberRequest,
  Space,
  Channel,
  MemberWithUser,
  SpaceWithChannelsAndMembers,
  Role,
} from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';

function rowToSpace(row: typeof schema.spaces.$inferSelect): Space {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    banner: row.banner ?? null,
    ownerId: row.ownerId,
    inviteCode: row.inviteCode,
    visibility: (row.visibility ?? 'private') as Space['visibility'],
    description: row.description ?? null,
    createdAt: row.createdAt,
  };
}

function rowToChannel(row: typeof schema.channels.$inferSelect): Channel {
  return {
    id: row.id,
    spaceId: row.spaceId,
    name: row.name,
    type: row.type as Channel['type'],
    topic: row.topic,
    position: row.position ?? 0,
    createdAt: row.createdAt,
  };
}

function generateInviteCode(): string {
  return crypto.randomBytes(4).toString('hex');
}

export async function spaceRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/spaces - Create a new server
  app.post<{ Body: CreateSpaceRequest }>('/api/spaces', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { name, icon, banner, visibility, description } = request.body;

    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'Space name is required', statusCode: 400 });
    }

    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 100) {
      return reply.code(400).send({ error: 'Space name must be between 1 and 100 characters', statusCode: 400 });
    }

    // Validate visibility
    const validVisibilities = ['public', 'request', 'private'];
    const safeVisibility = visibility && validVisibilities.includes(visibility) ? visibility : 'private';

    // Validate description
    const safeDescription = description ? description.trim().slice(0, 200) || null : null;

    const db = getDb();
    const spaceId = generateSnowflake();
    const channelId = generateSnowflake();
    const now = Date.now();
    const inviteCode = generateInviteCode();

    // Create server, owner membership, default channel, and @everyone role atomically
    db.transaction((tx) => {
      tx.insert(schema.spaces).values({
        id: spaceId,
        name: trimmedName,
        icon: icon ?? null,
        banner: banner ?? null,
        ownerId: request.userId,
        inviteCode,
        visibility: safeVisibility,
        description: safeDescription,
        createdAt: now,
      }).run();

      tx.insert(schema.spaceMembers).values({
        spaceId,
        userId: request.userId,
        joinedAt: now,
      }).run();

      tx.insert(schema.channels).values({
        id: channelId,
        spaceId,
        name: 'general',
        type: 'text',
        position: 0,
        createdAt: now,
      }).run();

      // Auto-create @everyone role (id = spaceId)
      tx.insert(schema.roles).values({
        id: spaceId,
        spaceId,
        name: '@everyone',
        color: '#b9bbbe',
        position: 0,
        permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
        createdAt: now,
      }).run();
    });

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();
    if (!server) {
      return reply.code(500).send({ error: 'Failed to create space', statusCode: 500 });
    }

    // Register the creator in connectionManager so they receive WS broadcasts for this space
    connectionManager.addUserSpace(request.userId, spaceId);

    return reply.code(201).send(rowToSpace(server));
  });

  // GET /api/spaces - List user's servers
  app.get('/api/spaces', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();

    const memberships = db.select()
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.userId, request.userId))
      .all();

    if (memberships.length === 0) {
      return reply.code(200).send([]);
    }

    const spaceIds = memberships.map(m => m.spaceId);
    const servers = db.select()
      .from(schema.spaces)
      .where(inArray(schema.spaces.id, spaceIds))
      .all();

    return reply.code(200).send(servers.map(rowToSpace));
  });

  // GET /api/spaces/:id - Get server detail with channels and members
  app.get<{ Params: { id: string } }>('/api/spaces/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!isMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this space', statusCode: 403 });
    }

    const channels = db.select()
      .from(schema.channels)
      .where(eq(schema.channels.spaceId, id))
      .all();

    const roles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.spaceId, id))
      .orderBy(schema.roles.position)
      .all();

    const memberRows = db.select()
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.spaceId, id))
      .all();

    const memberUserIds = memberRows.map(m => m.userId);
    const users = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const userMap = new Map(users.map(u => [u.id, u]));

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
        
        const memberRoles = roles
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
          roles: memberRoles,
        };
      })
      .filter((m): m is MemberWithUser => m !== null);

    // Compute space-level permissions for the requesting user
    const spacePerms = computePermissions(request.userId, id);

    // Filter channels by VIEW_CHANNEL permission and attach per-channel myPermissions
    const visibleChannels: (Channel & { myPermissions: string })[] = [];
    for (const ch of channels) {
      const perms = computePermissions(request.userId, id, ch.id);
      if ((perms & PermissionBits.VIEW_CHANNEL) !== 0n) {
        visibleChannels.push({
          ...rowToChannel(ch),
          myPermissions: permissionsToString(perms),
        });
      }
    }

    const canManageRoles = (spacePerms & PermissionBits.MANAGE_ROLES) !== 0n;

    const result: SpaceWithChannelsAndMembers = {
      ...rowToSpace(server),
      channels: visibleChannels,
      members,
      roles: roles.map(r => ({
        id: r.id,
        spaceId: r.spaceId,
        name: r.name,
        color: r.color ?? '#b9bbbe',
        position: r.position ?? 0,
        permissions: canManageRoles ? (r.permissions ?? '0') : undefined,
        createdAt: r.createdAt,
      })),
      myPermissions: permissionsToString(spacePerms),
    };

    return reply.code(200).send(result);
  });

  // PATCH /api/spaces/:id - Update server (owner only)
  app.patch<{ Params: { id: string }; Body: UpdateSpaceRequest }>('/api/spaces/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, icon, banner, visibility, description } = request.body;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_SPACE)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SPACE permission', statusCode: 403 });
    }

    const updates: Partial<typeof schema.spaces.$inferInsert> = {};

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName.length < 1 || trimmedName.length > 100) {
        return reply.code(400).send({ error: 'Space name must be between 1 and 100 characters', statusCode: 400 });
      }
      updates.name = trimmedName;
    }

    if (icon !== undefined) {
      updates.icon = icon || null;
    }

    if (banner !== undefined) {
      updates.banner = banner || null;
    }

    if (visibility !== undefined) {
      const validVisibilities = ['public', 'request', 'private'];
      if (!validVisibilities.includes(visibility)) {
        return reply.code(400).send({ error: 'Visibility must be "public", "request", or "private"', statusCode: 400 });
      }
      updates.visibility = visibility;
    }

    if (description !== undefined) {
      const trimmed = description.trim().slice(0, 200);
      updates.description = trimmed || null;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'No fields to update', statusCode: 400 });
    }

    db.update(schema.spaces).set(updates).where(eq(schema.spaces.id, id)).run();

    const updated = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!updated) {
      return reply.code(500).send({ error: 'Failed to update space', statusCode: 500 });
    }

    const spaceData = rowToSpace(updated);

    // Broadcast space_updated to all space members
    connectionManager.sendToSpace(id, {
      type: 'space_updated',
      space: spaceData,
    });

    return reply.code(200).send(spaceData);
  });

  // DELETE /api/spaces/:id - Delete server (owner only)
  app.delete<{ Params: { id: string } }>('/api/spaces/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!isSpaceOwner(id, request.userId)) {
      return reply.code(403).send({ error: 'Only the space owner can delete the space', statusCode: 403 });
    }

    // Delete all channels (messages cascade), members, then server atomically
    db.transaction((tx) => {
      tx.delete(schema.channels).where(eq(schema.channels.spaceId, id)).run();
      tx.delete(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, id)).run();
      tx.delete(schema.spaces).where(eq(schema.spaces.id, id)).run();
    });

    return reply.code(200).send({ success: true });
  });

  // POST /api/spaces/:id/invite - Generate invite code (admin+)
  app.post<{ Params: { id: string } }>('/api/spaces/:id/invite', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, id, PermissionBits.CREATE_INVITE)) {
      return reply.code(403).send({ error: 'Missing CREATE_INVITE permission', statusCode: 403 });
    }

    // Return existing invite code if one exists, otherwise generate a new one
    if (server.inviteCode) {
      return reply.code(200).send({ inviteCode: server.inviteCode });
    }

    const inviteCode = generateInviteCode();
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
      return reply.code(400).send({ error: 'Invite code is required', statusCode: 400 });
    }

    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (server.inviteCode !== inviteCode) {
      return reply.code(400).send({ error: 'Invalid invite code', statusCode: 400 });
    }

    if (isMember(id, request.userId)) {
      return reply.code(409).send({ error: 'You are already a member of this space', statusCode: 409 });
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
      return reply.code(400).send({ error: 'Invite code is required', statusCode: 400 });
    }

    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.inviteCode, inviteCode)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Invalid invite code', statusCode: 404 });
    }

    if (isMember(server.id, request.userId)) {
      return reply.code(409).send({ error: 'You are already a member of this space', statusCode: 409 });
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

  // GET /api/spaces/:id/members - List server members
  app.get<{ Params: { id: string } }>('/api/spaces/:id/members', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!isMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this space', statusCode: 403 });
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

  // PATCH /api/spaces/:id/members/:uid - Update member roles
  app.patch<{ Params: { id: string; uid: string }; Body: UpdateMemberRequest }>('/api/spaces/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { roleIds } = request.body;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    if (uid === request.userId) {
      return reply.code(400).send({ error: 'You cannot change your own roles', statusCode: 400 });
    }

    if (!Array.isArray(roleIds)) {
      return reply.code(400).send({ error: 'roleIds must be an array of role IDs', statusCode: 400 });
    }

    // Cannot modify the server owner's roles unless you are the owner
    if (isSpaceOwner(id, uid) && !isSpaceOwner(id, request.userId)) {
      return reply.code(403).send({ error: 'Only the space owner can modify their own roles', statusCode: 403 });
    }

    const member = db.select()
      .from(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .get();

    if (!member) {
      return reply.code(404).send({ error: 'Member not found', statusCode: 404 });
    }

    // Validate all roleIds belong to this server and are not @everyone
    if (roleIds.length > 0) {
      const spaceRoles = db.select()
        .from(schema.roles)
        .where(eq(schema.roles.spaceId, id))
        .all();

      const spaceRoleIds = new Set(spaceRoles.map(r => r.id));

      for (const roleId of roleIds) {
        if (!spaceRoleIds.has(roleId)) {
          return reply.code(400).send({ error: `Role ${roleId} does not belong to this space`, statusCode: 400 });
        }
        if (roleId === id) {
          return reply.code(400).send({ error: '@everyone role is implicit and cannot be assigned', statusCode: 400 });
        }
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

    // Build response with populated roles
    const updatedMember = db.select()
      .from(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .get();

    if (!updatedMember) {
      return reply.code(500).send({ error: 'Failed to update member', statusCode: 500 });
    }

    const user = db.select().from(schema.users).where(eq(schema.users.id, uid)).get();
    if (!user) {
      return reply.code(500).send({ error: 'User not found', statusCode: 500 });
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

  // DELETE /api/spaces/:id/members/:uid - Kick member (owner) or leave (self)
  app.delete<{ Params: { id: string; uid: string } }>('/api/spaces/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const db = getDb();

    const server = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    const isSelf = uid === request.userId;
    const isOwnerUser = isSpaceOwner(id, request.userId);
    const canKick = hasPermission(request.userId, id, PermissionBits.KICK_MEMBERS);

    if (!isSelf && !canKick) {
      return reply.code(403).send({ error: 'Missing KICK_MEMBERS permission', statusCode: 403 });
    }

    // Owner cannot leave their own server - they must delete it
    if (isSelf && isOwnerUser) {
      return reply.code(400).send({ error: 'Space owner cannot leave. Transfer ownership or delete the space.', statusCode: 400 });
    }

    const member = db.select()
      .from(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .get();

    if (!member) {
      return reply.code(404).send({ error: 'Member not found', statusCode: 404 });
    }

    // Cannot kick the owner
    if (isSpaceOwner(id, uid)) {
      return reply.code(400).send({ error: 'Cannot remove the space owner', statusCode: 400 });
    }

    db.delete(schema.spaceMembers)
      .where(and(
        eq(schema.spaceMembers.spaceId, id),
        eq(schema.spaceMembers.userId, uid),
      ))
      .run();

    // Broadcast member_left event
    connectionManager.sendToSpace(id, {
      type: 'member_left',
      spaceId: id,
      userId: uid,
    });

    return reply.code(200).send({ success: true });
  });

  // Role Management
  
  // POST /api/spaces/:id/roles - Create a new role
  app.post<{ Params: { id: string }; Body: { name: string; color?: string; permissions?: string } }>('/api/spaces/:id/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, color, permissions } = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    // Validate permissions string is a valid bigint if provided
    let permStr: string | undefined;
    if (permissions !== undefined) {
      try {
        BigInt(permissions);
        permStr = permissions;
      } catch {
        return reply.code(400).send({ error: 'Invalid permissions value', statusCode: 400 });
      }
    }

    const roleId = generateSnowflake();
    db.insert(schema.roles).values({
      id: roleId,
      spaceId: id,
      name: name || 'new role',
      color: color || '#b9bbbe',
      position: 0,
      permissions: permStr ?? null,
      createdAt: Date.now(),
    }).run();

    const role = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();

    // Broadcast updated state to all space members
    const memberRows = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, id)).all();
    for (const m of memberRows) {
      connectionManager.pushReadyPayload(m.userId);
    }

    return reply.code(201).send(role);
  });

  // PATCH /api/spaces/:id/roles/:roleId - Update a role
  app.patch<{ Params: { id: string; roleId: string }; Body: { name?: string; color?: string; position?: number; permissions?: string } }>('/api/spaces/:id/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, roleId } = request.params;
    const { name, color, position, permissions } = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    const updates: Partial<typeof schema.roles.$inferInsert> = {};
    if (name !== undefined) updates.name = name;
    if (color !== undefined) updates.color = color;
    if (position !== undefined) updates.position = position;

    if (permissions !== undefined) {
      try {
        BigInt(permissions);
        updates.permissions = permissions;
      } catch {
        return reply.code(400).send({ error: 'Invalid permissions value', statusCode: 400 });
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'No fields to update', statusCode: 400 });
    }

    db.update(schema.roles).set(updates).where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id))).run();
    const updated = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();

    // Broadcast updated state to all space members
    const memberRows = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, id)).all();
    for (const m of memberRows) {
      connectionManager.pushReadyPayload(m.userId);
    }

    return reply.code(200).send(updated);
  });

  // DELETE /api/spaces/:id/roles/:roleId - Delete a role
  app.delete<{ Params: { id: string; roleId: string } }>('/api/spaces/:id/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, roleId } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    // Cannot delete @everyone role
    if (roleId === id) {
      return reply.code(400).send({ error: 'Cannot delete the @everyone role', statusCode: 400 });
    }

    // Delete channel overrides referencing this role
    db.delete(schema.channelOverrides).where(
      and(eq(schema.channelOverrides.targetType, 'role'), eq(schema.channelOverrides.targetId, roleId))
    ).run();

    db.delete(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.spaceId, id))).run();

    // Broadcast updated state to all space members
    const memberRows = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.spaceId, id)).all();
    for (const m of memberRows) {
      connectionManager.pushReadyPayload(m.userId);
    }

    return reply.code(200).send({ success: true });
  });

  // POST /api/spaces/:id/members/:uid/roles - Add role to member
  app.post<{ Params: { id: string; uid: string }; Body: { roleId: string } }>('/api/spaces/:id/members/:uid/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { roleId } = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    db.insert(schema.memberRoles).values({
      spaceId: id,
      userId: uid,
      roleId,
    }).run();

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/spaces/:id/members/:uid/roles/:roleId - Remove role from member
  app.delete<{ Params: { id: string; uid: string; roleId: string } }>('/api/spaces/:id/members/:uid/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid, roleId } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    db.delete(schema.memberRoles).where(and(
      eq(schema.memberRoles.spaceId, id),
      eq(schema.memberRoles.userId, uid),
      eq(schema.memberRoles.roleId, roleId)
    )).run();

    return reply.code(200).send({ success: true });
  });
}
