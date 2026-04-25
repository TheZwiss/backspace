import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, or, ne, like, sql, inArray } from 'drizzle-orm';
import { getDb, getRawDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { connectionManager } from '../ws/handler.js';
import { appendMutationLog, queueOutboxEvent, buildFriendContextId, getFriendEventTargets } from '../utils/federationOutbox.js';
import { getOurOrigin, normalizeOriginForCompare } from '../utils/federationAuth.js';
import { ensurePeered } from '../utils/federationPeering.js';
import { lookupRemoteUser } from '../utils/federationLookup.js';
import { resolveOriginFromHostname } from '../utils/federationOriginResolve.js';
import { resolveOrCreateReplicatedUser, hydrateReplicatedUserProfile } from './federation.js';
import type { FederationRelayEvent, FederationRelayProfileSnapshot } from '@backspace/shared';
import type {
  Friend,
  FriendRequest,
  SendFriendRequest,
  UpdateFriendRequest,
  DiscoverUser,
} from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';

function buildProfileSnapshot(user: typeof schema.users.$inferSelect): FederationRelayProfileSnapshot {
  return {
    username: user.username ?? null,
    displayName: user.displayName ?? null,
    avatar: user.avatar ?? null,
    avatarColor: user.avatarColor ?? null,
    banner: user.banner ?? null,
    bio: user.bio ?? null,
  };
}

// ─── Local friend request helper ─────────────────────────────────────────────

async function handleLocalFriendRequest(
  db: ReturnType<typeof getDb>,
  request: FastifyRequest,
  reply: FastifyReply,
  localUsername: string,
  sender: typeof schema.users.$inferSelect,
  ourOrigin: string,
): Promise<unknown> {
  // Match the canonical-lowercase form used by auth (auth.ts:32, 211, 256).
  const lookupUsername = localUsername.toLowerCase();

  // Find the target user
  const targetUser = db.select().from(schema.users).where(eq(schema.users.username, lookupUsername)).get();
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

  // Broadcast friend_request_received to the target user
  const friendRequestPayload: FriendRequest = {
    id,
    fromId: request.userId,
    toId: targetUser.id,
    status: 'pending',
    createdAt: now,
    user: sanitizeUser(sender),
  };

  connectionManager.sendToUser(targetUser.id, {
    type: 'friend_request_received',
    request: friendRequestPayload,
  });

  // Federation relay: notify the target user's home instance
  const fromIdentity = {
    homeUserId: sender.homeUserId || request.userId,
    homeInstance: sender.homeInstance || ourOrigin,
  };
  const toIdentity = {
    homeUserId: targetUser.homeUserId || targetUser.id,
    homeInstance: targetUser.homeInstance || ourOrigin,
  };

  const targets = getFriendEventTargets(fromIdentity.homeInstance, toIdentity.homeInstance);
  if (targets.length > 0) {
    const contextId = buildFriendContextId(fromIdentity.homeUserId, toIdentity.homeUserId);
    const entityId = `friend_req:${[fromIdentity.homeUserId, toIdentity.homeUserId].sort().join(':')}:${now}`;

    const payload: FederationRelayEvent = {
      eventType: 'friend_request_create',
      contextType: 'friend',
      messageId: entityId,
      encryptionVersion: 0,
      timestamp: now,
      friendship: {
        from: fromIdentity,
        to: toIdentity,
        fromProfile: buildProfileSnapshot(sender),
        toProfile: buildProfileSnapshot(targetUser),
        status: 'pending',
        createdAt: now,
      },
    };

    const payloadStr = JSON.stringify(payload);
    appendMutationLog(entityId, contextId, 'friend_request_create', payloadStr, 'friend');
    queueOutboxEvent(entityId, contextId, 'friend_request_create', payloadStr, targets, 'friend');
  }

  return reply.code(201).send({ success: true, requestId: id });
}

// ─── Federated friend request helper ─────────────────────────────────────────

async function handleFederatedFriendRequest(
  db: ReturnType<typeof getDb>,
  request: FastifyRequest,
  reply: FastifyReply,
  raw: string,
  atIndex: number,
  sender: typeof schema.users.$inferSelect,
  ourOrigin: string,
): Promise<unknown> {
  const baseName = raw.slice(0, atIndex).toLowerCase();
  const targetDomain = raw.slice(atIndex + 1).toLowerCase();

  // 1. Resolve scheme
  const peerOrigin = resolveOriginFromHostname(targetDomain);
  if (!peerOrigin) {
    return reply.code(400).send({ error: 'invalid_target_domain', statusCode: 400, domain: targetDomain });
  }

  // 2. ensurePeered — block until 'active', or surface peer status as error
  const peering = await ensurePeered(peerOrigin);
  if (peering.status === 'rejected') {
    return reply.code(403).send({ error: 'peer_rejected', statusCode: 403, domain: targetDomain });
  }
  if (peering.status === 'failed') {
    return reply.code(503).send({ error: 'peer_unreachable', statusCode: 503, domain: targetDomain });
  }
  if (peering.status === 'pending') {
    const peerRow = db.select({ status: schema.federationPeers.status })
      .from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, peerOrigin))
      .get();
    if (peerRow?.status === 'awaiting_approval') {
      return reply.code(409).send({ error: 'peer_pending_approval', statusCode: 409, domain: targetDomain });
    }
    return reply.code(409).send({ error: 'peer_pending', statusCode: 409, domain: targetDomain });
  }
  // peering.status === 'active' — continue

  // 3. Lookup
  const lookup = await lookupRemoteUser(peerOrigin, baseName);
  if (!lookup.ok) {
    if (lookup.reason === 'not_found') {
      return reply.code(404).send({ error: 'user_not_found', statusCode: 404, domain: targetDomain, handle: baseName });
    }
    if (lookup.reason === 'unreachable') {
      return reply.code(503).send({ error: 'peer_unreachable', statusCode: 503, domain: targetDomain });
    }
    if (lookup.reason === 'rate_limited') {
      const headers: Record<string, string> = {};
      if (lookup.retryAfter) headers['Retry-After'] = String(lookup.retryAfter);
      return reply.code(429).headers(headers).send({ error: 'lookup_rate_limited', statusCode: 429 });
    }
    // Exhaustive — should be unreachable.
    return reply.code(500).send({ error: 'unknown_lookup_failure', statusCode: 500 });
  }

  // 4. Self-friend pre-check
  const senderCanonicalId = sender.homeUserId || sender.id;
  if (
    lookup.homeUserId === senderCanonicalId &&
    normalizeOriginForCompare(peerOrigin) === normalizeOriginForCompare(ourOrigin)
  ) {
    return reply.code(400).send({ error: 'cannot_friend_self', statusCode: 400 });
  }

  // 5. Resolve / hydrate stub
  const stub = resolveOrCreateReplicatedUser(lookup.homeUserId, targetDomain, db, { username: lookup.username });
  if (!stub) {
    // Tombstoned identity — refuse to resurrect.
    return reply.code(404).send({ error: 'user_not_found', statusCode: 404, domain: targetDomain, handle: baseName });
  }
  const stubHydrated = hydrateReplicatedUserProfile(stub, lookup.profile, db);

  // 6. Transaction: insert + log + queue outbox
  const now = Date.now();
  const fromIdentity = {
    homeUserId: sender.homeUserId || sender.id,
    homeInstance: ourOrigin,
  };
  const toIdentity = {
    homeUserId: stubHydrated.homeUserId!,
    homeInstance: peerOrigin,
  };
  const contextId = buildFriendContextId(fromIdentity.homeUserId, toIdentity.homeUserId);
  const entityId = `friend_req:${[fromIdentity.homeUserId, toIdentity.homeUserId].sort().join(':')}:${now}`;
  const requestId = generateSnowflake();

  const payload: FederationRelayEvent = {
    eventType: 'friend_request_create',
    contextType: 'friend',
    messageId: entityId,
    encryptionVersion: 0,
    timestamp: now,
    friendship: {
      from: fromIdentity,
      to: toIdentity,
      fromProfile: buildProfileSnapshot(sender),
      toProfile: {
        username: stubHydrated.username,
        displayName: lookup.profile.displayName,
        avatar: lookup.profile.avatar,
        avatarColor: lookup.profile.avatarColor,
        banner: lookup.profile.banner,
        bio: lookup.profile.bio,
      },
      status: 'pending',
      createdAt: now,
    },
  };
  const payloadStr = JSON.stringify(payload);

  const rawDb = getRawDb();
  rawDb.transaction(() => {
    db.insert(schema.friendRequests).values({
      id: requestId,
      fromId: sender.id,
      toId: stubHydrated.id,
      status: 'pending',
      createdAt: now,
      relayMessageId: entityId,
    }).run();
    appendMutationLog(entityId, contextId, 'friend_request_create', payloadStr, 'friend');
    queueOutboxEvent(entityId, contextId, 'friend_request_create', payloadStr, [peerOrigin], 'friend');
  })();

  // 7. WS broadcast to sender's other tabs/devices
  const requestSnapshot: FriendRequest = {
    id: requestId,
    fromId: sender.id,
    toId: stubHydrated.id,
    status: 'pending',
    createdAt: now,
    user: sanitizeUser(stubHydrated),
  };
  connectionManager.sendToUser(sender.id, { type: 'friend_request_sent', request: requestSnapshot });

  return reply.code(201).send({ success: true, requestId });
}

// ─── Route registration ───────────────────────────────────────────────────────

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

  // POST /api/social/requests - Send a friend request (local or federated)
  app.post<{ Body: SendFriendRequest }>('/api/social/requests', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { username } = request.body;
    const db = getDb();

    if (!username || typeof username !== 'string') {
      return reply.code(400).send({ error: 'username_required', statusCode: 400 });
    }

    const raw = username.trim();
    if (!raw) return reply.code(400).send({ error: 'username_required', statusCode: 400 });

    const sender = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!sender) return reply.code(401).send({ error: 'authenticated user not found', statusCode: 401 });

    const ourOrigin = getOurOrigin();
    const ourHost = normalizeOriginForCompare(ourOrigin);

    // Authority defense — only native users may originate friend_request_create
    // outbox events from this instance (spec §5.6). Done before any branching.
    const senderHomeNorm = normalizeOriginForCompare(sender.homeInstance);
    if (senderHomeNorm && senderHomeNorm !== ourHost) {
      return reply.code(403).send({ error: 'not_authoritative_for_sender', statusCode: 403 });
    }

    const atIndex = raw.lastIndexOf('@');
    const isFederated =
      atIndex > 0 &&
      atIndex < raw.length - 1 &&
      normalizeOriginForCompare(raw.slice(atIndex + 1)) !== ourHost;

    if (!isFederated) {
      const localUsername = atIndex > 0 ? raw.slice(0, atIndex) : raw;
      return handleLocalFriendRequest(db, request, reply, localUsername, sender, ourOrigin);
    }
    return handleFederatedFriendRequest(db, request, reply, raw, atIndex, sender, ourOrigin);
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
      // Insert friend and update request status atomically
      const now = Date.now();
      db.transaction((tx) => {
        tx.insert(schema.friends).values({
          userId: friendRequest.fromId,
          friendId: friendRequest.toId,
          createdAt: now,
        }).run();

        tx.update(schema.friendRequests)
          .set({ status })
          .where(eq(schema.friendRequests.id, id))
          .run();
      });

      // WS broadcast AFTER transaction commits
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
    } else {
      // For declined, just update the status (single write, no transaction needed)
      db.update(schema.friendRequests)
        .set({ status })
        .where(eq(schema.friendRequests.id, id))
        .run();

      // Broadcast to the original sender so their UI updates in real-time
      connectionManager.sendToUser(friendRequest.fromId, {
        type: 'friend_request_declined',
        requestId: id,
        userId: request.userId,
      });
    }

    // Federation relay: notify the other user's home instance
    const domainOrigin = getOurOrigin();

    const fromUser = db.select().from(schema.users).where(eq(schema.users.id, friendRequest.fromId)).get();
    const toUser = db.select().from(schema.users).where(eq(schema.users.id, friendRequest.toId)).get();

    if (fromUser && toUser) {
      const fromIdentity = {
        homeUserId: fromUser.homeUserId || fromUser.id,
        homeInstance: fromUser.homeInstance || domainOrigin,
      };
      const toIdentity = {
        homeUserId: toUser.homeUserId || toUser.id,
        homeInstance: toUser.homeInstance || domainOrigin,
      };

      const targets = getFriendEventTargets(fromIdentity.homeInstance, toIdentity.homeInstance);
      if (targets.length > 0) {
        const contextId = buildFriendContextId(fromIdentity.homeUserId, toIdentity.homeUserId);
        const now2 = Date.now();

        // Relay request status update
        const updateEntityId = `friend_req:${[fromIdentity.homeUserId, toIdentity.homeUserId].sort().join(':')}:${now2}`;
        const updatePayload: FederationRelayEvent = {
          eventType: 'friend_request_update',
          contextType: 'friend',
          messageId: updateEntityId,
          encryptionVersion: 0,
          timestamp: now2,
          friendship: {
            from: fromIdentity,
            to: toIdentity,
            fromProfile: buildProfileSnapshot(fromUser),
            toProfile: buildProfileSnapshot(toUser),
            status: status as 'accepted' | 'declined',
            createdAt: friendRequest.createdAt,
          },
        };
        const updateStr = JSON.stringify(updatePayload);
        appendMutationLog(updateEntityId, contextId, 'friend_request_update', updateStr, 'friend');
        queueOutboxEvent(updateEntityId, contextId, 'friend_request_update', updateStr, targets, 'friend');

        // If accepted, also relay friend_add
        if (status === 'accepted') {
          const addEntityId = `friend:${[fromIdentity.homeUserId, toIdentity.homeUserId].sort().join(':')}:${now2}`;
          const addPayload: FederationRelayEvent = {
            eventType: 'friend_add',
            contextType: 'friend',
            messageId: addEntityId,
            encryptionVersion: 0,
            timestamp: now2,
            friendship: {
              from: fromIdentity,
              to: toIdentity,
              fromProfile: buildProfileSnapshot(fromUser),
              toProfile: buildProfileSnapshot(toUser),
              createdAt: now2,
            },
          };
          const addStr = JSON.stringify(addPayload);
          appendMutationLog(addEntityId, contextId, 'friend_add', addStr, 'friend');
          queueOutboxEvent(addEntityId, contextId, 'friend_add', addStr, targets, 'friend');
        }
      }
    }

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

    // Broadcast to the recipient so their UI updates in real-time
    connectionManager.sendToUser(friendRequest.toId, {
      type: 'friend_request_cancelled',
      requestId: id,
      userId: request.userId,
    });

    // Federation relay: notify the recipient's home instance
    const domainOrigin = getOurOrigin();
    const callerUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    const recipientUser = db.select().from(schema.users).where(eq(schema.users.id, friendRequest.toId)).get();

    if (callerUser && recipientUser) {
      const fromIdentity = {
        homeUserId: callerUser.homeUserId || callerUser.id,
        homeInstance: callerUser.homeInstance || domainOrigin,
      };
      const toIdentity = {
        homeUserId: recipientUser.homeUserId || recipientUser.id,
        homeInstance: recipientUser.homeInstance || domainOrigin,
      };

      const targets = getFriendEventTargets(fromIdentity.homeInstance, toIdentity.homeInstance);
      if (targets.length > 0) {
        const contextId = buildFriendContextId(fromIdentity.homeUserId, toIdentity.homeUserId);
        const now = Date.now();
        const entityId = `friend_req:${[fromIdentity.homeUserId, toIdentity.homeUserId].sort().join(':')}:${now}`;

        const payload: FederationRelayEvent = {
          eventType: 'friend_request_cancel',
          contextType: 'friend',
          messageId: entityId,
          encryptionVersion: 0,
          timestamp: now,
          friendship: {
            from: fromIdentity,
            to: toIdentity,
            createdAt: friendRequest.createdAt,
          },
        };
        const payloadStr = JSON.stringify(payload);
        appendMutationLog(entityId, contextId, 'friend_request_cancel', payloadStr, 'friend');
        queueOutboxEvent(entityId, contextId, 'friend_request_cancel', payloadStr, targets, 'friend');
      }
    }

    return reply.code(200).send({ success: true });
  });

  // DELETE /api/social/friends/:id - Remove a friend
  app.delete<{ Params: { id: string } }>('/api/social/friends/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    // Check friendship exists before deleting
    const existing = db.select().from(schema.friends).where(or(
      and(eq(schema.friends.userId, request.userId), eq(schema.friends.friendId, id)),
      and(eq(schema.friends.userId, id), eq(schema.friends.friendId, request.userId))
    )).get();

    if (!existing) {
      return reply.code(404).send({ error: 'You are not friends with this user', statusCode: 404 });
    }

    db.delete(schema.friends).where(or(
      and(eq(schema.friends.userId, request.userId), eq(schema.friends.friendId, id)),
      and(eq(schema.friends.userId, id), eq(schema.friends.friendId, request.userId))
    )).run();

    // Broadcast friend_removed to the other user so their friends list updates
    connectionManager.sendToUser(id, {
      type: 'friend_removed',
      userId: request.userId,
    });

    // Federation relay: notify the other user's home instance
    const domainOrigin = getOurOrigin();
    const callerUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    const otherUser = db.select().from(schema.users).where(eq(schema.users.id, id)).get();

    if (callerUser && otherUser) {
      const callerIdentity = {
        homeUserId: callerUser.homeUserId || callerUser.id,
        homeInstance: callerUser.homeInstance || domainOrigin,
      };
      const otherIdentity = {
        homeUserId: otherUser.homeUserId || otherUser.id,
        homeInstance: otherUser.homeInstance || domainOrigin,
      };

      const targets = getFriendEventTargets(callerIdentity.homeInstance, otherIdentity.homeInstance);
      if (targets.length > 0) {
        const contextId = buildFriendContextId(callerIdentity.homeUserId, otherIdentity.homeUserId);
        const now = Date.now();
        const entityId = `friend:${[callerIdentity.homeUserId, otherIdentity.homeUserId].sort().join(':')}:${now}`;

        const payload: FederationRelayEvent = {
          eventType: 'friend_remove',
          contextType: 'friend',
          messageId: entityId,
          encryptionVersion: 0,
          timestamp: now,
          friendship: {
            from: callerIdentity,
            to: otherIdentity,
            createdAt: now,
          },
        };
        const payloadStr = JSON.stringify(payload);
        appendMutationLog(entityId, contextId, 'friend_remove', payloadStr, 'friend');
        queueOutboxEvent(entityId, contextId, 'friend_remove', payloadStr, targets, 'friend');
      }
    }

    return reply.code(200).send({ success: true });
  });

  // GET /api/social/discover - Discover users on this instance
  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>('/api/social/discover', {
    preHandler: authenticate,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const db = getDb();
    const q = request.query.q?.trim() || '';
    const limit = Math.min(Math.max(parseInt(request.query.limit || '24', 10) || 24, 1), 100);
    const offset = Math.max(parseInt(request.query.offset || '0', 10) || 0, 0);
    const myId = request.userId;

    // Build WHERE clause
    const conditions = [
      eq(schema.users.discoverable, 1),
      eq(schema.users.isDeleted, 0),
      ne(schema.users.id, myId),
      // Exclude replicated federated users — each instance only surfaces its own native users.
      // Federated users are discovered through the parallel fetch across connected instances.
      sql`(${schema.users.homeInstance} IS NULL OR ${schema.users.homeInstance} = '')`,
    ];

    if (q) {
      const pattern = `%${q}%`;
      conditions.push(or(
        like(schema.users.username, pattern),
        like(schema.users.displayName, pattern),
      )!);
    }

    // Get total count
    const countResult = db.select({ count: sql<number>`count(*)` })
      .from(schema.users)
      .where(and(...conditions))
      .get();
    const total = countResult?.count ?? 0;

    if (total === 0) {
      return reply.code(200).send({ users: [], total: 0 });
    }

    // Pre-load my social graph
    const myFriendRows = db.select().from(schema.friends).where(
      or(eq(schema.friends.userId, myId), eq(schema.friends.friendId, myId))
    ).all();
    const myFriendIds = new Set(myFriendRows.map(f => f.userId === myId ? f.friendId : f.userId));

    const mySpaceRows = db.select({ spaceId: schema.spaceMembers.spaceId })
      .from(schema.spaceMembers)
      .where(eq(schema.spaceMembers.userId, myId))
      .all();
    const mySpaceIds = new Set(mySpaceRows.map(s => s.spaceId));

    const outboundRequests = db.select().from(schema.friendRequests).where(
      and(eq(schema.friendRequests.fromId, myId), eq(schema.friendRequests.status, 'pending'))
    ).all();
    const outboundMap = new Map(outboundRequests.map(r => [r.toId, r.id]));

    const inboundRequests = db.select().from(schema.friendRequests).where(
      and(eq(schema.friendRequests.toId, myId), eq(schema.friendRequests.status, 'pending'))
    ).all();
    const inboundMap = new Map(inboundRequests.map(r => [r.fromId, r.id]));

    // Fetch page of users
    const userRows = db.select()
      .from(schema.users)
      .where(and(...conditions))
      .orderBy(sql`created_at DESC`)
      .limit(limit)
      .offset(offset)
      .all();

    // Batch fetch friends and space memberships for all page users
    const pageUserIds = userRows.map(r => r.id);

    // Batch fetch all friends for page users
    const pageFriendRows = pageUserIds.length > 0
      ? db.select().from(schema.friends).where(
          or(
            inArray(schema.friends.userId, pageUserIds),
            inArray(schema.friends.friendId, pageUserIds),
          )
        ).all()
      : [];

    // Build Map<userId, Set<friendId>> for page users
    const friendIdsByUser = new Map<string, Set<string>>();
    for (const f of pageFriendRows) {
      // Map both directions
      if (pageUserIds.includes(f.userId)) {
        if (!friendIdsByUser.has(f.userId)) friendIdsByUser.set(f.userId, new Set());
        friendIdsByUser.get(f.userId)!.add(f.friendId);
      }
      if (pageUserIds.includes(f.friendId)) {
        if (!friendIdsByUser.has(f.friendId)) friendIdsByUser.set(f.friendId, new Set());
        friendIdsByUser.get(f.friendId)!.add(f.userId);
      }
    }

    // Batch fetch all space memberships for page users
    const pageSpaceMemberRows = pageUserIds.length > 0
      ? db.select({ userId: schema.spaceMembers.userId, spaceId: schema.spaceMembers.spaceId })
          .from(schema.spaceMembers)
          .where(inArray(schema.spaceMembers.userId, pageUserIds))
          .all()
      : [];

    // Build Map<userId, Set<spaceId>> for page users
    const spaceIdsByUser = new Map<string, Set<string>>();
    for (const sm of pageSpaceMemberRows) {
      if (!spaceIdsByUser.has(sm.userId)) spaceIdsByUser.set(sm.userId, new Set());
      spaceIdsByUser.get(sm.userId)!.add(sm.spaceId);
    }

    // Compute mutual counts + relationship for each user
    const discoverUsers: DiscoverUser[] = userRows.map(row => {
      const u = sanitizeUser(row);

      // Mutual friends (using batch-fetched data)
      const theirFriendIds = friendIdsByUser.get(row.id) ?? new Set();
      const mutualFriendCount = [...myFriendIds].filter(id => theirFriendIds.has(id)).length;

      // Mutual spaces (using batch-fetched data)
      const theirSpaceIds = spaceIdsByUser.get(row.id) ?? new Set();
      const mutualSpaceCount = [...mySpaceIds].filter(id => theirSpaceIds.has(id)).length;

      // Relationship
      let relationship: DiscoverUser['relationship'] = 'none';
      let requestId: string | undefined;
      if (myFriendIds.has(row.id)) {
        relationship = 'friends';
      } else if (outboundMap.has(row.id)) {
        relationship = 'outbound_pending';
        requestId = outboundMap.get(row.id);
      } else if (inboundMap.has(row.id)) {
        relationship = 'inbound_pending';
        requestId = inboundMap.get(row.id);
      }

      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        avatar: u.avatar,
        banner: u.banner,
        avatarColor: u.avatarColor,
        bio: u.bio,
        status: u.status,
        customStatus: u.customStatus,
        createdAt: u.createdAt,
        homeInstance: u.homeInstance,
        homeUserId: u.homeUserId,
        mutualFriendCount,
        mutualSpaceCount,
        relationship,
        ...(requestId ? { requestId } : {}),
      };
    });

    // Sort: mutual friends DESC, then created_at DESC
    discoverUsers.sort((a, b) => {
      if (b.mutualFriendCount !== a.mutualFriendCount) return b.mutualFriendCount - a.mutualFriendCount;
      return b.createdAt - a.createdAt;
    });

    return reply.code(200).send({ users: discoverUsers, total });
  });

  // GET /api/social/search?q=... - Search for users to add as friends
  app.get<{ Querystring: { q: string } }>('/api/social/search', {
    preHandler: authenticate,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { q } = request.query;
    const db = getDb();

    if (!q || q.length < 1) {
      return reply.code(200).send([]);
    }

    const pattern = `%${q}%`;

    const conditions = [
      eq(schema.users.isDeleted, 0),
      eq(schema.users.discoverable, 1),
      ne(schema.users.id, request.userId),
      // Exclude replicated federated stubs: their stored username is
      // `<homeUserId>@<domain>`, so a substring of the domain would match
      // every stub from that instance. Federated users are surfaced via
      // the client-side cross-instance fan-out instead.
      sql`(${schema.users.homeInstance} IS NULL OR ${schema.users.homeInstance} = '')`,
      or(
        like(schema.users.username, pattern),
        like(schema.users.displayName, pattern),
      )!,
    ];

    const users = db.select()
      .from(schema.users)
      .where(and(...conditions))
      .limit(10)
      .all();

    return reply.code(200).send(users.map(u => sanitizeUser(u)));
  });
}
