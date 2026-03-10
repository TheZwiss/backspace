import type { FastifyInstance } from 'fastify';
import { eq, or, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, verifyPassword } from '../utils/auth.js';
import { connectionManager } from '../ws/handler.js';
import type { UpdateUserRequest, VerifyPasswordRequest, VerifyPasswordResponse, ReplicatedInstance } from '@backspace/shared';
import { AVATAR_COLORS } from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users/@me', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();

    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    return reply.code(200).send(sanitizeUser(user));
  });

  // POST /api/users/@me/verify-password — verify password matches current account
  app.post<{ Body: VerifyPasswordRequest }>('/api/users/@me/verify-password', { preHandler: authenticate }, async (request, reply) => {
    const { password } = request.body;

    if (!password || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Password is required', statusCode: 400 });
    }

    const db = getDb();
    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    const response: VerifyPasswordResponse = { valid };
    return reply.code(200).send(response);
  });

  app.patch<{ Body: UpdateUserRequest }>('/api/users/@me', { preHandler: authenticate }, async (request, reply) => {
    const { displayName, avatar, banner, accentColor, avatarColor, bio, customStatus, status, replicatedInstances, homeUserId } = request.body;
    const db = getDb();

    const updateData: Record<string, string | null | undefined> = {};

    if (displayName !== undefined) {
      if (displayName !== null && typeof displayName === 'string') {
        const trimmed = displayName.trim();
        if (trimmed.length > 32) {
          return reply.code(400).send({ error: 'Display name must be 32 characters or less', statusCode: 400 });
        }
        updateData.displayName = trimmed || null;
      } else {
        updateData.displayName = null;
      }
    }

    if (avatar !== undefined) {
      updateData.avatar = avatar;
    }

    if (banner !== undefined) {
      if (banner && typeof banner === 'string' && banner.trim().length > 0) {
        updateData.banner = banner.trim();
      } else {
        updateData.banner = null;
      }
    }

    if (accentColor !== undefined) {
      if (accentColor && typeof accentColor === 'string' && accentColor.trim().length > 0) {
        const hex = accentColor.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
          return reply.code(400).send({ error: 'Accent color must be a valid hex color (e.g. #ff0000)', statusCode: 400 });
        }
        updateData.accentColor = hex;
      } else {
        updateData.accentColor = null;
      }
    }

    if (avatarColor !== undefined) {
      if (avatarColor && typeof avatarColor === 'string' && avatarColor.trim().length > 0) {
        const trimmed = avatarColor.trim();
        if (!(AVATAR_COLORS as readonly string[]).includes(trimmed)) {
          return reply.code(400).send({ error: `Invalid avatar color. Must be one of: ${AVATAR_COLORS.join(', ')}`, statusCode: 400 });
        }
        updateData.avatarColor = trimmed;
      } else {
        updateData.avatarColor = null;
      }
    }

    if (bio !== undefined) {
      if (bio && typeof bio === 'string') {
        const trimmed = bio.trim();
        if (trimmed.length > 190) {
          return reply.code(400).send({ error: 'Bio must be 190 characters or less', statusCode: 400 });
        }
        updateData.bio = trimmed || null;
      } else {
        updateData.bio = null;
      }
    }

    if (customStatus !== undefined) {
      if (customStatus !== null && typeof customStatus === 'string') {
        const trimmed = customStatus.trim();
        if (trimmed.length > 128) {
          return reply.code(400).send({ error: 'Custom status must be 128 characters or less', statusCode: 400 });
        }
        updateData.customStatus = trimmed || null;
      } else {
        updateData.customStatus = null;
      }
    }

    if (status !== undefined) {
      if (!['online', 'idle', 'dnd', 'offline'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status', statusCode: 400 });
      }
      updateData.status = status;
    }

    if (replicatedInstances !== undefined) {
      if (!Array.isArray(replicatedInstances)) {
        return reply.code(400).send({ error: 'replicatedInstances must be an array', statusCode: 400 });
      }
      // Validate each entry has (origin or domain) and username strings
      for (const inst of replicatedInstances) {
        if (!inst || typeof inst.username !== 'string') {
          return reply.code(400).send({ error: 'Each replicated instance must have username string', statusCode: 400 });
        }
        if (typeof inst.origin !== 'string' && typeof inst.domain !== 'string') {
          return reply.code(400).send({ error: 'Each replicated instance must have origin or domain string', statusCode: 400 });
        }
      }
      if (replicatedInstances.length > 50) {
        return reply.code(400).send({ error: 'Maximum 50 replicated instances', statusCode: 400 });
      }
      updateData.replicatedInstances = JSON.stringify(replicatedInstances);
    }

    if (homeUserId !== undefined) {
      // Only allow setting homeUserId for replicated users (has homeInstance)
      const currentUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
      if (currentUser?.homeInstance && typeof homeUserId === 'string' && homeUserId.length > 0) {
        updateData.homeUserId = homeUserId;
      }
    }

    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({ error: 'No fields to update', statusCode: 400 });
    }

    db.update(schema.users).set(updateData).where(eq(schema.users.id, request.userId)).run();

    const updatedUser = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!updatedUser) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    const sanitized = sanitizeUser(updatedUser);

    // Broadcast presence update if status changed
    if (status !== undefined) {
      const userSpaces = connectionManager.getUserSpaces(sanitized.id);
      for (const spaceId of userSpaces) {
        connectionManager.sendToSpace(spaceId, {
          type: 'presence_update',
          userId: sanitized.id,
          status: status,
        }, sanitized.id);
      }
      connectionManager.sendToUser(sanitized.id, {
        type: 'presence_update',
        userId: sanitized.id,
        status: status,
      });
    }

    return reply.code(200).send(sanitized);
  });

  app.get<{ Params: { id: string } }>('/api/users/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params;
    const db = getDb();

    const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!user) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    return reply.code(200).send(sanitizeUser(user));
  });

  app.get<{ Params: { id: string }; Querystring: { homeUserId?: string } }>(
    '/api/users/:id/mutuals', { preHandler: authenticate }, async (request, reply) => {
    const { id: targetId } = request.params;
    const homeUserId = request.query.homeUserId;
    const myId = request.userId;
    const db = getDb();

    // Resolve target: try path ID first, then homeUserId fallback (federation)
    let resolvedTargetId = targetId;
    const directUser = db.select().from(schema.users).where(eq(schema.users.id, targetId)).get();
    if (!directUser && homeUserId) {
      const fallbackUser = db.select().from(schema.users)
        .where(or(eq(schema.users.homeUserId, homeUserId), eq(schema.users.id, homeUserId))).get();
      if (fallbackUser) resolvedTargetId = fallbackUser.id;
    }

    // Mutual friends: users who are friends with both me and the target
    const myFriendRows = db.select().from(schema.friends).where(
      or(eq(schema.friends.userId, myId), eq(schema.friends.friendId, myId))
    ).all();
    const targetFriendRows = db.select().from(schema.friends).where(
      or(eq(schema.friends.userId, resolvedTargetId), eq(schema.friends.friendId, resolvedTargetId))
    ).all();
    const myFriendIds = new Set(myFriendRows.map(f => f.userId === myId ? f.friendId : f.userId));
    const targetFriendIds = new Set(targetFriendRows.map(f => f.userId === resolvedTargetId ? f.friendId : f.userId));
    const mutualFriendIds = [...myFriendIds].filter((id) => targetFriendIds.has(id));

    const mutualFriends = mutualFriendIds.length > 0
      ? db.select().from(schema.users).where(inArray(schema.users.id, mutualFriendIds)).all().map(sanitizeUser)
      : [];

    // Mutual spaces: spaces both me and the target are members of
    const myMemberships = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.userId, myId)).all();
    const targetMemberships = db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.userId, resolvedTargetId)).all();
    const mySpaceIds = new Set(myMemberships.map((m) => m.spaceId));
    const targetSpaceIds = new Set(targetMemberships.map((m) => m.spaceId));
    const mutualSpaceIds = [...mySpaceIds].filter((id) => targetSpaceIds.has(id));

    const mutualSpaces = mutualSpaceIds.length > 0
      ? db.select({ id: schema.spaces.id, name: schema.spaces.name, icon: schema.spaces.icon })
          .from(schema.spaces)
          .where(inArray(schema.spaces.id, mutualSpaceIds))
          .all()
      : [];

    return reply.code(200).send({ mutualFriends, mutualSpaces });
  });
}
