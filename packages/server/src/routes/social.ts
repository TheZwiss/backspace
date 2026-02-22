import type { FastifyInstance } from 'fastify';
import { eq, and, or, ne, like } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { connectionManager } from '../ws/handler.js';
import type {
  User,
  Friend,
  FriendRequest,
  SendFriendRequest,
  UpdateFriendRequest,
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

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/social/friends - List all friends
  app.get('/api/social/friends', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();

    // Get all friends where current user is either userId or friendId
    const friendRows = db.select()
      .from(schema.friends)
      .where(or(
        eq(schema.friends.userId, request.userId),
        eq(schema.friends.friendId, request.userId)
      ))
      .all();

    if (friendRows.length === 0) {
      return reply.code(200).send([]);
    }

    // Get the IDs of the actual friends (not the current user)
    const friendIds = friendRows.map(f => f.userId === request.userId ? f.friendId : f.userId);

    const friendUsers = db.select()
      .from(schema.users)
      .where(or(...friendIds.map(id => eq(schema.users.id, id))))
      .all();

    const friends: Friend[] = friendUsers.map(u => {
      const relationship = friendRows.find(f => f.userId === u.id || f.friendId === u.id);
      return {
        ...sanitizeUser(u),
        addedAt: relationship?.createdAt ?? Date.now(),
      };
    });

    return reply.code(200).send(friends);
  });

  // GET /api/social/requests - List pending friend requests
  app.get('/api/social/requests', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();

    const requests = db.select()
      .from(schema.friendRequests)
      .where(and(
        or(
          eq(schema.friendRequests.fromId, request.userId),
          eq(schema.friendRequests.toId, request.userId)
        ),
        eq(schema.friendRequests.status, 'pending')
      ))
      .all();

    if (requests.length === 0) {
      return reply.code(200).send([]);
    }

    // Enhance with user data
    const userIds = requests.map(r => r.fromId === request.userId ? r.toId : r.fromId);
    const users = db.select()
      .from(schema.users)
      .where(or(...userIds.map(id => eq(schema.users.id, id))))
      .all();

    const userMap = new Map(users.map(u => [u.id, u]));

    const result: FriendRequest[] = requests.map(r => {
      const otherId = r.fromId === request.userId ? r.toId : r.fromId;
      const otherUser = userMap.get(otherId);
      return {
        id: r.id,
        fromId: r.fromId,
        toId: r.toId,
        status: (r.status ?? 'pending') as any,
        createdAt: r.createdAt,
        user: otherUser ? sanitizeUser(otherUser) : undefined,
      };
    });

    return reply.code(200).send(result);
  });

  // POST /api/social/requests - Send a friend request
  app.post<{ Body: SendFriendRequest }>('/api/social/requests', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { username } = request.body;
    const db = getDb();

    if (!username) {
      return reply.code(400).send({ error: 'Username is required', statusCode: 400 });
    }

    // Find the target user
    const targetUser = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    if (!targetUser) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    if (targetUser.id === request.userId) {
      return reply.code(400).send({ error: 'You cannot add yourself as a friend', statusCode: 400 });
    }

    // Check if already friends
    const existingFriend = db.select().from(schema.friends).where(or(
      and(eq(schema.friends.userId, request.userId), eq(schema.friends.friendId, targetUser.id)),
      and(eq(schema.friends.userId, targetUser.id), eq(schema.friends.friendId, request.userId))
    )).get();

    if (existingFriend) {
      return reply.code(400).send({ error: 'You are already friends with this user', statusCode: 400 });
    }

    // Check for existing pending request
    const existingRequest = db.select().from(schema.friendRequests).where(and(
      or(
        and(eq(schema.friendRequests.fromId, request.userId), eq(schema.friendRequests.toId, targetUser.id)),
        and(eq(schema.friendRequests.fromId, targetUser.id), eq(schema.friendRequests.toId, request.userId))
      ),
      eq(schema.friendRequests.status, 'pending')
    )).get();

    if (existingRequest) {
      return reply.code(400).send({ error: 'A friend request is already pending', statusCode: 400 });
    }

    // Create the request
    const id = generateSnowflake();
    const now = Date.now();
    db.insert(schema.friendRequests).values({
      id,
      fromId: request.userId,
      toId: targetUser.id,
      status: 'pending',
      createdAt: now,
    }).run();

    // Get the sender user for the WS event
    const senderUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();

    // Broadcast friend_request_received to the target user
    const friendRequestPayload: FriendRequest = {
      id,
      fromId: request.userId,
      toId: targetUser.id,
      status: 'pending',
      createdAt: now,
      user: senderUser ? sanitizeUser(senderUser) : undefined,
    };

    connectionManager.sendToUser(targetUser.id, {
      type: 'friend_request_received',
      request: friendRequestPayload,
    });

    return reply.code(201).send({ success: true });
  });

  // PATCH /api/social/requests/:id - Accept/Decline a friend request
  app.patch<{ Params: { id: string }; Body: UpdateFriendRequest }>('/api/social/requests/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { status } = request.body;
    const db = getDb();

    if (!['accepted', 'declined'].includes(status)) {
      return reply.code(400).send({ error: 'Invalid status', statusCode: 400 });
    }

    const friendRequest = db.select().from(schema.friendRequests).where(eq(schema.friendRequests.id, id)).get();
    if (!friendRequest) {
      return reply.code(404).send({ error: 'Friend request not found', statusCode: 404 });
    }

    if (friendRequest.toId !== request.userId) {
      return reply.code(403).send({ error: 'You can only manage requests sent to you', statusCode: 403 });
    }

    if (status === 'accepted') {
      // Add to friends table
      const now = Date.now();
      db.insert(schema.friends).values({
        userId: friendRequest.fromId,
        friendId: friendRequest.toId,
        createdAt: now,
      }).run();

      // Get the accepting user's data for the WS event
      const acceptingUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
      if (acceptingUser) {
        const friend: Friend = {
          ...sanitizeUser(acceptingUser),
          addedAt: now,
        };
        connectionManager.sendToUser(friendRequest.fromId, {
          type: 'friend_request_accepted',
          friend,
          requestId: id,
        });
      }
    }

    // Update request status
    db.update(schema.friendRequests)
      .set({ status })
      .where(eq(schema.friendRequests.id, id))
      .run();

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/social/requests/:id - Cancel an outgoing friend request
  app.delete<{ Params: { id: string } }>('/api/social/requests/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const friendRequest = db.select().from(schema.friendRequests).where(eq(schema.friendRequests.id, id)).get();
    if (!friendRequest) {
      return reply.code(404).send({ error: 'Friend request not found', statusCode: 404 });
    }

    // Only the sender can cancel an outgoing request
    if (friendRequest.fromId !== request.userId) {
      return reply.code(403).send({ error: 'You can only cancel requests you sent', statusCode: 403 });
    }

    if (friendRequest.status !== 'pending') {
      return reply.code(400).send({ error: 'Can only cancel pending requests', statusCode: 400 });
    }

    db.delete(schema.friendRequests)
      .where(eq(schema.friendRequests.id, id))
      .run();

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/social/friends/:id - Remove a friend
  app.delete<{ Params: { id: string } }>('/api/social/friends/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    db.delete(schema.friends).where(or(
      and(eq(schema.friends.userId, request.userId), eq(schema.friends.friendId, id)),
      and(eq(schema.friends.userId, id), eq(schema.friends.friendId, request.userId))
    )).run();

    // Broadcast friend_removed to the other user so their friends list updates
    connectionManager.sendToUser(id, {
      type: 'friend_removed',
      userId: request.userId,
    });

    return reply.code(200).send({ success: true });
  });

  // GET /api/social/search?q=... - Search for users to add as friends
  app.get<{ Querystring: { q: string } }>('/api/social/search', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { q } = request.query;
    const db = getDb();

    if (!q || q.length < 2) {
      return reply.code(200).send([]);
    }

    const pattern = `%${q}%`;

    // Search by username or display name with partial matching, excluding current user
    const users = db.select()
      .from(schema.users)
      .where(and(
        or(
          like(schema.users.username, pattern),
          like(schema.users.displayName, pattern)
        ),
        ne(schema.users.id, request.userId)
      ))
      .limit(10)
      .all();

    return reply.code(200).send(users.map(sanitizeUser));
  });
}
