import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { connectionManager } from '../ws/handler.js';
import type { User, UpdateUserRequest } from '@opencord/shared';

function sanitizeUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatar: row.avatar,
    status: (row.status ?? 'offline') as User['status'],
    customStatus: row.customStatus,
    isAdmin: row.isAdmin === 1,
    createdAt: row.createdAt,
  };
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users/@me', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();

    const user = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!user) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }

    return reply.code(200).send(sanitizeUser(user));
  });

  app.patch<{ Body: UpdateUserRequest }>('/api/users/@me', { preHandler: authenticate }, async (request, reply) => {
    const { displayName, avatar, customStatus, status } = request.body;
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
      const userServers = connectionManager.getUserServers(sanitized.id);
      for (const serverId of userServers) {
        connectionManager.sendToServer(serverId, {
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
}
