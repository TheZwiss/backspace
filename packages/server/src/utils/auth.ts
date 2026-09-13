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
  /** Discriminator for human vs bot. Optional for backward compat with
   *  pre-#184 JWTs that only carry userId/username. New JWTs always set it. */
  accountType?: 'human' | 'bot' | 'service';
  /** Scope list for bot/service JWTs. Empty array for humans. */
  scopes?: string[];
  /** Bot-token ID this JWT was minted from (so we can revoke the API token
   *  and invalidate outstanding JWTs in one place). Undefined for humans. */
  tokenId?: string;
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

/**
 * AuthError carries an HTTP status code so raw-IncomingMessage paths
 * (e.g. tus hooks) can re-throw with a status the caller maps onto
 * its own response object.
 */
export class AuthError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Verify a JWT token AND confirm the user still exists, isn't deleted,
 * and the token hasn't been revoked by a password change. Returns the
 * resolved user identity. Throws AuthError (statusCode = 401) on any
 * failure.
 *
 * Used by Fastify's `authenticate` preHandler AND by raw-IncomingMessage
 * paths (tus hooks) that can't go through the preHandler pipeline.
 */
export async function verifyJwtAndUser(token: string): Promise<{
  userId: string;
  username: string;
  homeInstance: string | null;
}> {
  let payload: JwtPayload;
  try {
    payload = verifyJwt(token);
  } catch {
    throw new AuthError('Invalid or expired token', 401);
  }

  const db = getDb();
  const user = db.select({
    id: schema.users.id,
    isDeleted: schema.users.isDeleted,
    passwordChangedAt: schema.users.passwordChangedAt,
    homeInstance: schema.users.homeInstance,
  }).from(schema.users).where(eq(schema.users.id, payload.userId)).get();

  if (!user || user.isDeleted === 1) {
    throw new AuthError('This account has been deleted', 401);
  }

  // Reject tokens issued before the last password change (token revocation).
  // JWT `iat` is in seconds; passwordChangedAt is in milliseconds.
  if (user.passwordChangedAt && payload.iat) {
    if (payload.iat < Math.floor(user.passwordChangedAt / 1000)) {
      throw new AuthError('Token has been revoked — please log in again', 401);
    }
  }

  return {
    userId: payload.userId,
    username: payload.username,
    homeInstance: user.homeInstance ?? null,
  };
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
    const identity = await verifyJwtAndUser(token);
    (request as FastifyRequest & { userId: string; username: string }).userId = identity.userId;
    (request as FastifyRequest & { userId: string; username: string }).username = identity.username;
    (request as FastifyRequest & { userId: string; username: string }).homeInstance = identity.homeInstance;

    // Issue #184: attach accountType + scopes for downstream scope checks.
    // Bot JWTs also carry a tokenId so we can revoke the API token and
    // reject outstanding JWTs in one place (see requireBotTokenStillActive).
    const payload = verifyJwt(token);
    (request as FastifyRequest & { accountType?: string }).accountType = payload.accountType ?? 'human';
    (request as FastifyRequest & { scopes?: string[] }).scopes = payload.scopes ?? [];
    (request as FastifyRequest & { tokenId?: string }).tokenId = payload.tokenId;
  } catch (err) {
    if (err instanceof AuthError) {
      return reply.code(err.statusCode).send({ error: err.message, statusCode: err.statusCode });
    }
    return reply.code(401).send({ error: 'Invalid or expired token', statusCode: 401 });
  }
}

/**
 * Reject bot/service JWTs at an endpoint that should only be reachable by
 * humans (e.g. account deletion, password change, 2FA setup, bot creation).
 * Use as a Fastify preHandler after `authenticate`.
 */
export async function requireHuman(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const accountType = (request as FastifyRequest & { accountType?: string }).accountType ?? 'human';
  if (accountType !== 'human') {
    reply.code(403).send({ error: 'This action is only available to human accounts', statusCode: 403 });
  }
}

/**
 * Scope guard factory. Returns a Fastify preHandler that 403s if the JWT
 * doesn't carry the named scope. Use it on endpoints that should be
 * reachable only by bot tokens minted with that scope.
 */
export function requireScope(scope: string) {
  return async function scopeGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const accountType = (request as FastifyRequest & { accountType?: string }).accountType ?? 'human';
    const scopes = (request as FastifyRequest & { scopes?: string[] }).scopes ?? [];
    if (accountType === 'human') {
      // Humans are full-privilege — they bypass scope checks. Scoped routes
      // are still meaningful (a human calling them just doesn't need the
      // scope token). If you want humans explicitly excluded, layer
      // `requireBot` ahead.
      return;
    }
    if (!scopes.includes(scope)) {
      reply.code(403).send({ error: `Missing scope: ${scope}`, statusCode: 403 });
    }
  };
}

/**
 * Reverse: require the caller to be a bot (not a human). Use on routes that
 * are only meaningful for automation clients, like gateway endpoints.
 */
export async function requireBot(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const accountType = (request as FastifyRequest & { accountType?: string }).accountType ?? 'human';
  if (accountType === 'human') {
    reply.code(403).send({ error: 'This endpoint is only available to bot/service accounts', statusCode: 403 });
  }
}

/**
 * Bot-token revocation check. Use as a preHandler after authenticate() to
 * reject bot JWTs whose underlying API token has been revoked since the
 * JWT was minted. Cheap: one indexed lookup on the tokenId.
 */
export async function requireBotTokenStillActive(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const tokenId = (request as FastifyRequest & { tokenId?: string }).tokenId;
  if (!tokenId) return; // human JWT — nothing to check
  const db = getDb();
  const row = db.select({ revokedAt: schema.botTokens.revokedAt })
    .from(schema.botTokens)
    .where(eq(schema.botTokens.id, tokenId))
    .get();
  if (!row) {
    reply.code(401).send({ error: 'Bot token no longer exists', statusCode: 401 });
    return;
  }
  if (row.revokedAt !== null) {
    reply.code(401).send({ error: 'Bot token has been revoked', statusCode: 401 });
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

export async function requireLocalUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.homeInstance) {
    return reply.code(403).send({
      error: 'Federated users must use their home instance for DM operations',
      statusCode: 403,
    });
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    username: string;
    homeInstance: string | null;
  }
}
