import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, verifyPassword } from '../utils/auth.js';
import { connectionManager } from '../ws/handler.js';
import type { UpdateUserRequest, VerifyPasswordRequest, VerifyPasswordResponse, ReplicatedInstance } from '@backspace/shared';
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
    const { displayName, avatar, customStatus, status, replicatedInstances } = request.body;
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
