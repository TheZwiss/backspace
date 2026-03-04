import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, isServerOwner, hasPermission, computePermissions, PermissionBits } from '../utils/permissions.js';
import { DEFAULT_EVERYONE_PERMISSIONS, ALL_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';
import crypto from 'crypto';
import { connectionManager } from '../ws/handler.js';
import type {
  CreateServerRequest,
  UpdateServerRequest,
  JoinServerRequest,
  UpdateMemberRequest,
  Server,
  Channel,
  MemberWithUser,
  ServerWithChannelsAndMembers,
  Role,
} from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';

function rowToServer(row: typeof schema.servers.$inferSelect): Server {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    ownerId: row.ownerId,
    inviteCode: row.inviteCode,
    createdAt: row.createdAt,
  };
}

function rowToChannel(row: typeof schema.channels.$inferSelect): Channel {
  return {
    id: row.id,
    serverId: row.serverId,
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

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/servers - Create a new server
  app.post<{ Body: CreateServerRequest }>('/api/servers', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { name, icon } = request.body;

    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'Server name is required', statusCode: 400 });
    }

    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 100) {
      return reply.code(400).send({ error: 'Server name must be between 1 and 100 characters', statusCode: 400 });
    }

    const db = getDb();
    const serverId = generateSnowflake();
    const channelId = generateSnowflake();
    const now = Date.now();
    const inviteCode = generateInviteCode();

    // Create server, owner membership, default channel, and @everyone role atomically
    db.transaction((tx) => {
      tx.insert(schema.servers).values({
        id: serverId,
        name: trimmedName,
        icon: icon ?? null,
        ownerId: request.userId,
        inviteCode,
        createdAt: now,
      }).run();

      tx.insert(schema.serverMembers).values({
        serverId,
        userId: request.userId,
        joinedAt: now,
      }).run();

      tx.insert(schema.channels).values({
        id: channelId,
        serverId,
        name: 'general',
        type: 'text',
        position: 0,
        createdAt: now,
      }).run();

      // Auto-create @everyone role (id = serverId)
      tx.insert(schema.roles).values({
        id: serverId,
        serverId,
        name: '@everyone',
        color: '#b9bbbe',
        position: 0,
        permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
        createdAt: now,
      }).run();
    });

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
    if (!server) {
      return reply.code(500).send({ error: 'Failed to create server', statusCode: 500 });
    }

    return reply.code(201).send(rowToServer(server));
  });

  // GET /api/servers - List user's servers
  app.get('/api/servers', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();

    const memberships = db.select()
      .from(schema.serverMembers)
      .where(eq(schema.serverMembers.userId, request.userId))
      .all();

    if (memberships.length === 0) {
      return reply.code(200).send([]);
    }

    const serverIds = memberships.map(m => m.serverId);
    const servers = db.select()
      .from(schema.servers)
      .where(inArray(schema.servers.id, serverIds))
      .all();

    return reply.code(200).send(servers.map(rowToServer));
  });

  // GET /api/servers/:id - Get server detail with channels and members
  app.get<{ Params: { id: string } }>('/api/servers/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!isMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this server', statusCode: 403 });
    }

    const channels = db.select()
      .from(schema.channels)
      .where(eq(schema.channels.serverId, id))
      .all();

    const roles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.serverId, id))
      .orderBy(schema.roles.position)
      .all();

    const memberRows = db.select()
      .from(schema.serverMembers)
      .where(eq(schema.serverMembers.serverId, id))
      .all();

    const memberUserIds = memberRows.map(m => m.userId);
    const users = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const userMap = new Map(users.map(u => [u.id, u]));

    const memberRoleRows = db.select()
      .from(schema.memberRoles)
      .where(eq(schema.memberRoles.serverId, id))
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
            serverId: r.serverId,
            name: r.name,
            color: r.color ?? '#b9bbbe',
            position: r.position ?? 0,
            createdAt: r.createdAt,
          }));

        return {
          serverId: m.serverId,
          userId: m.userId,
          nickname: m.nickname,
          joinedAt: m.joinedAt,
          user: sanitizeUser(user),
          roles: memberRoles,
        };
      })
      .filter((m): m is MemberWithUser => m !== null);

    // Filter channels by VIEW_CHANNEL permission before returning
    const visibleChannels = channels.filter(ch => {
      const perms = computePermissions(request.userId, id, ch.id);
      return (perms & PermissionBits.VIEW_CHANNEL) !== 0n;
    });

    const result: ServerWithChannelsAndMembers = {
      ...rowToServer(server),
      channels: visibleChannels.map(rowToChannel),
      members,
      roles: roles.map(r => ({
        id: r.id,
        serverId: r.serverId,
        name: r.name,
        color: r.color ?? '#b9bbbe',
        position: r.position ?? 0,
        createdAt: r.createdAt,
      })),
    };

    return reply.code(200).send(result);
  });

  // PATCH /api/servers/:id - Update server (owner only)
  app.patch<{ Params: { id: string }; Body: UpdateServerRequest }>('/api/servers/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, icon } = request.body;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_SERVER)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SERVER permission', statusCode: 403 });
    }

    const updates: Partial<typeof schema.servers.$inferInsert> = {};

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName.length < 1 || trimmedName.length > 100) {
        return reply.code(400).send({ error: 'Server name must be between 1 and 100 characters', statusCode: 400 });
      }
      updates.name = trimmedName;
    }

    if (icon !== undefined) {
      updates.icon = icon;
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'No fields to update', statusCode: 400 });
    }

    db.update(schema.servers).set(updates).where(eq(schema.servers.id, id)).run();

    const updated = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!updated) {
      return reply.code(500).send({ error: 'Failed to update server', statusCode: 500 });
    }

    const serverData = rowToServer(updated);

    // Broadcast server_updated to all server members
    connectionManager.sendToServer(id, {
      type: 'server_updated',
      server: serverData,
    });

    return reply.code(200).send(serverData);
  });

  // DELETE /api/servers/:id - Delete server (owner only)
  app.delete<{ Params: { id: string } }>('/api/servers/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!isServerOwner(id, request.userId)) {
      return reply.code(403).send({ error: 'Only the server owner can delete the server', statusCode: 403 });
    }

    // Delete all channels (messages cascade), members, then server atomically
    db.transaction((tx) => {
      tx.delete(schema.channels).where(eq(schema.channels.serverId, id)).run();
      tx.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, id)).run();
      tx.delete(schema.servers).where(eq(schema.servers.id, id)).run();
    });

    return reply.code(200).send({ success: true });
  });

  // POST /api/servers/:id/invite - Generate invite code (admin+)
  app.post<{ Params: { id: string } }>('/api/servers/:id/invite', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!hasPermission(request.userId, id, PermissionBits.CREATE_INVITE)) {
      return reply.code(403).send({ error: 'Missing CREATE_INVITE permission', statusCode: 403 });
    }

    // Return existing invite code if one exists, otherwise generate a new one
    if (server.inviteCode) {
      return reply.code(200).send({ inviteCode: server.inviteCode });
    }

    const inviteCode = generateInviteCode();
    db.update(schema.servers).set({ inviteCode }).where(eq(schema.servers.id, id)).run();

    return reply.code(200).send({ inviteCode });
  });

  // POST /api/servers/:id/join - Join server by invite code
  app.post<{ Params: { id: string }; Body: JoinServerRequest }>('/api/servers/:id/join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { inviteCode } = request.body;

    if (!inviteCode || typeof inviteCode !== 'string') {
      return reply.code(400).send({ error: 'Invite code is required', statusCode: 400 });
    }

    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (server.inviteCode !== inviteCode) {
      return reply.code(400).send({ error: 'Invalid invite code', statusCode: 400 });
    }

    if (isMember(id, request.userId)) {
      return reply.code(409).send({ error: 'You are already a member of this server', statusCode: 409 });
    }

    const now = Date.now();
    db.insert(schema.serverMembers).values({
      serverId: id,
      userId: request.userId,
      joinedAt: now,
    }).run();

    // Register the user in connectionManager so they receive WS broadcasts for this server
    connectionManager.addUserServer(request.userId, id);

    // Broadcast member_joined to existing server members
    const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (joiningUser) {
      const memberPayload: MemberWithUser = {
        serverId: id,
        userId: request.userId,
        nickname: null,
        joinedAt: now,
        user: sanitizeUser(joiningUser),
        roles: [],
      };
      connectionManager.sendToServer(id, {
        type: 'member_joined',
        serverId: id,
        member: memberPayload,
      });
    }

    return reply.code(200).send(rowToServer(server));
  });

  // POST /api/servers/join - Join server by invite code (no server ID needed)
  app.post<{ Body: JoinServerRequest }>('/api/servers/join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { inviteCode } = request.body;

    if (!inviteCode || typeof inviteCode !== 'string') {
      return reply.code(400).send({ error: 'Invite code is required', statusCode: 400 });
    }

    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.inviteCode, inviteCode)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Invalid invite code', statusCode: 404 });
    }

    if (isMember(server.id, request.userId)) {
      return reply.code(409).send({ error: 'You are already a member of this server', statusCode: 409 });
    }

    const now = Date.now();
    db.insert(schema.serverMembers).values({
      serverId: server.id,
      userId: request.userId,
      joinedAt: now,
    }).run();

    // Register the user in connectionManager so they receive WS broadcasts for this server
    connectionManager.addUserServer(request.userId, server.id);

    // Broadcast member_joined to existing server members
    const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (joiningUser) {
      const memberPayload: MemberWithUser = {
        serverId: server.id,
        userId: request.userId,
        nickname: null,
        joinedAt: now,
        user: sanitizeUser(joiningUser),
        roles: [],
      };
      connectionManager.sendToServer(server.id, {
        type: 'member_joined',
        serverId: server.id,
        member: memberPayload,
      });
    }

    return reply.code(200).send(rowToServer(server));
  });

  // GET /api/servers/:id/members - List server members
  app.get<{ Params: { id: string } }>('/api/servers/:id/members', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!isMember(id, request.userId)) {
      return reply.code(403).send({ error: 'You are not a member of this server', statusCode: 403 });
    }

    const memberRows = db.select()
      .from(schema.serverMembers)
      .where(eq(schema.serverMembers.serverId, id))
      .all();

    const memberUserIds = memberRows.map(m => m.userId);
    const users = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const userMap = new Map(users.map(u => [u.id, u]));

    const roles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.serverId, id))
      .orderBy(schema.roles.position)
      .all();

    const memberRoleRows = db.select()
      .from(schema.memberRoles)
      .where(eq(schema.memberRoles.serverId, id))
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
            serverId: r.serverId,
            name: r.name,
            color: r.color ?? '#b9bbbe',
            position: r.position ?? 0,
            createdAt: r.createdAt,
          }));

        return {
          serverId: m.serverId,
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

  // PATCH /api/servers/:id/members/:uid - Update member roles
  app.patch<{ Params: { id: string; uid: string }; Body: UpdateMemberRequest }>('/api/servers/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { roleIds } = request.body;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
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
    if (isServerOwner(id, uid) && !isServerOwner(id, request.userId)) {
      return reply.code(403).send({ error: 'Only the server owner can modify their own roles', statusCode: 403 });
    }

    const member = db.select()
      .from(schema.serverMembers)
      .where(and(
        eq(schema.serverMembers.serverId, id),
        eq(schema.serverMembers.userId, uid),
      ))
      .get();

    if (!member) {
      return reply.code(404).send({ error: 'Member not found', statusCode: 404 });
    }

    // Validate all roleIds belong to this server and are not @everyone
    if (roleIds.length > 0) {
      const serverRoles = db.select()
        .from(schema.roles)
        .where(eq(schema.roles.serverId, id))
        .all();

      const serverRoleIds = new Set(serverRoles.map(r => r.id));

      for (const roleId of roleIds) {
        if (!serverRoleIds.has(roleId)) {
          return reply.code(400).send({ error: `Role ${roleId} does not belong to this server`, statusCode: 400 });
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
          eq(schema.memberRoles.serverId, id),
          eq(schema.memberRoles.userId, uid),
        ))
        .run();

      // Insert new role assignments
      for (const roleId of roleIds) {
        tx.insert(schema.memberRoles).values({
          serverId: id,
          userId: uid,
          roleId,
        }).run();
      }
    });

    // Force target user's client to re-sync with their new permissions
    connectionManager.pushReadyPayload(uid);

    // Build response with populated roles
    const updatedMember = db.select()
      .from(schema.serverMembers)
      .where(and(
        eq(schema.serverMembers.serverId, id),
        eq(schema.serverMembers.userId, uid),
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
        eq(schema.memberRoles.serverId, id),
        eq(schema.memberRoles.userId, uid),
      ))
      .all();

    const updatedRoleIds = updatedRoleRows.map(r => r.roleId);
    const allRoles = db.select()
      .from(schema.roles)
      .where(eq(schema.roles.serverId, id))
      .orderBy(schema.roles.position)
      .all();

    const memberRoles = allRoles
      .filter(r => updatedRoleIds.includes(r.id))
      .map(r => ({
        id: r.id,
        serverId: r.serverId,
        name: r.name,
        color: r.color ?? '#b9bbbe',
        position: r.position ?? 0,
        createdAt: r.createdAt,
      }));

    const result: MemberWithUser = {
      serverId: updatedMember.serverId,
      userId: updatedMember.userId,
      nickname: updatedMember.nickname,
      joinedAt: updatedMember.joinedAt,
      user: sanitizeUser(user),
      roles: memberRoles,
    };

    return reply.code(200).send(result);
  });

  // DELETE /api/servers/:id/members/:uid - Kick member (owner) or leave (self)
  app.delete<{ Params: { id: string; uid: string } }>('/api/servers/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    const isSelf = uid === request.userId;
    const isOwnerUser = isServerOwner(id, request.userId);
    const canKick = hasPermission(request.userId, id, PermissionBits.KICK_MEMBERS);

    if (!isSelf && !canKick) {
      return reply.code(403).send({ error: 'Missing KICK_MEMBERS permission', statusCode: 403 });
    }

    // Owner cannot leave their own server - they must delete it
    if (isSelf && isOwnerUser) {
      return reply.code(400).send({ error: 'Server owner cannot leave. Transfer ownership or delete the server.', statusCode: 400 });
    }

    const member = db.select()
      .from(schema.serverMembers)
      .where(and(
        eq(schema.serverMembers.serverId, id),
        eq(schema.serverMembers.userId, uid),
      ))
      .get();

    if (!member) {
      return reply.code(404).send({ error: 'Member not found', statusCode: 404 });
    }

    // Cannot kick the owner
    if (isServerOwner(id, uid)) {
      return reply.code(400).send({ error: 'Cannot remove the server owner', statusCode: 400 });
    }

    db.delete(schema.serverMembers)
      .where(and(
        eq(schema.serverMembers.serverId, id),
        eq(schema.serverMembers.userId, uid),
      ))
      .run();

    // Broadcast member_left event
    connectionManager.sendToServer(id, {
      type: 'member_left',
      serverId: id,
      userId: uid,
    });

    return reply.code(200).send({ success: true });
  });

  // Role Management
  
  // POST /api/servers/:id/roles - Create a new role
  app.post<{ Params: { id: string }; Body: { name: string; color?: string } }>('/api/servers/:id/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, color } = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    const roleId = generateSnowflake();
    db.insert(schema.roles).values({
      id: roleId,
      serverId: id,
      name: name || 'new role',
      color: color || '#b9bbbe',
      position: 0,
      createdAt: Date.now(),
    }).run();

    const role = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
    return reply.code(201).send(role);
  });

  // PATCH /api/servers/:id/roles/:roleId - Update a role
  app.patch<{ Params: { id: string; roleId: string }; Body: { name?: string; color?: string; position?: number } }>('/api/servers/:id/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, roleId } = request.params;
    const updates = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    db.update(schema.roles).set(updates).where(and(eq(schema.roles.id, roleId), eq(schema.roles.serverId, id))).run();
    const updated = db.select().from(schema.roles).where(eq(schema.roles.id, roleId)).get();
    return reply.code(200).send(updated);
  });

  // DELETE /api/servers/:id/roles/:roleId - Delete a role
  app.delete<{ Params: { id: string; roleId: string } }>('/api/servers/:id/roles/:roleId', {
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

    db.delete(schema.roles).where(and(eq(schema.roles.id, roleId), eq(schema.roles.serverId, id))).run();
    return reply.code(200).send({ success: true });
  });

  // POST /api/servers/:id/members/:uid/roles - Add role to member
  app.post<{ Params: { id: string; uid: string }; Body: { roleId: string } }>('/api/servers/:id/members/:uid/roles', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { roleId } = request.body;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    db.insert(schema.memberRoles).values({
      serverId: id,
      userId: uid,
      roleId,
    }).run();

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/servers/:id/members/:uid/roles/:roleId - Remove role from member
  app.delete<{ Params: { id: string; uid: string; roleId: string } }>('/api/servers/:id/members/:uid/roles/:roleId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid, roleId } = request.params;
    const db = getDb();

    if (!hasPermission(request.userId, id, PermissionBits.MANAGE_ROLES)) {
      return reply.code(403).send({ error: 'Missing MANAGE_ROLES permission', statusCode: 403 });
    }

    db.delete(schema.memberRoles).where(and(
      eq(schema.memberRoles.serverId, id),
      eq(schema.memberRoles.userId, uid),
      eq(schema.memberRoles.roleId, roleId)
    )).run();

    return reply.code(200).send({ success: true });
  });
}
