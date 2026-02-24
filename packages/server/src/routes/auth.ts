import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { hashPassword, verifyPassword, signJwt } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { config } from '../config.js';
import type { RegisterRequest, LoginRequest, AuthResponse, User } from '@opencord/shared';

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

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterRequest }>('/api/auth/register', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const { username, password, displayName } = request.body;

    if (!username || typeof username !== 'string') {
      return reply.code(400).send({ error: 'Username is required', statusCode: 400 });
    }

    if (!password || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Password is required', statusCode: 400 });
    }

    const trimmedUsername = username.trim();

    if (trimmedUsername.length < 3 || trimmedUsername.length > 32) {
      return reply.code(400).send({ error: 'Username must be between 3 and 32 characters', statusCode: 400 });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
      return reply.code(400).send({ error: 'Username can only contain letters, numbers, and underscores', statusCode: 400 });
    }

    if (password.length < 6) {
      return reply.code(400).send({ error: 'Password must be at least 6 characters', statusCode: 400 });
    }

    if (!config.registrationOpen) {
      return reply.code(403).send({ error: 'Registration is currently closed', statusCode: 403 });
    }

    const db = getDb();

    const existing = db.select().from(schema.users).where(eq(schema.users.username, trimmedUsername)).get();
    if (existing) {
      return reply.code(409).send({ error: 'Username already taken', statusCode: 409 });
    }

    const passwordHash = await hashPassword(password);
    const userId = generateSnowflake();
    const now = Date.now();

    db.insert(schema.users).values({
      id: userId,
      username: trimmedUsername,
      displayName: displayName?.trim() || null,
      passwordHash,
      status: 'online',
      createdAt: now,
    }).run();

    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!user) {
      return reply.code(500).send({ error: 'Failed to create user', statusCode: 500 });
    }

    const token = signJwt({ userId: user.id, username: user.username });

    const response: AuthResponse = {
      token,
      user: sanitizeUser(user),
    };

    return reply.code(201).send(response);
  });

  app.post<{ Body: LoginRequest }>('/api/auth/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const { username, password } = request.body;

    if (!username || typeof username !== 'string') {
      return reply.code(400).send({ error: 'Username is required', statusCode: 400 });
    }

    if (!password || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Password is required', statusCode: 400 });
    }

    const db = getDb();

    const user = db.select().from(schema.users).where(eq(schema.users.username, username.trim())).get();
    if (!user) {
      return reply.code(401).send({ error: 'Invalid username or password', statusCode: 401 });
    }

    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      return reply.code(401).send({ error: 'Invalid username or password', statusCode: 401 });
    }

    db.update(schema.users).set({ status: 'online' }).where(eq(schema.users.id, user.id)).run();

    const token = signJwt({ userId: user.id, username: user.username });

    const response: AuthResponse = {
      token,
      user: sanitizeUser({ ...user, status: 'online' }),
    };

    return reply.code(200).send(response);
  });
}
