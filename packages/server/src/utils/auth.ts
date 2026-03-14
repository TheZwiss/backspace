import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface JwtPayload {
  userId: string;
  username: string;
  iat?: number;
}

export function signJwt(payload: JwtPayload): string {
  const options: jwt.SignOptions = {
    expiresIn: config.jwtExpiresIn as unknown as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign(payload, config.jwtSecret, options);
}

export function verifyJwt(token: string): JwtPayload {
  const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
  return decoded;
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid authorization header', statusCode: 401 });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyJwt(token);

    // Verify user exists and is not deleted/revoked
    const db = getDb();
    const user = db.select({
      id: schema.users.id,
      isDeleted: schema.users.isDeleted,
      passwordChangedAt: schema.users.passwordChangedAt,
    }).from(schema.users).where(eq(schema.users.id, payload.userId)).get();

    if (!user || user.isDeleted === 1) {
      return reply.code(401).send({ error: 'This account has been deleted', statusCode: 401 });
    }

    // Reject tokens issued before the last password change (token revocation)
    if (user.passwordChangedAt && payload.iat) {
      // JWT iat is in seconds, passwordChangedAt is in milliseconds
      if (payload.iat < Math.floor(user.passwordChangedAt / 1000)) {
        return reply.code(401).send({ error: 'Token has been revoked — please log in again', statusCode: 401 });
      }
    }

    (request as FastifyRequest & { userId: string; username: string }).userId = payload.userId;
    (request as FastifyRequest & { userId: string; username: string }).username = payload.username;
  } catch {
    return reply.code(401).send({ error: 'Invalid or expired token', statusCode: 401 });
  }
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const db = getDb();
  const caller = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
  if (!caller || caller.isAdmin !== 1) {
    return reply.code(403).send({ error: 'Only instance admins can perform this action', statusCode: 403 });
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    username: string;
  }
}
