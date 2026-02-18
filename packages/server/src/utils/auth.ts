import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
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
}

export function signJwt(payload: JwtPayload): string {
  const options: jwt.SignOptions = {
    expiresIn: config.jwtExpiresIn as unknown as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign(payload, config.jwtSecret, options);
}

export function verifyJwt(token: string): JwtPayload {
  const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;
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
    (request as FastifyRequest & { userId: string; username: string }).userId = payload.userId;
    (request as FastifyRequest & { userId: string; username: string }).username = payload.username;
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token', statusCode: 401 });
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    username: string;
  }
}
