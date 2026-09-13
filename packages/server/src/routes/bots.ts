/**
 * Bot / service-account management routes (issue #184).
 *
 * Surface:
 *   POST   /api/bots                              create bot (human only)
 *   GET    /api/bots                              list bots owned by caller
 *   GET    /api/bots/:id                          bot details (owner or admin)
 *   PATCH  /api/bots/:id                          update label/display
 *   DELETE /api/bots/:id                          soft-delete (owner or admin)
 *   POST   /api/bots/:id/tokens                   mint API token (owner)
 *   GET    /api/bots/:id/tokens                   list masked tokens (owner)
 *   DELETE /api/bots/:id/tokens/:tokenId          revoke (owner)
 *   POST   /api/bots/:id/tokens/:tokenId/rotate   atomic revoke+mint (owner)
 *   POST   /api/auth/bot/login                    API token → bot JWT
 *
 * Federation model:
 *   - Replicated stubs (passwordHash === '!federation-replicated') cannot
 *     create bot accounts. Rejected at create time. (They cannot log in to
 *     begin with, but the assertion is explicit.)
 *   - Federated accounts (homeInstance set, federationHomeOrphaned !== 1)
 *     cannot create bots locally — bots are managed on the home instance.
 *   - Detached accounts (federationHomeOrphaned = 1) behave as sovereign
 *     local accounts and may create bots.
 *
 * Tokens (see utils/botTokens.ts):
 *   - Format `bsbot_<base32(20 random bytes)>`. Stored as sha256 hex.
 *   - Plaintext returned ONCE at mint time. Never persisted.
 *   - Rotated atomically (revoke old + mint new in one transaction).
 *
 * Audit:
 *   - Every create / mint / revoke / rotate / delete appends to
 *     bot_token_audit with the acting userId.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import {
  authenticate,
  signJwt,
  requireHuman,
} from '../utils/auth.js';
import {
  mintBotToken,
  parseScopeList,
  maskBotToken,
  isWellFormedBotToken,
  type BotScope,
} from '../utils/botTokens.js';
import { generateSnowflake } from '../utils/snowflake.js';
import type {
  Bot,
  BotCreateRequest,
  BotCreateResponse,
  BotTokenListItem,
  BotTokenMintResponse,
  BotAuthLoginRequest,
  BotAuthLoginResponse,
} from '@backspace/shared';

const BOT_USERNAME_PREFIX = 'bot_';
const BOT_USERNAME_RANDOM_BYTES = 6; // 6 base32 chars ≈ 30 bits — display-only; the token is the secret

function generateBotUsername(): string {
  // Use a URL-safe subset of base32 — no lowercase, no ambiguity. This is
  // purely a display identity. The API token is the real secret.
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(BOT_USERNAME_RANDOM_BYTES);
  // crypto.getRandomValues is available in Node 19+ via globalThis.crypto.
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length] ?? '';
  return `${BOT_USERNAME_PREFIX}${out}`;
}

async function recordAudit(
  db: ReturnType<typeof getDb>,
  args: {
    tokenId?: string | null;
    botUserId: string;
    actorUserId: string;
    action: string;
    details?: string | null;
  },
): Promise<void> {
  const now = Date.now();
  db.insert(schema.botTokenAudit).values({
    id: generateSnowflake(),
    tokenId: args.tokenId ?? '',
    botUserId: args.botUserId,
    actorUserId: args.actorUserId,
    action: args.action,
    details: args.details ?? null,
    createdAt: now,
  }).run();
}

/** Load bot by ID and confirm the caller is the owner OR an instance admin. */
async function loadBotForOwner(
  botId: string,
  callerUserId: string,
): Promise<{ bot: typeof schema.users.$inferSelect; error?: { code: number; message: string } }> {
  const db = getDb();
  const bot = db.select().from(schema.users).where(eq(schema.users.id, botId)).get();
  if (!bot) return { bot: undefined as never, error: { code: 404, message: 'Bot not found' } };
  if (bot.accountType === 'human') {
    return { bot: undefined as never, error: { code: 404, message: 'Not a bot account' } };
  }
  if (bot.ownerUserId !== callerUserId) {
    const caller = db.select({ isAdmin: schema.users.isAdmin })
      .from(schema.users).where(eq(schema.users.id, callerUserId)).get();
    if (!caller || caller.isAdmin !== 1) {
      return { bot: undefined as never, error: { code: 403, message: 'Not your bot' } };
    }
  }
  return { bot };
}

export async function botRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /api/bots ─────────────────────────────────────────────────────
  // Create a new bot. Human-only. Federated/replicated accounts rejected.
  app.post<{ Body: BotCreateRequest }>(
    '/api/bots',
    { preHandler: [authenticate, requireHuman] },
    async (request, reply) => {
      const db = getDb();

      // Federation safety: only native or detached accounts may create bots.
      const caller = db.select({
        id: schema.users.id,
        passwordHash: schema.users.passwordHash,
        homeInstance: schema.users.homeInstance,
        federationHomeOrphaned: schema.users.federationHomeOrphaned,
      }).from(schema.users).where(eq(schema.users.id, request.userId)).get();
      if (!caller) {
        return reply.code(401).send({ error: 'Caller not found', statusCode: 401 });
      }
      if (caller.passwordHash === '!federation-replicated') {
        return reply.code(403).send({
          error: 'Federation replica stubs cannot create bot accounts',
          statusCode: 403,
        });
      }
      if (caller.homeInstance !== null && caller.federationHomeOrphaned !== 1) {
        return reply.code(403).send({
          error: 'Federated accounts must manage bots on their home instance',
          statusCode: 403,
        });
      }

      const body = request.body;
      if (!body || typeof body.displayName !== 'string' || body.displayName.length === 0) {
        return reply.code(400).send({ error: 'displayName is required', statusCode: 400 });
      }
      let initialScopes: BotScope[] = [];
      if (body.scopes !== undefined) {
        try {
          initialScopes = parseScopeList(body.scopes);
        } catch (err) {
          return reply.code(400).send({
            error: err instanceof Error ? err.message : 'Invalid scopes',
            statusCode: 400,
          });
        }
      }

      const now = Date.now();
      const botUserId = generateSnowflake();
      // Generate a unique bot username (retry on collision — extremely rare).
      let username = generateBotUsername();
      for (let i = 0; i < 5; i++) {
        const exists = db.select({ id: schema.users.id })
          .from(schema.users).where(eq(schema.users.username, username)).get();
        if (!exists) break;
        username = generateBotUsername();
      }

      db.insert(schema.users).values({
        id: botUserId,
        username,
        displayName: body.displayName,
        // Bots have no password — they authenticate via API tokens.
        // Sentinel value blocks any password-login attempt.
        passwordHash: '!bot-account',
        avatar: null,
        status: 'offline',
        customStatus: null,
        isAdmin: 0,
        homeInstance: null,
        homeUserId: null,
        replicatedInstances: '[]',
        banner: null,
        accentColor: null,
        avatarColor: null,
        bio: null,
        isDeleted: 0,
        discoverable: 0,
        profileUpdatedAt: now,
        passwordChangedAt: now,
        showActivity: 0,
        federationRegistryUpdatedAt: 0,
        federationHealPending: 0,
        federationHomeOrphaned: 0,
        accountType: 'bot',
        ownerUserId: request.userId,
        botDisplayTag: body.botDisplayTag ?? null,
        createdAt: now,
      }).run();

      await recordAudit(db, {
        botUserId,
        actorUserId: request.userId,
        action: 'bot.create',
        details: JSON.stringify({ scopes: initialScopes }),
      });

      const response: BotCreateResponse = {
        bot: {
          id: botUserId,
          username,
          displayName: body.displayName,
          accountType: 'bot',
          ownerUserId: request.userId,
          botDisplayTag: body.botDisplayTag ?? null,
          isDeleted: false,
          createdAt: now,
        },
        // Mint one initial token so the owner can immediately use the bot.
        // The plaintext is returned EXACTLY ONCE here.
        initialToken: mintTokenAndRecord(db, botUserId, request.userId, initialScopes, 'initial'),
      };

      return reply.code(201).send(response);
    },
  );

  // ─── GET /api/bots ───────────────────────────────────────────────────────
  // List bots owned by the caller.
  app.get('/api/bots', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();
    const rows = db.select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      botDisplayTag: schema.users.botDisplayTag,
      isDeleted: schema.users.isDeleted,
      createdAt: schema.users.createdAt,
    })
      .from(schema.users)
      .where(and(eq(schema.users.ownerUserId, request.userId), eq(schema.users.accountType, 'bot')))
      .orderBy(desc(schema.users.createdAt))
      .all();
    const response: { bots: Bot[] } = {
      bots: rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        accountType: 'bot' as const,
        ownerUserId: request.userId,
        botDisplayTag: r.botDisplayTag,
        isDeleted: r.isDeleted === 1,
        createdAt: r.createdAt,
      })),
    };
    return reply.code(200).send(response);
  });

  // ─── GET /api/bots/:id ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/bots/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const loaded = await loadBotForOwner(request.params.id, request.userId);
      if (loaded.error) return reply.code(loaded.error.code).send({ error: loaded.error.message, statusCode: loaded.error.code });
      const b = loaded.bot;
      const response: Bot = {
        id: b.id,
        username: b.username,
        displayName: b.displayName,
        accountType: 'bot',
        ownerUserId: b.ownerUserId!,
        botDisplayTag: b.botDisplayTag,
        isDeleted: b.isDeleted === 1,
        createdAt: b.createdAt,
      };
      return reply.code(200).send(response);
    },
  );

  // ─── PATCH /api/bots/:id ─────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: Partial<{ displayName: string; botDisplayTag: string | null }> }>(
    '/api/bots/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const loaded = await loadBotForOwner(request.params.id, request.userId);
      if (loaded.error) return reply.code(loaded.error.code).send({ error: loaded.error.message, statusCode: loaded.error.code });
      const body = request.body ?? {};
      const updates: Partial<typeof schema.users.$inferInsert> = { profileUpdatedAt: Date.now() };
      if (typeof body.displayName === 'string' && body.displayName.length > 0) {
        updates.displayName = body.displayName;
      }
      if (body.botDisplayTag === null || typeof body.botDisplayTag === 'string') {
        updates.botDisplayTag = body.botDisplayTag;
      }
      const db = getDb();
      db.update(schema.users)
        .set(updates)
        .where(eq(schema.users.id, request.params.id))
        .run();
      return reply.code(200).send({ success: true });
    },
  );

  // ─── DELETE /api/bots/:id ────────────────────────────────────────────────
  // Soft-delete: sets isDeleted=1 AND revokes all outstanding tokens.
  app.delete<{ Params: { id: string } }>(
    '/api/bots/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const loaded = await loadBotForOwner(request.params.id, request.userId);
      if (loaded.error) return reply.code(loaded.error.code).send({ error: loaded.error.message, statusCode: loaded.error.code });
      const db = getDb();
      const now = Date.now();
      db.transaction((tx) => {
        tx.update(schema.users)
          .set({ isDeleted: 1, profileUpdatedAt: now })
          .where(eq(schema.users.id, request.params.id))
          .run();
        tx.update(schema.botTokens)
          .set({ revokedAt: now, revokedReason: 'owner_deleted_bot' })
          .where(and(eq(schema.botTokens.botUserId, request.params.id), isNull(schema.botTokens.revokedAt)))
          .run();
      });
      const db2 = getDb();
      await recordAudit(db2, {
        botUserId: request.params.id,
        actorUserId: request.userId,
        action: 'bot.delete',
      });
      return reply.code(200).send({ success: true });
    },
  );

  // ─── POST /api/bots/:id/tokens ───────────────────────────────────────────
  // Mint a new API token. Returns plaintext ONCE.
  app.post<{ Params: { id: string }; Body: { label?: string; scopes?: unknown } }>(
    '/api/bots/:id/tokens',
    { preHandler: authenticate },
    async (request, reply) => {
      const loaded = await loadBotForOwner(request.params.id, request.userId);
      if (loaded.error) return reply.code(loaded.error.code).send({ error: loaded.error.message, statusCode: loaded.error.code });
      let scopes: BotScope[] = [];
      try {
        if (request.body?.scopes !== undefined) {
          scopes = parseScopeList(request.body.scopes);
        }
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid scopes', statusCode: 400 });
      }
      const db = getDb();
      const minted = mintTokenAndRecord(db, request.params.id, request.userId, scopes, request.body?.label ?? null);
      const response: BotTokenMintResponse = { ...minted };
      return reply.code(201).send(response);
    },
  );

  // ─── GET /api/bots/:id/tokens ────────────────────────────────────────────
  // List tokens (masked — never returns plaintext).
  app.get<{ Params: { id: string } }>(
    '/api/bots/:id/tokens',
    { preHandler: authenticate },
    async (request, reply) => {
      const loaded = await loadBotForOwner(request.params.id, request.userId);
      if (loaded.error) return reply.code(loaded.error.code).send({ error: loaded.error.message, statusCode: loaded.error.code });
      const db = getDb();
      const rows = db.select({
        id: schema.botTokens.id,
        tokenPrefix: schema.botTokens.tokenPrefix,
        scopes: schema.botTokens.scopes,
        allowedChannels: schema.botTokens.allowedChannels,
        label: schema.botTokens.label,
        createdAt: schema.botTokens.createdAt,
        expiresAt: schema.botTokens.expiresAt,
        lastUsedAt: schema.botTokens.lastUsedAt,
        revokedAt: schema.botTokens.revokedAt,
        revokedReason: schema.botTokens.revokedReason,
      })
        .from(schema.botTokens)
        .where(eq(schema.botTokens.botUserId, request.params.id))
        .orderBy(desc(schema.botTokens.createdAt))
        .all();
      const response: { tokens: BotTokenListItem[] } = {
        tokens: rows.map((r) => ({
          id: r.id,
          tokenPreview: maskBotToken(r.tokenPrefix),
          scopes: JSON.parse(r.scopes) as string[],
          allowedChannels: r.allowedChannels ? (JSON.parse(r.allowedChannels) as string[]) : null,
          label: r.label,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          lastUsedAt: r.lastUsedAt,
          revokedAt: r.revokedAt,
          revokedReason: r.revokedReason,
        })),
      };
      return reply.code(200).send(response);
    },
  );

  // ─── DELETE /api/bots/:id/tokens/:tokenId ────────────────────────────────
  app.delete<{ Params: { id: string; tokenId: string } }>(
    '/api/bots/:id/tokens/:tokenId',
    { preHandler: authenticate },
    async (request, reply) => {
      const loaded = await loadBotForOwner(request.params.id, request.userId);
      if (loaded.error) return reply.code(loaded.error.code).send({ error: loaded.error.message, statusCode: loaded.error.code });
      const db = getDb();
      const now = Date.now();
      const updated = db.update(schema.botTokens)
        .set({ revokedAt: now, revokedReason: 'manual' })
        .where(and(eq(schema.botTokens.id, request.params.tokenId), eq(schema.botTokens.botUserId, request.params.id), isNull(schema.botTokens.revokedAt)))
        .run();
      if (updated.changes === 0) {
        return reply.code(404).send({ error: 'Token not found or already revoked', statusCode: 404 });
      }
      await recordAudit(db, {
        tokenId: request.params.tokenId,
        botUserId: request.params.id,
        actorUserId: request.userId,
        action: 'token.revoke',
      });
      return reply.code(200).send({ success: true });
    },
  );

  // ─── POST /api/bots/:id/tokens/:tokenId/rotate ───────────────────────────
  // Atomic: revoke old + mint new in one transaction. Returns new plaintext.
  app.post<{ Params: { id: string; tokenId: string } }>(
    '/api/bots/:id/tokens/:tokenId/rotate',
    { preHandler: authenticate },
    async (request, reply) => {
      const loaded = await loadBotForOwner(request.params.id, request.userId);
      if (loaded.error) return reply.code(loaded.error.code).send({ error: loaded.error.message, statusCode: loaded.error.code });
      const db = getDb();
      // Fetch old scopes so the new token inherits them by default.
      const old = db.select({ scopes: schema.botTokens.scopes })
        .from(schema.botTokens)
        .where(and(eq(schema.botTokens.id, request.params.tokenId), eq(schema.botTokens.botUserId, request.params.id)))
        .get();
      if (!old) {
        return reply.code(404).send({ error: 'Token not found', statusCode: 404 });
      }
      const now = Date.now();
      // Parse old scopes to inherit. If parsing fails, use empty list.
      let inherited: BotScope[] = [];
      try {
        inherited = parseScopeList(JSON.parse(old.scopes));
      } catch {
        inherited = [];
      }

      const newMint = mintBotToken();
      const newTokenId = generateSnowflake();
      const result = db.transaction((tx) => {
        tx.update(schema.botTokens)
          .set({ revokedAt: now, revokedReason: 'rotated' })
          .where(and(eq(schema.botTokens.id, request.params.tokenId), isNull(schema.botTokens.revokedAt)))
          .run();
        tx.insert(schema.botTokens).values({
          id: newTokenId,
          botUserId: request.params.id,
          tokenHash: newMint.tokenHash,
          tokenPrefix: newMint.tokenPrefix,
          scopes: JSON.stringify(inherited),
          allowedChannels: null,
          label: null,
          createdAt: now,
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
          revokedReason: null,
        }).run();
        return { newTokenId, newPlaintext: newMint.plaintext };
      });

      await recordAudit(db, {
        tokenId: request.params.tokenId,
        botUserId: request.params.id,
        actorUserId: request.userId,
        action: 'token.rotate',
        details: `new=${result.newTokenId}`,
      });

      const response: BotTokenMintResponse = {
        id: result.newTokenId,
        plaintext: result.newPlaintext,
        tokenPreview: maskBotToken(newMint.tokenPrefix),
        scopes: inherited,
        label: null,
        createdAt: now,
      };
      return reply.code(200).send(response);
    },
  );

  // ─── POST /api/auth/bot/login ────────────────────────────────────────────
  // Exchange a bot API token for a bot JWT. The JWT carries the token's
  // scope set so downstream endpoints can check it via requireScope().
  app.post<{ Body: BotAuthLoginRequest }>(
    '/api/auth/bot/login',
    async (request, reply) => {
      const body = request.body;
      if (!body?.token || typeof body.token !== 'string') {
        return reply.code(400).send({ error: 'token is required', statusCode: 400 });
      }
      if (!isWellFormedBotToken(body.token)) {
        return reply.code(401).send({ error: 'Invalid token', statusCode: 401 });
      }
      const db = getDb();
      const tokenHash = (await import('../utils/botTokens.js')).hashBotToken(body.token);
      const row = db.select({
        id: schema.botTokens.id,
        botUserId: schema.botTokens.botUserId,
        scopes: schema.botTokens.scopes,
        revokedAt: schema.botTokens.revokedAt,
        expiresAt: schema.botTokens.expiresAt,
      })
        .from(schema.botTokens)
        .where(eq(schema.botTokens.tokenHash, tokenHash))
        .get();
      if (!row || row.revokedAt !== null) {
        return reply.code(401).send({ error: 'Invalid token', statusCode: 401 });
      }
      if (row.expiresAt !== null && row.expiresAt < Date.now()) {
        return reply.code(401).send({ error: 'Token expired', statusCode: 401 });
      }
      const bot = db.select({
        id: schema.users.id,
        username: schema.users.username,
        isDeleted: schema.users.isDeleted,
        accountType: schema.users.accountType,
      })
        .from(schema.users)
        .where(eq(schema.users.id, row.botUserId))
        .get();
      if (!bot || bot.isDeleted === 1 || bot.accountType === 'human') {
        return reply.code(401).send({ error: 'Bot not found', statusCode: 401 });
      }
      const scopes: string[] = (() => {
        try { return JSON.parse(row.scopes) as string[]; }
        catch { return []; }
      })();
      const jwt = signJwt({
        userId: bot.id,
        username: bot.username,
        accountType: 'bot',
        scopes,
        tokenId: row.id,
      });
      // Opportunistic lastUsedAt — best effort, not in a transaction.
      db.update(schema.botTokens)
        .set({ lastUsedAt: Date.now() })
        .where(eq(schema.botTokens.id, row.id))
        .run();
      const response: BotAuthLoginResponse = {
        token: jwt,
        bot: {
          id: bot.id,
          username: bot.username,
          accountType: 'bot',
        },
        scopes,
      };
      return reply.code(200).send(response);
    },
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function mintTokenAndRecord(
  db: ReturnType<typeof getDb>,
  botUserId: string,
  actorUserId: string,
  scopes: BotScope[],
  label: string | null,
): BotTokenMintResponse {
  const now = Date.now();
  const minted = mintBotToken();
  const id = generateSnowflake();
  db.insert(schema.botTokens).values({
    id,
    botUserId,
    tokenHash: minted.tokenHash,
    tokenPrefix: minted.tokenPrefix,
    scopes: JSON.stringify(scopes),
    allowedChannels: null,
    label,
    createdAt: now,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
  }).run();
  // Audit best-effort (sync insert — audit must not block token mint).
  db.insert(schema.botTokenAudit).values({
    id: generateSnowflake(),
    tokenId: id,
    botUserId,
    actorUserId,
    action: label === 'initial' ? 'token.mint.initial' : 'token.mint',
    details: JSON.stringify({ scopes }),
    createdAt: now,
  }).run();
  return {
    id,
    plaintext: minted.plaintext,
    tokenPreview: maskBotToken(minted.tokenPrefix),
    scopes,
    label,
    createdAt: now,
  };
}
