import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { BOT_TOKEN_NAME_MAX_LENGTH, MAX_BOT_TOKENS_PER_BOT } from '@backspace/shared/src/constants.js';
import { getDb, schema } from '../db/index.js';

/**
 * Bot access tokens: `bsb_<id>.<secret>`. The id (16 hex) finds the row, the
 * secret (32 random bytes, base64url) is shown once and only its SHA-256 is
 * stored. A fast hash is right here: the secret has 256 bits of entropy, so
 * there is nothing to brute-force, and every request pays for the check.
 * The prefix lets secret scanners (and people) recognise a leaked token.
 */

export const BOT_TOKEN_PREFIX = 'bsb_';
export { BOT_TOKEN_NAME_MAX_LENGTH, MAX_BOT_TOKENS_PER_BOT };
/** `last_used_at` is written at most this often per token: no database write per request. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const TOKEN_RE = /^bsb_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;

export function isBotTokenString(token: string): boolean {
  return token.startsWith(BOT_TOKEN_PREFIX);
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export interface IssuedBotToken {
  id: string;
  /** The only time the full token exists: hand it to the owner and forget it. */
  token: string;
  name: string | null;
  createdAt: number;
}

/** Stores a new token for the bot and returns it. The caller checked the limit. */
export function issueBotToken(botId: string, name: string | null, now: number = Date.now()): IssuedBotToken {
  const id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  getDb().insert(schema.botTokens).values({
    id,
    botId,
    tokenHash: hashSecret(secret).toString('hex'),
    name,
    createdAt: now,
    lastUsedAt: null,
  }).run();
  return { id, token: `${BOT_TOKEN_PREFIX}${id}.${secret}`, name, createdAt: now };
}

export function countBotTokens(botId: string): number {
  return getDb().select({ id: schema.botTokens.id }).from(schema.botTokens)
    .where(eq(schema.botTokens.botId, botId)).all().length;
}

export function listBotTokens(botId: string): Array<{ id: string; name: string | null; createdAt: number; lastUsedAt: number | null }> {
  return getDb().select({
    id: schema.botTokens.id,
    name: schema.botTokens.name,
    createdAt: schema.botTokens.createdAt,
    lastUsedAt: schema.botTokens.lastUsedAt,
  }).from(schema.botTokens).where(eq(schema.botTokens.botId, botId)).orderBy(schema.botTokens.createdAt).all();
}

/** Revokes one token; false when the bot has no such token. */
export function revokeBotToken(botId: string, tokenId: string): boolean {
  const result = getDb().delete(schema.botTokens)
    .where(and(eq(schema.botTokens.botId, botId), eq(schema.botTokens.id, tokenId))).run();
  return result.changes > 0;
}

export function revokeAllBotTokens(botId: string): void {
  getDb().delete(schema.botTokens).where(eq(schema.botTokens.botId, botId)).run();
}

/**
 * Bots created before `bsb_` tokens hold a 10-year JWT. It keeps working until
 * the bot holds a `bsb_` token, and stops from then on: the owner's first new
 * token is the cut-over, so no flag day is needed and the old token cannot
 * outlive the migration. Federated bot accounts (a host's row for a bot of
 * another instance) log in for their own JWTs and are not affected.
 */
export function isRetiredLegacyBotJwt(account: { id: string; isBot: number | null; homeInstance: string | null }): boolean {
  return account.isBot === 1 && !account.homeInstance && countBotTokens(account.id) > 0;
}

export interface BotTokenIdentity {
  /** The token's own id (the 16 hex after `bsb_`): what one live socket is held under. */
  tokenId: string;
  userId: string;
  username: string;
  homeInstance: string | null;
}

/**
 * Resolves a `bsb_` token to its bot. 'invalid' covers a malformed token, an
 * unknown id and a wrong secret alike (no hint which); 'deleted' is a token of
 * a bot that no longer exists.
 */
export function verifyBotToken(token: string, now: number = Date.now()): BotTokenIdentity | 'invalid' | 'deleted' {
  const match = TOKEN_RE.exec(token);
  if (!match) return 'invalid';
  const [, id, secret] = match as unknown as [string, string, string];
  const db = getDb();
  const row = db.select().from(schema.botTokens).where(eq(schema.botTokens.id, id)).get();
  if (!row) return 'invalid';
  const stored = Buffer.from(row.tokenHash, 'hex');
  const given = hashSecret(secret);
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) return 'invalid';

  const bot = db.select({
    id: schema.users.id,
    username: schema.users.username,
    isDeleted: schema.users.isDeleted,
    isBot: schema.users.isBot,
    homeInstance: schema.users.homeInstance,
  }).from(schema.users).where(eq(schema.users.id, row.botId)).get();
  if (!bot || bot.isDeleted === 1) return 'deleted';
  if (bot.isBot !== 1) return 'invalid';

  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS) {
    db.update(schema.botTokens).set({ lastUsedAt: now }).where(eq(schema.botTokens.id, id)).run();
  }
  return { tokenId: id, userId: bot.id, username: bot.username, homeInstance: bot.homeInstance ?? null };
}
