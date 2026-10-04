import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type {
  BotCommandListing,
  BotCommandOption,
  BotInteraction,
  BotInteractionOptionValue,
  ChatCommandsResponse,
  CreateInteractionRequest,
  CreateInteractionResponse,
  RespondToInteractionRequest,
} from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { requireBot } from '../utils/botAuth.js';
import { sendError } from '../utils/httpErrors.js';
import { getChannelSpaceId, hasPermission, isDmMember, isMember, PermissionBits } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { connectionManager } from '../ws/handler.js';

const INTERACTION_TTL_MS = 15 * 60 * 1000;
const MAX_RESPONSES = 5;
const STRING_OPTION_MAX = 2000;
/** A spent interaction is dropped by the first invocation that comes after this long. */
const KEEP_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;

type Chat =
  | { kind: 'channel'; channelId: string; spaceId: string }
  | { kind: 'dm'; dmChannelId: string };
type Refusal = 'invalid' | 'channel_not_found' | 'missing_permission' | 'not_dm_member';
type Access = { ok: true; chat: Chat } | { ok: false; reason: Refusal };
interface Problem { field: string; reason: string }

function isProblem(value: unknown): value is Problem {
  return typeof value === 'object' && value !== null
    && typeof (value as Problem).field === 'string' && typeof (value as Problem).reason === 'string';
}

/** The chat a request names (exactly one of channel and DM) and whether `userId` may use it. */
function authorize(userId: string, channelId: unknown, dmChannelId: unknown, need: 'view' | 'send'): Access {
  const channel = typeof channelId === 'string' && channelId.length > 0 ? channelId : null;
  const dm = typeof dmChannelId === 'string' && dmChannelId.length > 0 ? dmChannelId : null;
  if ((channel === null) === (dm === null)) return { ok: false, reason: 'invalid' };
  if (channel !== null) {
    const spaceId = getChannelSpaceId(channel);
    if (!spaceId) return { ok: false, reason: 'channel_not_found' };
    const bit = need === 'send' ? PermissionBits.SEND_MESSAGES : PermissionBits.VIEW_CHANNEL;
    if (!isMember(spaceId, userId) || !hasPermission(userId, spaceId, bit, channel)) {
      return { ok: false, reason: 'missing_permission' };
    }
    return { ok: true, chat: { kind: 'channel', channelId: channel, spaceId } };
  }
  if (dm === null || !isDmMember(dm, userId)) return { ok: false, reason: 'not_dm_member' };
  return { ok: true, chat: { kind: 'dm', dmChannelId: dm } };
}

function refuse(reply: FastifyReply, reason: Refusal, permission: string): FastifyReply {
  switch (reason) {
    case 'invalid':
      return sendError(reply, 400, 'validation_failed', { field: 'channelId', reason: 'give exactly one of channelId and dmChannelId' });
    case 'channel_not_found':
      return sendError(reply, 404, 'channel_not_found');
    case 'missing_permission':
      return sendError(reply, 403, 'missing_permission', { permission });
    case 'not_dm_member':
      return sendError(reply, 403, 'not_dm_member');
  }
}

function botIdsInChat(chat: Chat): string[] {
  const db = getDb();
  if (chat.kind === 'channel') {
    return db.select({ id: schema.users.id })
      .from(schema.spaceMembers)
      .innerJoin(schema.users, eq(schema.spaceMembers.userId, schema.users.id))
      .where(and(eq(schema.spaceMembers.spaceId, chat.spaceId), eq(schema.users.isBot, 1), eq(schema.users.isDeleted, 0)))
      .all().map((r) => r.id);
  }
  return db.select({ id: schema.users.id })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(and(eq(schema.dmMembers.dmChannelId, chat.dmChannelId), eq(schema.users.isBot, 1), eq(schema.users.isDeleted, 0)))
    .all().map((r) => r.id);
}

/** The values of an invocation checked against the command's definition. */
function checkOptions(defs: BotCommandOption[], given: unknown): Record<string, BotInteractionOptionValue> | Problem {
  const input = given === undefined || given === null ? {} : given;
  if (typeof input !== 'object' || Array.isArray(input)) return { field: 'options', reason: 'must be an object' };
  const record = input as Record<string, unknown>;

  const known = new Set(defs.map((d) => d.name));
  for (const key of Object.keys(record)) {
    if (!known.has(key)) return { field: `options.${key}`, reason: 'is not an option of this command' };
  }

  const out: Record<string, BotInteractionOptionValue> = {};
  for (const def of defs) {
    const field = `options.${def.name}`;
    const value = Object.prototype.hasOwnProperty.call(record, def.name) ? record[def.name] : undefined;
    if (value === undefined || value === null) {
      if (def.required) return { field, reason: 'is required' };
      continue;
    }
    if (def.type === 'string') {
      if (typeof value !== 'string' || value.length === 0 || value.length > STRING_OPTION_MAX) {
        return { field, reason: `must be a string of 1 to ${STRING_OPTION_MAX} characters` };
      }
    } else if (def.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return { field, reason: 'must be a safe integer' };
    } else if (def.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { field, reason: 'must be a finite number' };
    } else if (typeof value !== 'boolean') {
      return { field, reason: 'must be a boolean' };
    }
    if (def.choices && !def.choices.some((choice) => choice.value === value)) {
      return { field, reason: 'must be one of the listed choices' };
    }
    out[def.name] = value as BotInteractionOptionValue;
  }
  return out;
}

/**
 * Slash command invocation. A user picks a command of a bot that is in the
 * chat; the server checks the user may write there and the values fit the
 * definition, then hands the bot an `interaction_created` event over its
 * socket. The bot answers through `respond`, which posts an ordinary message
 * (same route, same rules) while the interaction lasts.
 */
export async function interactionRoutes(app: FastifyInstance): Promise<void> {
  const sendLimit = {
    rateLimit: {
      max: 5,
      timeWindow: '5 seconds',
      // Per client address, like every limit in this app (api.md, "Rate limiting").
      keyGenerator: (request: FastifyRequest) => request.ip,
    },
  };

  app.get<{ Querystring: { channelId?: string; dmChannelId?: string } }>('/api/commands', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const access = authorize(request.userId, request.query.channelId, request.query.dmChannelId, 'view');
    if (!access.ok) return refuse(reply, access.reason, 'VIEW_CHANNEL');

    const botIds = botIdsInChat(access.chat);
    const empty: ChatCommandsResponse = { commands: [] };
    if (botIds.length === 0) return reply.send(empty);

    const db = getDb();
    const bots = new Map(
      db.select().from(schema.users).where(inArray(schema.users.id, botIds)).all().map((b) => [b.id, b] as const),
    );
    const commands: BotCommandListing[] = [];
    for (const row of db.select().from(schema.botCommands).where(inArray(schema.botCommands.botId, botIds)).all()) {
      const bot = bots.get(row.botId);
      if (!bot) continue;
      commands.push({
        id: row.id,
        botId: row.botId,
        name: row.name,
        description: row.description,
        options: JSON.parse(row.options) as BotCommandOption[],
        updatedAt: row.updatedAt,
        bot: {
          id: bot.id,
          username: bot.username,
          displayName: bot.displayName,
          avatar: bot.avatar,
          avatarColor: bot.avatarColor,
        },
      });
    }
    commands.sort((a, b) => a.name.localeCompare(b.name) || a.bot.username.localeCompare(b.bot.username));
    const response: ChatCommandsResponse = { commands };
    return reply.send(response);
  });

  app.post<{ Body: CreateInteractionRequest }>('/api/interactions', {
    preHandler: authenticate,
    config: sendLimit,
  }, async (request, reply) => {
    const body: Partial<CreateInteractionRequest> = request.body ?? {};
    if (typeof body.botId !== 'string' || body.botId.length === 0) {
      return sendError(reply, 400, 'validation_failed', { field: 'botId', reason: 'is required' });
    }
    if (typeof body.command !== 'string' || body.command.length === 0) {
      return sendError(reply, 400, 'validation_failed', { field: 'command', reason: 'is required' });
    }

    const access = authorize(request.userId, body.channelId, body.dmChannelId, 'send');
    if (!access.ok) return refuse(reply, access.reason, 'SEND_MESSAGES');
    const chat = access.chat;

    const db = getDb();
    const bot = db.select().from(schema.users).where(and(
      eq(schema.users.id, body.botId),
      eq(schema.users.isBot, 1),
      eq(schema.users.isDeleted, 0),
    )).get();
    const botInChat = bot !== undefined
      && (chat.kind === 'channel' ? isMember(chat.spaceId, bot.id) : isDmMember(chat.dmChannelId, bot.id));
    if (!bot || !botInChat) return sendError(reply, 404, 'bot_not_found');

    const definition = db.select().from(schema.botCommands).where(and(
      eq(schema.botCommands.botId, bot.id),
      eq(schema.botCommands.name, body.command),
    )).get();
    if (!definition) return sendError(reply, 404, 'command_not_found');

    const checked = checkOptions(JSON.parse(definition.options) as BotCommandOption[], body.options);
    if (isProblem(checked)) return sendError(reply, 400, 'validation_failed', { field: checked.field, reason: checked.reason });

    if (!connectionManager.hasLiveConnection(bot.id)) return sendError(reply, 409, 'bot_unavailable');

    const caller = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!caller) return sendError(reply, 404, 'user_not_found');

    const now = Date.now();
    // Spent interactions have no value after a day: dropped here, no worker needed.
    db.delete(schema.interactions).where(lt(schema.interactions.expiresAt, now - KEEP_AFTER_EXPIRY_MS)).run();

    const id = randomBytes(16).toString('hex');
    const expiresAt = now + INTERACTION_TTL_MS;
    db.insert(schema.interactions).values({
      id,
      botId: bot.id,
      userId: request.userId,
      channelId: chat.kind === 'channel' ? chat.channelId : null,
      dmChannelId: chat.kind === 'dm' ? chat.dmChannelId : null,
      command: definition.name,
      options: JSON.stringify(checked),
      createdAt: now,
      expiresAt,
    }).run();

    const interaction: BotInteraction = {
      id,
      command: definition.name,
      options: checked,
      user: sanitizeUser(caller),
      expiresAt,
      ...(chat.kind === 'channel'
        ? { channelId: chat.channelId, spaceId: chat.spaceId }
        : { dmChannelId: chat.dmChannelId }),
    };
    connectionManager.sendToUser(bot.id, { type: 'interaction_created', interaction });

    const response: CreateInteractionResponse = { id, expiresAt };
    return reply.code(201).send(response);
  });

  app.post<{ Params: { id: string }; Body: RespondToInteractionRequest }>('/api/interactions/:id/respond', {
    preHandler: [authenticate, requireBot],
    config: sendLimit,
  }, async (request, reply) => {
    const db = getDb();
    // Another bot's interaction looks like a missing one.
    const row = db.select().from(schema.interactions).where(and(
      eq(schema.interactions.id, request.params.id),
      eq(schema.interactions.botId, request.userId),
    )).get();
    if (!row) return sendError(reply, 404, 'interaction_not_found');

    const now = Date.now();
    if (row.expiresAt <= now) return sendError(reply, 410, 'interaction_expired');

    // Reserve one of the answers first so concurrent calls cannot overshoot the cap.
    const reserved = db.update(schema.interactions)
      .set({ responses: sql`${schema.interactions.responses} + 1` })
      .where(and(
        eq(schema.interactions.id, row.id),
        lt(schema.interactions.responses, MAX_RESPONSES),
        gt(schema.interactions.expiresAt, now),
      ))
      .run();
    if (reserved.changes === 0) return sendError(reply, 429, 'interaction_responses_exceeded');

    // The real message route: same permissions, limits, attachments, embeds and broadcast.
    const body: RespondToInteractionRequest = request.body ?? {};
    const url = row.channelId !== null
      ? `/api/channels/${row.channelId}/messages`
      : `/api/dm/${row.dmChannelId}/messages`;
    const posted = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: request.headers.authorization ?? '', 'content-type': 'application/json' },
      payload: JSON.stringify({ content: body.content, attachments: body.attachments }),
      remoteAddress: request.ip,
    });

    if (posted.statusCode >= 300) {
      // Nothing was posted: give the reserved answer back.
      db.update(schema.interactions)
        .set({ responses: sql`${schema.interactions.responses} - 1` })
        .where(eq(schema.interactions.id, row.id))
        .run();
    }
    return reply.code(posted.statusCode).type('application/json; charset=utf-8').send(posted.body);
  });
}
