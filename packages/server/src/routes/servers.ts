import type { FastifyInstance } from 'fastify';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, isOwner, isAdmin } from '../utils/permissions.js';
import crypto from 'crypto';
import type {
  CreateServerRequest,
  UpdateServerRequest,
  JoinServerRequest,
  UpdateMemberRequest,
  User,
  Server,
  Channel,
  MemberWithUser,
  ServerWithChannelsAndMembers,
} from '@opencord/shared';

function sanitizeUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatar: row.avatar,
    status: (row.status ?? 'offline') as User['status'],
    customStatus: row.customStatus,
    createdAt: row.createdAt,
  };
}

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

    // Create the server
    db.insert(schema.servers).values({
      id: serverId,
      name: trimmedName,
      icon: icon ?? null,
      ownerId: request.userId,
      inviteCode,
      createdAt: now,
    }).run();

    // Add owner as member with 'owner' role
    db.insert(schema.serverMembers).values({
      serverId,
      userId: request.userId,
      role: 'owner',
      joinedAt: now,
    }).run();

    // Create default #general text channel
    db.insert(schema.channels).values({
      id: channelId,
      serverId,
      name: 'general',
      type: 'text',
      position: 0,
      createdAt: now,
    }).run();

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

    const memberRows = db.select()
      .from(schema.serverMembers)
      .where(eq(schema.serverMembers.serverId, id))
      .all();

    const memberUserIds = memberRows.map(m => m.userId);
    const users = memberUserIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
      : [];

    const userMap = new Map(users.map(u => [u.id, u]));

    const members: MemberWithUser[] = memberRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;
        return {
          serverId: m.serverId,
          userId: m.userId,
          role: (m.role ?? 'member') as MemberWithUser['role'],
          nickname: m.nickname,
          joinedAt: m.joinedAt,
          user: sanitizeUser(user),
        };
      })
      .filter((m): m is MemberWithUser => m !== null);

    const result: ServerWithChannelsAndMembers = {
      ...rowToServer(server),
      channels: channels.map(rowToChannel),
      members,
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

    if (!isOwner(id, request.userId)) {
      return reply.code(403).send({ error: 'Only the server owner can update the server', statusCode: 403 });
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

    return reply.code(200).send(rowToServer(updated));
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

    if (!isOwner(id, request.userId)) {
      return reply.code(403).send({ error: 'Only the server owner can delete the server', statusCode: 403 });
    }

    // Delete all channels (messages cascade), members, then server
    db.delete(schema.channels).where(eq(schema.channels.serverId, id)).run();
    db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, id)).run();
    db.delete(schema.servers).where(eq(schema.servers.id, id)).run();

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

    if (!isAdmin(id, request.userId)) {
      return reply.code(403).send({ error: 'Only admins can generate invite codes', statusCode: 403 });
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
      role: 'member',
      joinedAt: now,
    }).run();

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
      role: 'member',
      joinedAt: now,
    }).run();

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

    const members: MemberWithUser[] = memberRows
      .map(m => {
        const user = userMap.get(m.userId);
        if (!user) return null;
        return {
          serverId: m.serverId,
          userId: m.userId,
          role: (m.role ?? 'member') as MemberWithUser['role'],
          nickname: m.nickname,
          joinedAt: m.joinedAt,
          user: sanitizeUser(user),
        };
      })
      .filter((m): m is MemberWithUser => m !== null);

    return reply.code(200).send(members);
  });

  // PATCH /api/servers/:id/members/:uid - Update member role (owner only)
  app.patch<{ Params: { id: string; uid: string }; Body: UpdateMemberRequest }>('/api/servers/:id/members/:uid', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, uid } = request.params;
    const { role } = request.body;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!isOwner(id, request.userId)) {
      return reply.code(403).send({ error: 'Only the server owner can change member roles', statusCode: 403 });
    }

    if (uid === request.userId) {
      return reply.code(400).send({ error: 'You cannot change your own role', statusCode: 400 });
    }

    if (!role || !['admin', 'member'].includes(role)) {
      return reply.code(400).send({ error: 'Role must be "admin" or "member"', statusCode: 400 });
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

    db.update(schema.serverMembers)
      .set({ role })
      .where(and(
        eq(schema.serverMembers.serverId, id),
        eq(schema.serverMembers.userId, uid),
      ))
      .run();

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

    const result: MemberWithUser = {
      serverId: updatedMember.serverId,
      userId: updatedMember.userId,
      role: (updatedMember.role ?? 'member') as MemberWithUser['role'],
      nickname: updatedMember.nickname,
      joinedAt: updatedMember.joinedAt,
      user: sanitizeUser(user),
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
    const isServerOwnerUser = isOwner(id, request.userId);

    if (!isSelf && !isServerOwnerUser) {
      return reply.code(403).send({ error: 'Only the server owner can kick members', statusCode: 403 });
    }

    // Owner cannot leave their own server - they must delete it
    if (isSelf && isServerOwnerUser) {
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
    if (member.role === 'owner') {
      return reply.code(400).send({ error: 'Cannot remove the server owner', statusCode: 400 });
    }

    db.delete(schema.serverMembers)
      .where(and(
        eq(schema.serverMembers.serverId, id),
        eq(schema.serverMembers.userId, uid),
      ))
      .run();

    return reply.code(200).send({ success: true });
  });
}
