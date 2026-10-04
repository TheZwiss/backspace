import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, signJwt } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { tombstoneUser, collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';
import { deleteUploadFile, deleteAttachmentByFilename } from '../utils/fileCleanup.js';
import { connectionManager } from '../ws/handler.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { BOT_NAME_MAX_LENGTH, BOT_NAME_MIN_LENGTH, BOT_NAME_SUFFIX, MAX_BOTS_PER_USER } from '@backspace/shared/src/constants.js';
import { collectBotFederationOrigins, revokeBotOnPeers } from '../utils/botFederation.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { resizeProfileImage } from '../utils/thumbnail.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { queueProfileUpdateRelay } from '../utils/profileRelay.js';
import type { BotSearchResult, BotSummary, UpdateBotRequest, UpdateBotResponse } from '@backspace/shared';
import { hasPermission, isBanned, isMember, isSpaceOwner, PermissionBits } from '../utils/permissions.js';
import { addUserToSpace, removeUserFromSpace } from '../utils/spaceMembership.js';

/** Not a bcrypt hash, so password login is impossible (same idea as '!federation-replicated'). */
const BOT_PASSWORD_MARKER = '!bot';
/** Bot tokens are JWTs; revocation goes through users.passwordChangedAt. */
const BOT_TOKEN_TTL = '3650d';
const BOT_NAME_RE = /^[a-z0-9_]+$/;
/** Bounds of the invite search string: a username is 5-32 characters, so nothing outside can match. */
const BOT_SEARCH_MIN_QUERY = 2;
const BOT_SEARCH_MAX_QUERY = 32;
/** A bare upload filename: starts alphanumeric, so `..` and dotfiles cannot pass. */
const AVATAR_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** Same palette as registration (routes/auth.ts). */
const AVATAR_COLORS = ['mint', 'sky', 'lavender', 'coral', 'rose', 'teal', 'amber'] as const;

function toSummary(row: typeof schema.users.$inferSelect): BotSummary {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarColor: row.avatarColor,
    avatar: row.avatar,
    createdAt: row.createdAt,
  };
}

function findOwnedBot(ownerId: string, botId: string) {
  return getDb().select().from(schema.users).where(and(
    eq(schema.users.id, botId),
    eq(schema.users.botOwnerId, ownerId),
    eq(schema.users.isBot, 1),
    eq(schema.users.isDeleted, 0),
  )).get();
}

/** Any native bot of this instance, whatever its owner: the target a space
 * manager may invite. Federated bot accounts belong to their home instance
 * and cannot be invited here. */
function findInviteableBot(botId: string) {
  return getDb().select().from(schema.users).where(and(
    eq(schema.users.id, botId),
    eq(schema.users.isBot, 1),
    sql`(${schema.users.homeInstance} IS NULL OR ${schema.users.homeInstance} = '')`,
    eq(schema.users.isDeleted, 0),
  )).get();
}

/**
 * Bot management for the owning human. Bots are ordinary `users` rows with
 * `is_bot = 1`; they authenticate with a long-lived JWT issued here.
 */
export async function botRoutes(app: FastifyInstance): Promise<void> {
  // Only a human with an account native to this instance manages bots.
  const requireNativeHuman = async (request: FastifyRequest, reply: FastifyReply) => {
    const caller = getDb().select({ isBot: schema.users.isBot })
      .from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!caller || caller.isBot === 1 || request.homeInstance) {
      return sendError(reply, 403, 'bots_native_only');
    }
  };
  const pre = [authenticate, requireNativeHuman];
  // Inviting or removing a bot is an action on a space of this instance, not on the
  // bot's home: a federated human who manages the space may do it. Bots may not.
  const requireHuman = async (request: FastifyRequest, reply: FastifyReply) => {
    const caller = getDb().select({ isBot: schema.users.isBot })
      .from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!caller || caller.isBot === 1) {
      return sendError(reply, 403, 'bots_native_only');
    }
  };
  const preSpaceAction = [authenticate, requireHuman];
  const rateLimit = { rateLimit: { max: 5, timeWindow: '15 minutes' } };

  app.get('/api/bots', { preHandler: pre }, async (request, reply) => {
    const rows = getDb().select().from(schema.users).where(and(
      eq(schema.users.botOwnerId, request.userId),
      eq(schema.users.isBot, 1),
      eq(schema.users.isDeleted, 0),
    )).orderBy(schema.users.createdAt).all();
    return reply.send({ bots: rows.map(toSummary) });
  });

  // Bots of this instance a manager can invite. A plain directory by username
  // substring; what a bot does in the space stays with the bot's own code.
  app.get<{ Querystring: { q?: unknown } }>('/api/bots/search', {
    preHandler: [authenticate],
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const q = typeof request.query?.q === 'string' ? request.query.q.trim() : '';
    if (q.length < BOT_SEARCH_MIN_QUERY || q.length > BOT_SEARCH_MAX_QUERY) return reply.send({ bots: [] });
    // A `%` or `_` typed by the person is a literal character, not a wildcard.
    const pattern = `%${q.replace(/[!%_]/g, '!$&')}%`;
    const rows = getDb().select().from(schema.users).where(and(
      eq(schema.users.isBot, 1),
      eq(schema.users.isDeleted, 0),
      eq(schema.users.discoverable, 1),
      sql`(${schema.users.homeInstance} IS NULL OR ${schema.users.homeInstance} = '')`,
      sql`${schema.users.username} LIKE ${pattern} ESCAPE '!'`,
    )).orderBy(schema.users.username).limit(25).all();
    const ownerIds = [...new Set(rows.flatMap((r) => (r.botOwnerId === null ? [] : [r.botOwnerId])))];
    // An owner is named only while they are a visible person: a deleted or non-discoverable owner stays private.
    const ownerNames = new Map<string, string>();
    if (ownerIds.length > 0) {
      const owners = getDb().select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(and(
        inArray(schema.users.id, ownerIds),
        eq(schema.users.isDeleted, 0),
        eq(schema.users.discoverable, 1),
      )).all();
      for (const owner of owners) ownerNames.set(owner.id, owner.username);
    }
    const result: BotSearchResult[] = rows.map((r) => ({
      ...toSummary(r),
      ownerUsername: (r.botOwnerId === null ? undefined : ownerNames.get(r.botOwnerId)) ?? null,
    }));
    return reply.send({ bots: result });
  });

  app.post<{ Body: { name?: unknown } }>('/api/bots', {
    preHandler: pre,
    config: rateLimit,
  }, async (request, reply) => {
    const db = getDb();
    const raw = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    const lowered = raw.toLowerCase();
    // The suffix is added for the caller; a name that already carries it is kept.
    const username = lowered.endsWith(BOT_NAME_SUFFIX) ? lowered : `${lowered}${BOT_NAME_SUFFIX}`;
    if (username.length < BOT_NAME_MIN_LENGTH || username.length > BOT_NAME_MAX_LENGTH || !BOT_NAME_RE.test(username)) {
      return sendError(reply, 400, 'bot_name_invalid', { min: BOT_NAME_MIN_LENGTH, max: BOT_NAME_MAX_LENGTH });
    }

    const owned = db.select({ n: sql<number>`count(*)` }).from(schema.users).where(and(
      eq(schema.users.botOwnerId, request.userId),
      eq(schema.users.isBot, 1),
      eq(schema.users.isDeleted, 0),
    )).get();
    if ((owned?.n ?? 0) >= MAX_BOTS_PER_USER) {
      return sendError(reply, 400, 'bot_limit_reached', { max: MAX_BOTS_PER_USER });
    }

    const id = generateSnowflake();
    try {
      db.insert(schema.users).values({
        id,
        username,
        displayName: username,
        passwordHash: BOT_PASSWORD_MARKER,
        avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
        isBot: 1,
        botOwnerId: request.userId,
        discoverable: 1,
        createdAt: Date.now(),
      }).run();
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        return sendError(reply, 409, 'username_taken');
      }
      throw err;
    }

    const bot = db.select().from(schema.users).where(eq(schema.users.id, id)).get();
    if (!bot) return sendError(reply, 500, 'internal_error');
    const token = signJwt({ userId: id, username }, { expiresIn: BOT_TOKEN_TTL });
    return reply.code(201).send({ bot: toSummary(bot), token });
  });


  app.patch<{ Params: { id: string }; Body: UpdateBotRequest }>('/api/bots/:id', {
    preHandler: pre,
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const db = getDb();
    const bot = findOwnedBot(request.userId, request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');

    const { displayName, avatar } = request.body ?? {};
    const update: { displayName?: string; avatar?: string | null } = {};

    // The login (username) is deliberately not editable: it is the federation
    // identity peers and host accounts (`name@home`) are keyed on.
    if (displayName !== undefined) {
      const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
      // The suffix marks a bot everywhere its name is shown: it must stay last,
      // with something in front of it.
      if (!trimmed.endsWith(BOT_NAME_SUFFIX) || trimmed.slice(0, -BOT_NAME_SUFFIX.length).trim().length === 0) {
        return sendError(reply, 400, 'bot_name_suffix_required', { suffix: BOT_NAME_SUFFIX });
      }
      if (trimmed.length > BOT_NAME_MAX_LENGTH) {
        return sendError(reply, 400, 'display_name_too_long', { max: BOT_NAME_MAX_LENGTH });
      }
      update.displayName = trimmed;
    }

    let newAvatar: string | null | undefined;
    if (avatar !== undefined) {
      if (avatar === null) {
        newAvatar = null;
      } else if (typeof avatar === 'string') {
        const bare = avatar.startsWith('/api/uploads/') ? avatar.slice('/api/uploads/'.length) : avatar;
        if (!AVATAR_FILE_RE.test(bare) || !fs.existsSync(path.join(config.uploadDir, bare))) {
          return sendError(reply, 400, 'avatar_url_invalid');
        }
        newAvatar = bare;
      } else {
        return sendError(reply, 400, 'avatar_url_invalid');
      }
      update.avatar = newAvatar;
    }

    if (Object.keys(update).length === 0) {
      return sendError(reply, 400, 'no_fields_to_update');
    }

    // Monotonic: a receiver ignores a profile version that is not newer.
    const profileUpdatedAt = Math.max(Date.now(), (bot.profileUpdatedAt ?? 0) + 1);
    db.update(schema.users).set({ ...update, profileUpdatedAt }).where(eq(schema.users.id, bot.id)).run();

    if (newAvatar !== undefined && bot.avatar && bot.avatar !== newAvatar && !bot.avatar.startsWith('http')) {
      await deleteUploadFile(bot.avatar);
      deleteAttachmentByFilename(bot.avatar);
    }
    if (typeof newAvatar === 'string') {
      // The upload's attachment record is redundant once users.avatar holds it
      // (same handling as PATCH /users/@me).
      if (typeof avatar === 'string' && avatar.includes('/api/uploads/')) deleteAttachmentByFilename(avatar);
      await resizeProfileImage(path.join(config.uploadDir, newAvatar), 'avatar');
    }

    const updated = db.select().from(schema.users).where(eq(schema.users.id, bot.id)).get();
    if (!updated) return sendError(reply, 500, 'internal_error');

    const targets = collectProfileBroadcastTargetIds(bot.id);
    targets.add(bot.id);
    for (const uid of targets) {
      connectionManager.sendToUser(uid, { type: 'user_updated' as const, user: sanitizeUser(updated, uid === bot.id) });
    }
    queueProfileUpdateRelay(updated);

    const response: UpdateBotResponse = { bot: toSummary(updated) };
    return reply.send(response);
  });

  // Spaces the caller may add the bot to (MANAGE_SPACE), plus every space the
  // bot already sits in — a manager may have invited it without the owner.
  app.get<{ Params: { id: string } }>('/api/bots/:id/spaces', { preHandler: pre }, async (request, reply) => {
    const bot = findOwnedBot(request.userId, request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');
    const db = getDb();
    const mine = db.select({ id: schema.spaces.id, name: schema.spaces.name, icon: schema.spaces.icon })
      .from(schema.spaceMembers)
      .innerJoin(schema.spaces, eq(schema.spaceMembers.spaceId, schema.spaces.id))
      .where(eq(schema.spaceMembers.userId, request.userId))
      .all();
    const botSpaces = db.select({ id: schema.spaces.id, name: schema.spaces.name, icon: schema.spaces.icon })
      .from(schema.spaceMembers)
      .innerJoin(schema.spaces, eq(schema.spaceMembers.spaceId, schema.spaces.id))
      .where(eq(schema.spaceMembers.userId, bot.id))
      .all();
    const botSpaceIds = new Set(botSpaces.map(s => s.id));
    // Spaces the caller may add the bot to, plus every space the bot already
    // sits in: a manager may invite the bot without its owner taking part, so
    // the owner's oversight must not stop at their own manageable spaces.
    const rows = new Map(
      mine
        .filter(s => hasPermission(request.userId, s.id, PermissionBits.MANAGE_SPACE))
        .map(s => [s.id, { id: s.id, name: s.name, icon: s.icon, botIsMember: botSpaceIds.has(s.id) }] as const),
    );
    for (const s of botSpaces) {
      if (!rows.has(s.id)) rows.set(s.id, { id: s.id, name: s.name, icon: s.icon, botIsMember: true });
    }
    return reply.send({ spaces: [...rows.values()] });
  });

  // A space manager brings a bot into a space they manage. Same result as the
  // bot joining by invite, without handing out a code.
  app.post<{ Params: { id: string }; Body: { spaceId?: unknown } }>('/api/bots/:id/spaces', {
    preHandler: preSpaceAction,
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    // Any space manager may bring any native bot of this instance in; the
    // bot's owner does not take part (no consent round-trip).
    const bot = findInviteableBot(request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');
    const spaceId = typeof request.body?.spaceId === 'string' ? request.body.spaceId : '';
    if (!spaceId) {
      return sendError(reply, 400, 'validation_failed', { field: 'spaceId', reason: 'is required' });
    }
    const space = getDb().select({ id: schema.spaces.id }).from(schema.spaces)
      .where(eq(schema.spaces.id, spaceId)).get();
    if (!space) return sendError(reply, 404, 'space_not_found');
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_SPACE' });
    }
    if (isBanned(spaceId, bot.id)) return sendError(reply, 403, 'user_banned');
    if (isMember(spaceId, bot.id)) return sendError(reply, 409, 'already_member');
    addUserToSpace(spaceId, bot.id);
    return reply.send({ success: true });
  });

  // The counterpart of the add above: the bot's owner or a space manager takes the bot out.
  app.delete<{ Params: { id: string; spaceId: string } }>('/api/bots/:id/spaces/:spaceId', {
    preHandler: preSpaceAction,
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    // The owner may take their bot out of any space; a space manager may
    // take any bot out of a space they manage.
    const bot = findInviteableBot(request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');
    const { spaceId } = request.params;
    const space = getDb().select({ id: schema.spaces.id }).from(schema.spaces)
      .where(eq(schema.spaces.id, spaceId)).get();
    if (!space) return sendError(reply, 404, 'space_not_found');
    const byBotOwner = bot.botOwnerId === request.userId;
    if (!byBotOwner && !hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE)) {
      return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_SPACE' });
    }
    if (!isMember(spaceId, bot.id)) return sendError(reply, 404, 'member_not_found');
    if (isSpaceOwner(spaceId, bot.id)) return sendError(reply, 400, 'cannot_target_owner');
    removeUserFromSpace(spaceId, bot.id);
    return reply.send({ success: true });
  });

  app.post<{ Params: { id: string } }>('/api/bots/:id/token', {
    preHandler: pre,
    config: rateLimit,
  }, async (request, reply) => {
    const bot = findOwnedBot(request.userId, request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');
    // Cut the bot off from every instance it registered on FIRST: a leaked
    // token could already have minted host JWTs there, and those outlive the
    // home token. The host account is tombstoned; the legitimate bot
    // re-registers with the new token and rejoins by invite.
    const origins = collectBotFederationOrigins(bot.id);
    const federation = await revokeBotOnPeers(bot.id, origins, 'soft');
    getDb().delete(schema.userFederationCredentials)
      .where(eq(schema.userFederationCredentials.userId, bot.id)).run();
    // Revokes every earlier token: same mechanism as a password change.
    getDb().update(schema.users).set({ passwordChangedAt: Date.now() })
      .where(eq(schema.users.id, bot.id)).run();
    connectionManager.forceDisconnectUser(bot.id);
    const token = signJwt({ userId: bot.id, username: bot.username }, { expiresIn: BOT_TOKEN_TTL });
    return reply.send({ token, federation });
  });

  app.delete<{ Params: { id: string } }>('/api/bots/:id', {
    preHandler: pre,
  }, async (request, reply) => {
    const bot = findOwnedBot(request.userId, request.params.id);
    if (!bot) return sendError(reply, 404, 'bot_not_found');
    const origins = collectBotFederationOrigins(bot.id);
    const federation = await revokeBotOnPeers(bot.id, origins, 'full');
    const files = tombstoneUser(bot.id);
    connectionManager.forceDisconnectUser(bot.id);
    for (const filename of files) await deleteUploadFile(filename);
    return reply.send({ success: true, federation });
  });
}
