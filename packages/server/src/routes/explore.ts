import type { FastifyInstance } from 'fastify';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { getDb, getRawDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, isServerOwner, hasPermission, computePermissions, PermissionBits, permissionsToString } from '../utils/permissions.js';
import { connectionManager } from '../ws/handler.js';
import { sanitizeUser } from '../utils/sanitize.js';
import type {
  ExploreServer,
  JoinRequest,
  MemberWithUser,
  ServerWithChannelsAndMembers,
  Channel,
} from '@backspace/shared';

function rowToJoinRequest(
  row: typeof schema.joinRequests.$inferSelect,
  user?: ReturnType<typeof sanitizeUser>,
): JoinRequest {
  return {
    id: row.id,
    serverId: row.serverId,
    userId: row.userId,
    message: row.message,
    status: row.status as JoinRequest['status'],
    decidedBy: row.decidedBy,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    user: user ?? undefined,
  };
}

/**
 * Find all online users for a server who have MANAGE_SERVER or are the owner.
 * Used to route join_request_received events.
 */
function getServerManagers(serverId: string): string[] {
  const db = getDb();
  const server = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
  if (!server) return [];

  const memberRows = db.select()
    .from(schema.serverMembers)
    .where(eq(schema.serverMembers.serverId, serverId))
    .all();

  const managers: string[] = [];
  for (const member of memberRows) {
    if (member.userId === server.ownerId || hasPermission(member.userId, serverId, PermissionBits.MANAGE_SERVER)) {
      managers.push(member.userId);
    }
  }
  return managers;
}

/**
 * Build a full ServerWithChannelsAndMembers for a newly joined user.
 * Used after accepting a join request or public join.
 */
function buildFullServer(serverId: string, forUserId: string): ServerWithChannelsAndMembers | null {
  const db = getDb();
  const server = db.select().from(schema.servers).where(eq(schema.servers.id, serverId)).get();
  if (!server) return null;

  const channels = db.select()
    .from(schema.channels)
    .where(eq(schema.channels.serverId, serverId))
    .all();

  const roles = db.select()
    .from(schema.roles)
    .where(eq(schema.roles.serverId, serverId))
    .orderBy(schema.roles.position)
    .all();

  const memberRows = db.select()
    .from(schema.serverMembers)
    .where(eq(schema.serverMembers.serverId, serverId))
    .all();

  const memberUserIds = memberRows.map(m => m.userId);
  const users = memberUserIds.length > 0
    ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
    : [];
  const userMap = new Map(users.map(u => [u.id, u]));

  const memberRoleRows = db.select()
    .from(schema.memberRoles)
    .where(eq(schema.memberRoles.serverId, serverId))
    .all();

  const members: MemberWithUser[] = memberRows
    .map(m => {
      const u = userMap.get(m.userId);
      if (!u) return null;

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
        user: sanitizeUser(u),
        roles: memberRoles,
      };
    })
    .filter((m): m is MemberWithUser => m !== null);

  const serverPerms = computePermissions(forUserId, serverId);

  const visibleChannels: Channel[] = [];
  for (const ch of channels) {
    const chPerms = computePermissions(forUserId, serverId, ch.id);
    const hasView = (chPerms & PermissionBits.VIEW_CHANNEL) !== 0n || (chPerms & PermissionBits.ADMINISTRATOR) !== 0n;
    if (hasView) {
      visibleChannels.push({
        id: ch.id,
        serverId: ch.serverId,
        name: ch.name,
        type: ch.type as Channel['type'],
        topic: ch.topic,
        position: ch.position ?? 0,
        createdAt: ch.createdAt,
        myPermissions: permissionsToString(chPerms),
      });
    }
  }

  return {
    id: server.id,
    name: server.name,
    icon: server.icon,
    ownerId: server.ownerId,
    inviteCode: server.inviteCode,
    visibility: (server.visibility ?? 'private') as ServerWithChannelsAndMembers['visibility'],
    description: server.description ?? null,
    createdAt: server.createdAt,
    channels: visibleChannels,
    members,
    roles: roles.map(r => ({
      id: r.id,
      serverId: r.serverId,
      name: r.name,
      color: r.color ?? '#b9bbbe',
      position: r.position ?? 0,
      permissions: r.permissions ?? undefined,
      isEveryone: r.id === serverId,
      createdAt: r.createdAt,
    })),
    myPermissions: permissionsToString(serverPerms),
  };
}

export async function exploreRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/servers/explore — list discoverable servers
  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>('/api/servers/explore', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();

    // Check instance-level discovery toggle
    const settings = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    if (!settings || settings.discoveryEnabled === 0) {
      return reply.code(200).send({ servers: [], total: 0, discoveryEnabled: false });
    }

    const q = request.query.q?.trim() ?? '';
    const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 100);
    const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);

    // Get user's current server memberships to exclude
    const myMemberships = db.select({ serverId: schema.serverMembers.serverId })
      .from(schema.serverMembers)
      .where(eq(schema.serverMembers.userId, request.userId))
      .all();
    const myServerIds = new Set(myMemberships.map(m => m.serverId));

    // Build raw SQL query for explore — we need a LEFT JOIN for member count
    // which is more efficient to do with raw SQL
    const rawDb = getRawDb();

    // Count ALL discoverable servers (including ones the user has joined) for context
    const totalAllRow = rawDb.prepare(
      `SELECT COUNT(DISTINCT s.id) as total FROM servers s WHERE s.visibility IN ('public', 'request')`
    ).get() as { total: number };

    let countSql = `SELECT COUNT(DISTINCT s.id) as total FROM servers s WHERE s.visibility IN ('public', 'request')`;
    let querySql = `
      SELECT s.id, s.name, s.icon, s.description, s.visibility, s.created_at,
             COUNT(sm.user_id) as member_count
      FROM servers s
      LEFT JOIN server_members sm ON sm.server_id = s.id
      WHERE s.visibility IN ('public', 'request')
    `;

    const params: (string | number)[] = [];

    // Exclude servers the user is already in — do this in SQL for correct total/pagination
    if (myServerIds.size > 0) {
      const placeholders = [...myServerIds].map(() => '?').join(',');
      querySql += ` AND s.id NOT IN (${placeholders})`;
      countSql += ` AND s.id NOT IN (${placeholders})`;
      params.push(...myServerIds);
    }

    if (q) {
      const likePattern = `%${q}%`;
      querySql += ` AND (s.name LIKE ? COLLATE NOCASE OR s.description LIKE ? COLLATE NOCASE)`;
      countSql += ` AND (s.name LIKE ? COLLATE NOCASE OR s.description LIKE ? COLLATE NOCASE)`;
      params.push(likePattern, likePattern);
    }

    querySql += ` GROUP BY s.id ORDER BY member_count DESC, s.created_at DESC LIMIT ? OFFSET ?`;

    const totalRow = rawDb.prepare(countSql).get(...params) as { total: number };
    const rows = rawDb.prepare(querySql).all(...params, limit, offset) as {
      id: string;
      name: string;
      icon: string | null;
      description: string | null;
      visibility: string;
      created_at: number;
      member_count: number;
    }[];

    const servers: ExploreServer[] = rows.map(r => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      description: r.description,
      visibility: r.visibility as ExploreServer['visibility'],
      memberCount: r.member_count,
      createdAt: r.created_at,
    }));

    return reply.code(200).send({ servers, total: totalRow.total, totalAll: totalAllRow.total, discoveryEnabled: true });
  });

  // POST /api/servers/:id/public-join — join a public server without invite
  app.post<{ Params: { id: string } }>('/api/servers/:id/public-join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (server.visibility !== 'public') {
      return reply.code(403).send({ error: 'This server does not allow public joins', statusCode: 403 });
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

    // Register in connectionManager for WS broadcasts
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

    // Return full server data
    const fullServer = buildFullServer(id, request.userId);
    if (!fullServer) {
      return reply.code(500).send({ error: 'Failed to load server', statusCode: 500 });
    }

    return reply.code(200).send(fullServer);
  });

  // POST /api/servers/:id/request-join — request to join a request-only server
  app.post<{ Params: { id: string }; Body: { message?: string } }>('/api/servers/:id/request-join', {
    preHandler: authenticate,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (server.visibility !== 'request') {
      return reply.code(403).send({ error: 'This server does not accept join requests', statusCode: 403 });
    }

    if (isMember(id, request.userId)) {
      return reply.code(409).send({ error: 'You are already a member of this server', statusCode: 409 });
    }

    // Check for existing pending request
    const existingRequest = db.select().from(schema.joinRequests)
      .where(and(
        eq(schema.joinRequests.serverId, id),
        eq(schema.joinRequests.userId, request.userId),
        eq(schema.joinRequests.status, 'pending'),
      ))
      .get();

    if (existingRequest) {
      return reply.code(409).send({ error: 'You already have a pending request for this server', statusCode: 409 });
    }

    const requestId = generateSnowflake();
    const now = Date.now();
    const msgText = request.body?.message?.trim().slice(0, 500) ?? null;

    db.insert(schema.joinRequests).values({
      id: requestId,
      serverId: id,
      userId: request.userId,
      message: msgText,
      status: 'pending',
      createdAt: now,
    }).run();

    const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    const joinRequest = rowToJoinRequest(
      db.select().from(schema.joinRequests).where(eq(schema.joinRequests.id, requestId)).get()!,
      joiningUser ? sanitizeUser(joiningUser) : undefined,
    );

    // Send WS event to server managers (owner + MANAGE_SERVER users)
    const managers = getServerManagers(id);
    for (const managerId of managers) {
      connectionManager.sendToUser(managerId, {
        type: 'join_request_received',
        request: joinRequest,
      });
    }

    return reply.code(201).send(joinRequest);
  });

  // GET /api/servers/:id/join-requests — list join requests for a server
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/api/servers/:id/join-requests', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!isServerOwner(id, request.userId) && !hasPermission(request.userId, id, PermissionBits.MANAGE_SERVER)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SERVER permission', statusCode: 403 });
    }

    const statusFilter = request.query.status ?? 'pending';
    const rows = db.select().from(schema.joinRequests)
      .where(and(
        eq(schema.joinRequests.serverId, id),
        eq(schema.joinRequests.status, statusFilter),
      ))
      .all();

    // Populate user data
    const userIds = rows.map(r => r.userId);
    const users = userIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, userIds)).all()
      : [];
    const userMap = new Map(users.map(u => [u.id, sanitizeUser(u)]));

    const requests: JoinRequest[] = rows.map(r => rowToJoinRequest(r, userMap.get(r.userId)));

    return reply.code(200).send({ requests });
  });

  // PATCH /api/servers/:id/join-requests/:requestId — accept or decline
  app.patch<{ Params: { id: string; requestId: string }; Body: { action: 'accept' | 'decline' } }>('/api/servers/:id/join-requests/:requestId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, requestId } = request.params;
    const { action } = request.body;
    const db = getDb();

    if (!action || (action !== 'accept' && action !== 'decline')) {
      return reply.code(400).send({ error: 'Action must be "accept" or "decline"', statusCode: 400 });
    }

    const server = db.select().from(schema.servers).where(eq(schema.servers.id, id)).get();
    if (!server) {
      return reply.code(404).send({ error: 'Server not found', statusCode: 404 });
    }

    if (!isServerOwner(id, request.userId) && !hasPermission(request.userId, id, PermissionBits.MANAGE_SERVER)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SERVER permission', statusCode: 403 });
    }

    const joinReq = db.select().from(schema.joinRequests).where(eq(schema.joinRequests.id, requestId)).get();
    if (!joinReq || joinReq.serverId !== id) {
      return reply.code(404).send({ error: 'Join request not found', statusCode: 404 });
    }

    if (joinReq.status !== 'pending') {
      return reply.code(400).send({ error: 'This request has already been decided', statusCode: 400 });
    }

    const now = Date.now();

    if (action === 'accept') {
      // Insert member and update request atomically
      db.transaction((tx) => {
        tx.insert(schema.serverMembers).values({
          serverId: id,
          userId: joinReq.userId,
          joinedAt: now,
        }).run();

        tx.update(schema.joinRequests).set({
          status: 'accepted',
          decidedBy: request.userId,
          decidedAt: now,
        }).where(eq(schema.joinRequests.id, requestId)).run();
      });

      // Register in connectionManager
      connectionManager.addUserServer(joinReq.userId, id);

      // Broadcast member_joined to server
      const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, joinReq.userId)).get();
      if (joiningUser) {
        const memberPayload: MemberWithUser = {
          serverId: id,
          userId: joinReq.userId,
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

      // Build full server for the accepted user
      const fullServer = buildFullServer(id, joinReq.userId);

      const updatedRow = db.select().from(schema.joinRequests).where(eq(schema.joinRequests.id, requestId)).get()!;
      const updatedRequest = rowToJoinRequest(updatedRow, joiningUser ? sanitizeUser(joiningUser) : undefined);

      // Send join_request_accepted to the requesting user
      if (fullServer) {
        connectionManager.sendToUser(joinReq.userId, {
          type: 'join_request_accepted',
          request: updatedRequest,
          server: fullServer,
        });
      }

      return reply.code(200).send(updatedRequest);
    } else {
      // Decline
      db.update(schema.joinRequests).set({
        status: 'declined',
        decidedBy: request.userId,
        decidedAt: now,
      }).where(eq(schema.joinRequests.id, requestId)).run();

      const updatedRow = db.select().from(schema.joinRequests).where(eq(schema.joinRequests.id, requestId)).get()!;
      const updatedRequest = rowToJoinRequest(updatedRow);

      // Send join_request_declined to the requesting user
      connectionManager.sendToUser(joinReq.userId, {
        type: 'join_request_declined',
        request: updatedRequest,
      });

      return reply.code(200).send(updatedRequest);
    }
  });

  // GET /api/users/@me/join-requests — list the current user's join requests
  app.get<{ Querystring: { status?: string } }>('/api/users/@me/join-requests', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const statusFilter = request.query.status;

    let rows;
    if (statusFilter) {
      rows = db.select().from(schema.joinRequests)
        .where(and(
          eq(schema.joinRequests.userId, request.userId),
          eq(schema.joinRequests.status, statusFilter),
        ))
        .all();
    } else {
      rows = db.select().from(schema.joinRequests)
        .where(eq(schema.joinRequests.userId, request.userId))
        .all();
    }

    const requests: JoinRequest[] = rows.map(r => rowToJoinRequest(r));

    return reply.code(200).send({ requests });
  });
}
