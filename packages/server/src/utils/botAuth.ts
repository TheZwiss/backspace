import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { sendError } from './httpErrors.js';

/** preHandler (after `authenticate`): the caller must be a bot account. */
export async function requireBot(request: FastifyRequest, reply: FastifyReply) {
  const row = getDb().select({ isBot: schema.users.isBot })
    .from(schema.users).where(eq(schema.users.id, request.userId)).get();
  if (row?.isBot !== 1) return sendError(reply, 403, 'bot_account_required');
}
