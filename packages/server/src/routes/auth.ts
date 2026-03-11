import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { hashPassword, verifyPassword, signJwt } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { config } from '../config.js';
import type { RegisterRequest, LoginRequest, AuthResponse } from '@backspace/shared';
import { AVATAR_COLORS } from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';

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
    const { username, password, displayName, avatarColor: requestedAvatarColor, homeInstance, homeUserId } = request.body;

    if (!username || typeof username !== 'string') {
      return reply.code(400).send({ error: 'Username is required', statusCode: 400 });
    }

    if (!password || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Password is required', statusCode: 400 });
    }

    const trimmedUsername = username.trim();

    // Replicated registrations (homeInstance provided) may use username@domain format
    // for collision fallback. Local registrations use strict alphanumeric+underscore.
    if (homeInstance) {
      // Validate homeInstance is a reasonable domain string
      if (typeof homeInstance !== 'string' || homeInstance.length > 253 || !/^[a-zA-Z0-9._-]+$/.test(homeInstance)) {
        return reply.code(400).send({ error: 'Invalid homeInstance domain', statusCode: 400 });
      }

      if (trimmedUsername.includes('@')) {
        // username@domain format: validate local part + domain part
        const atIndex = trimmedUsername.indexOf('@');
        const localPart = trimmedUsername.slice(0, atIndex);
        const domainPart = trimmedUsername.slice(atIndex + 1);

        if (localPart.length < 3 || localPart.length > 32 || !/^[a-zA-Z0-9_]+$/.test(localPart)) {
          return reply.code(400).send({ error: 'Username local part must be 3-32 alphanumeric/underscore characters', statusCode: 400 });
        }
        if (domainPart.length === 0 || domainPart.length > 253 || !/^[a-zA-Z0-9._-]+$/.test(domainPart)) {
          return reply.code(400).send({ error: 'Username domain part is invalid', statusCode: 400 });
        }
        if (trimmedUsername.length > 100) {
          return reply.code(400).send({ error: 'Username must be 100 characters or less', statusCode: 400 });
        }
      } else {
        // Replicated users MUST use username@domain format — plain usernames
        // are reserved exclusively for native users of this instance
        return reply.code(400).send({ error: 'Replicated users must use username@domain format', statusCode: 400 });
      }
    } else {
      // Local registration — strict validation
      if (trimmedUsername.length < 3 || trimmedUsername.length > 32) {
        return reply.code(400).send({ error: 'Username must be between 3 and 32 characters', statusCode: 400 });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
        return reply.code(400).send({ error: 'Username can only contain letters, numbers, and underscores', statusCode: 400 });
      }
    }

    if (password.length < 6) {
      return reply.code(400).send({ error: 'Password must be at least 6 characters', statusCode: 400 });
    }

    const db = getDb();

    // Check registration: DB setting overrides env var if explicitly set by admin
    const instanceRow = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    const registrationOpen = instanceRow?.registrationOpen !== null && instanceRow?.registrationOpen !== undefined
      ? instanceRow.registrationOpen === 1
      : config.registrationOpen;
    if (!registrationOpen) {
      return reply.code(403).send({ error: 'Registration is currently closed', statusCode: 403 });
    }

    const existing = db.select().from(schema.users).where(eq(schema.users.username, trimmedUsername)).get();
    if (existing) {
      return reply.code(409).send({ error: 'Username already taken', statusCode: 409 });
    }

    const passwordHash = await hashPassword(password);
    const userId = generateSnowflake();
    const now = Date.now();

    // First registered user becomes instance admin (replicated users are never admins)
    const userCount = db.select().from(schema.users).all().length;
    const isFirstUser = userCount === 0 && !homeInstance;

    const avatarColor = (requestedAvatarColor && (AVATAR_COLORS as readonly string[]).includes(requestedAvatarColor))
      ? requestedAvatarColor
      : AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

    db.insert(schema.users).values({
      id: userId,
      username: trimmedUsername,
      displayName: displayName?.trim() || null,
      passwordHash,
      status: 'online',
      isAdmin: isFirstUser ? 1 : 0,
      homeInstance: homeInstance || null,
      homeUserId: (homeInstance && homeUserId && typeof homeUserId === 'string') ? homeUserId : null,
      avatarColor,
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
