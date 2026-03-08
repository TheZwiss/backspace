import type { FastifyInstance } from 'fastify';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { getDb, getRawDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { isMember, isSpaceOwner, hasPermission, computePermissions, PermissionBits, permissionsToString } from '../utils/permissions.js';
import { connectionManager } from '../ws/handler.js';
import { sanitizeUser } from '../utils/sanitize.js';
import type {
  ExploreSpace,
  JoinRequest,
  MemberWithUser,
  SpaceWithChannelsAndMembers,
  Channel,
} from '@backspace/shared';

function rowToJoinRequest(
  row: typeof schema.joinRequests.$inferSelect,
  user?: ReturnType<typeof sanitizeUser>,
): JoinRequest {
  return {
    id: row.id,
    spaceId: row.spaceId,
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
 * Find all online users for a space who have MANAGE_SPACE or are the owner.
 * Used to route join_request_received events.
 */
function getSpaceManagers(spaceId: string): string[] {
  const db = getDb();
  const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();
  if (!space) return [];

  const memberRows = db.select()
    .from(schema.spaceMembers)
    .where(eq(schema.spaceMembers.spaceId, spaceId))
    .all();

  const managers: string[] = [];
  for (const member of memberRows) {
    if (member.userId === space.ownerId || hasPermission(member.userId, spaceId, PermissionBits.MANAGE_SPACE)) {
      managers.push(member.userId);
    }
  }
  return managers;
}

/**
 * Build a full SpaceWithChannelsAndMembers for a newly joined user.
 * Used after accepting a join request or public join.
 */
function buildFullSpace(spaceId: string, forUserId: string): SpaceWithChannelsAndMembers | null {
  const db = getDb();
  const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();
  if (!space) return null;

  const channels = db.select()
    .from(schema.channels)
    .where(eq(schema.channels.spaceId, spaceId))
    .all();

  const roles = db.select()
    .from(schema.roles)
    .where(eq(schema.roles.spaceId, spaceId))
    .orderBy(schema.roles.position)
    .all();

  const memberRows = db.select()
    .from(schema.spaceMembers)
    .where(eq(schema.spaceMembers.spaceId, spaceId))
    .all();

  const memberUserIds = memberRows.map(m => m.userId);
  const users = memberUserIds.length > 0
    ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
    : [];
  const userMap = new Map(users.map(u => [u.id, u]));

  const memberRoleRows = db.select()
    .from(schema.memberRoles)
    .where(eq(schema.memberRoles.spaceId, spaceId))
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
        user: sanitizeUser(u),
        roles: memberRoles,
      };
    })
    .filter((m): m is MemberWithUser => m !== null);

  const spacePerms = computePermissions(forUserId, spaceId);

  const visibleChannels: Channel[] = [];
  for (const ch of channels) {
    const chPerms = computePermissions(forUserId, spaceId, ch.id);
    const hasView = (chPerms & PermissionBits.VIEW_CHANNEL) !== 0n || (chPerms & PermissionBits.ADMINISTRATOR) !== 0n;
    if (hasView) {
      visibleChannels.push({
        id: ch.id,
        spaceId: ch.spaceId,
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
    id: space.id,
    name: space.name,
    icon: space.icon,
    ownerId: space.ownerId,
    inviteCode: space.inviteCode,
    visibility: (space.visibility ?? 'private') as SpaceWithChannelsAndMembers['visibility'],
    description: space.description ?? null,
    createdAt: space.createdAt,
    channels: visibleChannels,
    members,
    roles: roles.map(r => ({
      id: r.id,
      spaceId: r.spaceId,
      name: r.name,
      color: r.color ?? '#b9bbbe',
      position: r.position ?? 0,
      permissions: r.permissions ?? undefined,
      isEveryone: r.id === spaceId,
      createdAt: r.createdAt,
    })),
    myPermissions: permissionsToString(spacePerms),
  };
}

export async function exploreRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/spaces/explore — list discoverable spaces
  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>('/api/spaces/explore', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();

    // Check instance-level discovery toggle
    const settings = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    if (!settings || settings.discoveryEnabled === 0) {
      return reply.code(200).send({ spaces: [], total: 0, discoveryEnabled: false });
    }

    const q = request.query.q?.trim() ?? '';
    const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 100);
    const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);

    // Get user's current space memberships to exclude
    const myMemberships = db.select({ spaceId: schema.spaceMembers.spaceId })
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.userId, request.userId))
      .all();
    const mySpaceIds = new Set(myMemberships.map(m => m.spaceId));

    // Build raw SQL query for explore — we need a LEFT JOIN for member count
    // which is more efficient to do with raw SQL
    const rawDb = getRawDb();

    // Count ALL discoverable spaces (including ones the user has joined) for context
    const totalAllRow = rawDb.prepare(
      `SELECT COUNT(DISTINCT s.id) as total FROM spaces s WHERE s.visibility IN ('public', 'request')`
    ).get() as { total: number };

    let countSql = `SELECT COUNT(DISTINCT s.id) as total FROM spaces s WHERE s.visibility IN ('public', 'request')`;
    let querySql = `
      SELECT s.id, s.name, s.icon, s.description, s.visibility, s.created_at,
             COUNT(sm.user_id) as member_count
      FROM spaces s
      LEFT JOIN space_members sm ON sm.space_id = s.id
      WHERE s.visibility IN ('public', 'request')
    `;

    const params: (string | number)[] = [];

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

    const spaces: ExploreSpace[] = rows.map(r => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      description: r.description,
      visibility: r.visibility as ExploreSpace['visibility'],
      memberCount: r.member_count,
      createdAt: r.created_at,
      joined: mySpaceIds.has(r.id),
    }));

    return reply.code(200).send({ spaces, total: totalRow.total, totalAll: totalAllRow.total, discoveryEnabled: true });
  });

  // POST /api/spaces/:id/public-join — join a public space without invite
  app.post<{ Params: { id: string } }>('/api/spaces/:id/public-join', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!space) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (space.visibility !== 'public') {
      return reply.code(403).send({ error: 'This space does not allow public joins', statusCode: 403 });
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

    // Register in connectionManager for WS broadcasts
    connectionManager.addUserSpace(request.userId, id);

    // Broadcast member_joined to existing space members
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

    // Return full space data
    const fullSpace = buildFullSpace(id, request.userId);
    if (!fullSpace) {
      return reply.code(500).send({ error: 'Failed to load space', statusCode: 500 });
    }

    return reply.code(200).send(fullSpace);
  });

  // POST /api/spaces/:id/request-join — request to join a request-only space
  app.post<{ Params: { id: string }; Body: { message?: string } }>('/api/spaces/:id/request-join', {
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

    const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!space) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (space.visibility !== 'request') {
      return reply.code(403).send({ error: 'This space does not accept join requests', statusCode: 403 });
    }

    if (isMember(id, request.userId)) {
      return reply.code(409).send({ error: 'You are already a member of this space', statusCode: 409 });
    }

    // Check for existing pending request
    const existingRequest = db.select().from(schema.joinRequests)
      .where(and(
        eq(schema.joinRequests.spaceId, id),
        eq(schema.joinRequests.userId, request.userId),
        eq(schema.joinRequests.status, 'pending'),
      ))
      .get();

    if (existingRequest) {
      return reply.code(409).send({ error: 'You already have a pending request for this space', statusCode: 409 });
    }

    const requestId = generateSnowflake();
    const now = Date.now();
    const msgText = request.body?.message?.trim().slice(0, 500) ?? null;

    db.insert(schema.joinRequests).values({
      id: requestId,
      spaceId: id,
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

    // Send WS event to space managers (owner + MANAGE_SPACE users)
    const managers = getSpaceManagers(id);
    for (const managerId of managers) {
      connectionManager.sendToUser(managerId, {
        type: 'join_request_received',
        request: joinRequest,
      });
    }

    return reply.code(201).send(joinRequest);
  });

  // GET /api/spaces/:id/join-requests — list join requests for a space
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/api/spaces/:id/join-requests', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!space) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!isSpaceOwner(id, request.userId) && !hasPermission(request.userId, id, PermissionBits.MANAGE_SPACE)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SPACE permission', statusCode: 403 });
    }

    const statusFilter = request.query.status ?? 'pending';
    const rows = db.select().from(schema.joinRequests)
      .where(and(
        eq(schema.joinRequests.spaceId, id),
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

  // PATCH /api/spaces/:id/join-requests/:requestId — accept or decline
  app.patch<{ Params: { id: string; requestId: string }; Body: { action: 'accept' | 'decline' } }>('/api/spaces/:id/join-requests/:requestId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id, requestId } = request.params;
    const { action } = request.body;
    const db = getDb();

    if (!action || (action !== 'accept' && action !== 'decline')) {
      return reply.code(400).send({ error: 'Action must be "accept" or "decline"', statusCode: 400 });
    }

    const space = db.select().from(schema.spaces).where(eq(schema.spaces.id, id)).get();
    if (!space) {
      return reply.code(404).send({ error: 'Space not found', statusCode: 404 });
    }

    if (!isSpaceOwner(id, request.userId) && !hasPermission(request.userId, id, PermissionBits.MANAGE_SPACE)) {
      return reply.code(403).send({ error: 'Missing MANAGE_SPACE permission', statusCode: 403 });
    }

    const joinReq = db.select().from(schema.joinRequests).where(eq(schema.joinRequests.id, requestId)).get();
    if (!joinReq || joinReq.spaceId !== id) {
      return reply.code(404).send({ error: 'Join request not found', statusCode: 404 });
    }

    if (joinReq.status !== 'pending') {
      return reply.code(400).send({ error: 'This request has already been decided', statusCode: 400 });
    }

    const now = Date.now();

    if (action === 'accept') {
      // Insert member and update request atomically
      db.transaction((tx) => {
        tx.insert(schema.spaceMembers).values({
          spaceId: id,
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
      connectionManager.addUserSpace(joinReq.userId, id);

      // Broadcast member_joined to space
      const joiningUser = db.select().from(schema.users).where(eq(schema.users.id, joinReq.userId)).get();
      if (joiningUser) {
        const memberPayload: MemberWithUser = {
          spaceId: id,
          userId: joinReq.userId,
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

      // Build full space for the accepted user
      const fullSpace = buildFullSpace(id, joinReq.userId);

      const updatedRow = db.select().from(schema.joinRequests).where(eq(schema.joinRequests.id, requestId)).get()!;
      const updatedRequest = rowToJoinRequest(updatedRow, joiningUser ? sanitizeUser(joiningUser) : undefined);

      // Send join_request_accepted to the requesting user
      if (fullSpace) {
        connectionManager.sendToUser(joinReq.userId, {
          type: 'join_request_accepted',
          request: updatedRequest,
          space: fullSpace,
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
