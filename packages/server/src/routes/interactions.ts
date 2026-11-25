import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type {
  BotCommandListing,
  BotCommandOption,
  BotInteraction,
  BotInteractionOptionValue,
  BotInteractionResolved,
  ChannelType,
  ChatCommandsResponse,
  CreateInteractionRequest,
  CreateInteractionResponse,
  EphemeralReply,
  RespondToInteractionRequest,
} from '@backspace/shared';
import { MAX_MESSAGE_LENGTH } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { requireBot } from '../utils/botAuth.js';
import { sendError } from '../utils/httpErrors.js';
import { computePermissions, getChannelSpaceId, hasPermission, isDmMember, isMember, PermissionBits } from '../utils/permissions.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { roleView } from '../utils/permissionDataView.js';
import { connectionManager } from '../ws/handler.js';
import { COMMAND_STRING_OPTION_MAX } from '@backspace/shared/src/constants.js';
import { stringToPermissions } from '@backspace/shared/src/permissions.js';

const INTERACTION_TTL_MS = 15 * 60 * 1000;
const MAX_RESPONSES = 5;
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

interface CheckedOptions {
  options: Record<string, BotInteractionOptionValue>;
  resolved?: BotInteractionResolved;
}

/**
 * The object a `user`, `channel` or `role` value names, in the chat the
 * command is invoked in, or the reason it is refused. A user must be in the
 * chat; a channel and a role must belong to the chat's space (a DM has none),
 * and a channel must be one the invoker can see and of an accepted type. An id
 * the invoker may not learn about answers like a missing one.
 */
function resolveTarget(
  def: BotCommandOption,
  id: string,
  chat: Chat,
  invokerId: string,
  resolved: BotInteractionResolved,
): string | null {
  const db = getDb();
  if (def.type === 'user') {
    const row = db.select().from(schema.users)
      .where(and(eq(schema.users.id, id), eq(schema.users.isDeleted, 0))).get();
    const inChat = row !== undefined
      && (chat.kind === 'channel' ? isMember(chat.spaceId, row.id) : isDmMember(chat.dmChannelId, row.id));
    if (!row || !inChat) return 'must be a member of this chat';
    (resolved.users ??= {})[row.id] = sanitizeUser(row);
    return null;
  }
  if (chat.kind !== 'channel') return `a ${def.type} can only be chosen in a space`;
  if (def.type === 'channel') {
    const row = db.select().from(schema.channels)
      .where(and(eq(schema.channels.id, id), eq(schema.channels.spaceId, chat.spaceId))).get();
    if (!row || !hasPermission(invokerId, chat.spaceId, PermissionBits.VIEW_CHANNEL, row.id)) {
      return 'must be a channel of this space';
    }
    const type = row.type as ChannelType;
    if (def.channelTypes && !def.channelTypes.includes(type)) {
      return `must be a channel of type ${def.channelTypes.join(' or ')}`;
    }
    (resolved.channels ??= {})[row.id] = { id: row.id, spaceId: row.spaceId, name: row.name, type };
    return null;
  }
  const row = db.select().from(schema.roles)
    .where(and(eq(schema.roles.id, id), eq(schema.roles.spaceId, chat.spaceId))).get();
  if (!row) return 'must be a role of this space';
  (resolved.roles ??= {})[row.id] = roleView(row, false);
  return null;
}

/**
 * The values of an invocation checked against the command's definition and
 * coerced to what the bot receives: strings within their length, numbers
 * within their range, ids of users, channels and roles the chat knows (with
 * the objects in `resolved`), and one of the listed choices where the bot made
 * them strict (otherwise choices are suggestions and any fitting value goes).
 */
function checkOptions(defs: BotCommandOption[], given: unknown, chat: Chat, invokerId: string): CheckedOptions | Problem {
  const input = given === undefined || given === null ? {} : given;
  if (typeof input !== 'object' || Array.isArray(input)) return { field: 'options', reason: 'must be an object' };
  const record = input as Record<string, unknown>;

  const known = new Set(defs.map((d) => d.name));
  for (const key of Object.keys(record)) {
    if (!known.has(key)) return { field: `options.${key}`, reason: 'is not an option of this command' };
  }

  const out: Record<string, BotInteractionOptionValue> = {};
  const resolved: BotInteractionResolved = {};
  for (const def of defs) {
    const field = `options.${def.name}`;
    const value = Object.prototype.hasOwnProperty.call(record, def.name) ? record[def.name] : undefined;
    if (value === undefined || value === null) {
      if (def.required) return { field, reason: 'is required' };
      continue;
    }
    if (def.type === 'string') {
      const min = def.minLength ?? 1;
      const max = def.maxLength ?? COMMAND_STRING_OPTION_MAX;
      if (typeof value !== 'string' || value.length < min || value.length > max) {
        return { field, reason: `must be a string of ${min} to ${max} characters` };
      }
    } else if (def.type === 'integer' || def.type === 'number') {
      const whole = def.type === 'integer';
      if (typeof value !== 'number' || !(whole ? Number.isSafeInteger(value) : Number.isFinite(value))) {
        return { field, reason: whole ? 'must be a safe integer' : 'must be a finite number' };
      }
      if (def.minValue !== undefined && value < def.minValue) return { field, reason: `must be at least ${def.minValue}` };
      if (def.maxValue !== undefined && value > def.maxValue) return { field, reason: `must be at most ${def.maxValue}` };
    } else if (def.type === 'boolean') {
      if (typeof value !== 'boolean') return { field, reason: 'must be a boolean' };
    } else {
      if (typeof value !== 'string' || value.length === 0) return { field, reason: `must be the id of a ${def.type}` };
      const refusal = resolveTarget(def, value, chat, invokerId, resolved);
      if (refusal) return { field, reason: refusal };
    }
    if (def.strictChoices && def.choices && !def.choices.some((choice) => choice.value === value)) {
      return { field, reason: 'must be one of the listed choices' };
    }
    out[def.name] = value as BotInteractionOptionValue;
  }
  return Object.keys(resolved).length > 0 ? { options: out, resolved } : { options: out };
}

/** Whether a command's (or a group's) options are the steps of a path rather than values. */
function holdsSteps(defs: BotCommandOption[]): boolean {
  return defs.some((d) => d.type === 'subcommand' || d.type === 'subcommand_group');
}

/**
 * The value options an invocation is checked against: the command's own, or,
 * for a command with subcommands, those of the subcommand its `subcommand`
 * path names (a subcommand, or a group and one of its subcommands). A path is
 * required exactly when the command has subcommands, and must end at one.
 */
interface Leaf {
  path: string[];
  options: BotCommandOption[];
  /** The permissions the steps of the path ask for, on top of the command's own. */
  needed: bigint;
}

function leafOptions(defs: BotCommandOption[], given: unknown): Leaf | Problem {
  const steps = holdsSteps(defs);
  if (given === undefined || given === null || (Array.isArray(given) && given.length === 0)) {
    if (!steps) return { path: [], options: defs, needed: 0n };
    return { field: 'subcommand', reason: `is required: one of ${defs.map((d) => d.name).join(', ')}` };
  }
  if (!steps) return { field: 'subcommand', reason: 'this command has no subcommands' };
  if (!Array.isArray(given) || given.length > 2 || given.some((word) => typeof word !== 'string')) {
    return { field: 'subcommand', reason: 'must be a list of one or two names' };
  }
  const path = given as string[];
  const first = defs.find((d) => d.name === path[0]);
  if (!first) return { field: 'subcommand', reason: `must start with one of ${defs.map((d) => d.name).join(', ')}` };
  if (first.type === 'subcommand') {
    if (path.length !== 1) return { field: 'subcommand', reason: `${first.name} is a subcommand, not a group` };
    return { path, options: first.options ?? [], needed: stringToPermissions(first.requiredPermissions) };
  }
  const inGroup = first.options ?? [];
  const leaf = path.length === 2 ? inGroup.find((d) => d.name === path[1]) : undefined;
  if (!leaf) return { field: 'subcommand', reason: `${first.name} needs one of ${inGroup.map((d) => d.name).join(', ')}` };
  return {
    path,
    options: leaf.options ?? [],
    needed: stringToPermissions(first.requiredPermissions) | stringToPermissions(leaf.requiredPermissions),
  };
}

/** The names of the permissions in `bits`, for an answer that says which are missing. */
function permissionNames(bits: bigint): string {
  return Object.entries(PermissionBits).filter(([, bit]) => (bits & bit) !== 0n).map(([name]) => name).join(', ');
}

/** What `userId` holds in the chat, channel overrides applied; null in a DM, which has no permissions. */
function heldIn(userId: string, chat: Chat): bigint | null {
  return chat.kind === 'channel' ? computePermissions(userId, chat.spaceId, chat.channelId) : null;
}

/**
 * The permissions of `needed` missing from `held`: none when nothing is
 * needed; all of them in a DM; none with ADMINISTRATOR (the space owner and
 * instance admins hold every permission).
 */
function missingPermissions(held: bigint | null, needed: bigint): bigint {
  if (needed === 0n) return 0n;
  if (held === null) return needed;
  if ((held & PermissionBits.ADMINISTRATOR) !== 0n) return 0n;
  return needed & ~held;
}

/**
 * A command as seen by someone holding `held`, or null when it is hidden: the
 * command's own permissions must be held, and the subcommands and groups whose
 * permissions are not are left out (a group left empty goes too, and a command
 * whose every subcommand went is hidden).
 */
function visibleOptions(options: BotCommandOption[], required: string | null, held: bigint | null): BotCommandOption[] | null {
  const allowed = (mask: string | null | undefined) => missingPermissions(held, stringToPermissions(mask)) === 0n;
  if (!allowed(required)) return null;
  if (!holdsSteps(options)) return options;
  const kept: BotCommandOption[] = [];
  for (const step of options) {
    if (!allowed(step.requiredPermissions)) continue;
    if (step.type === 'subcommand_group') {
      const subs = (step.options ?? []).filter((sub) => allowed(sub.requiredPermissions));
      if (subs.length > 0) kept.push({ ...step, options: subs });
    } else {
      kept.push(step);
    }
  }
  return kept.length > 0 ? kept : null;
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
    const held = heldIn(request.userId, access.chat);
    for (const row of db.select().from(schema.botCommands).where(inArray(schema.botCommands.botId, botIds)).all()) {
      const bot = bots.get(row.botId);
      if (!bot) continue;
      // A command (or a subcommand) the caller lacks the permissions for is not listed.
      const options = visibleOptions(JSON.parse(row.options) as BotCommandOption[], row.requiredPermissions, held);
      if (!options) continue;
      commands.push({
        id: row.id,
        botId: row.botId,
        name: row.name,
        description: row.description,
        options,
        ...(row.requiredPermissions ? { requiredPermissions: row.requiredPermissions } : {}),
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

    const db = getDb();
    const caller = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!caller) return sendError(reply, 404, 'user_not_found');
    // A slash command is something a person asks of a bot. A bot invoking one
    // (its own or another bot's) could start two bots answering each other.
    if (caller.isBot === 1) return sendError(reply, 403, 'bots_cannot_invoke_commands');

    const access = authorize(request.userId, body.channelId, body.dmChannelId, 'send');
    if (!access.ok) return refuse(reply, access.reason, 'SEND_MESSAGES');
    const chat = access.chat;

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

    const leaf = leafOptions(JSON.parse(definition.options) as BotCommandOption[], body.subcommand);
    if (isProblem(leaf)) return sendError(reply, 400, 'validation_failed', { field: leaf.field, reason: leaf.reason });
    // The permissions the command and the steps of its path ask of the caller, in this channel.
    const needed = stringToPermissions(definition.requiredPermissions) | leaf.needed;
    const missing = needed === 0n ? 0n : missingPermissions(heldIn(request.userId, chat), needed);
    if (missing !== 0n) return sendError(reply, 403, 'missing_permission', { permission: permissionNames(missing) });
    const checked = checkOptions(leaf.options, body.options, chat, request.userId);
    if (isProblem(checked)) return sendError(reply, 400, 'validation_failed', { field: checked.field, reason: checked.reason });

    if (!connectionManager.hasLiveConnection(bot.id)) return sendError(reply, 409, 'bot_unavailable');

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
      options: JSON.stringify(checked.options),
      createdAt: now,
      expiresAt,
    }).run();

    const interaction: BotInteraction = {
      id,
      command: definition.name,
      ...(leaf.path.length > 0 ? { subcommand: leaf.path } : {}),
      options: checked.options,
      ...(checked.resolved ? { resolved: checked.resolved } : {}),
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

    const body: RespondToInteractionRequest = request.body ?? {};
    // An answer only the invoker sees is text only, checked here (it skips the message route).
    const ephemeral = body.ephemeral === true;
    if (body.ephemeral !== undefined && typeof body.ephemeral !== 'boolean') {
      return sendError(reply, 400, 'validation_failed', { field: 'ephemeral', reason: 'must be a boolean' });
    }
    if (ephemeral) {
      if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 0)) {
        return sendError(reply, 400, 'validation_failed', { field: 'attachments', reason: 'not allowed in an ephemeral answer' });
      }
      if (typeof body.content !== 'string' || body.content.trim().length === 0) return sendError(reply, 400, 'message_empty');
      if (body.content.length > MAX_MESSAGE_LENGTH) return sendError(reply, 400, 'content_too_long', { max: MAX_MESSAGE_LENGTH });
    }

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

    if (ephemeral) {
      // Not stored anywhere: it goes to the invoker's open sessions and nowhere else.
      const bot = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
      const spaceId = row.channelId !== null ? getChannelSpaceId(row.channelId) : null;
      const answer: EphemeralReply = {
        id: randomBytes(12).toString('hex'),
        interactionId: row.id,
        command: row.command,
        user: sanitizeUser(bot!),
        content: body.content as string,
        createdAt: now,
        ...(row.channelId !== null
          ? { channelId: row.channelId, ...(spaceId ? { spaceId } : {}) }
          : { dmChannelId: row.dmChannelId as string }),
      };
      connectionManager.sendToUser(row.userId, { type: 'interaction_ephemeral', reply: answer });
      return reply.code(201).send(answer);
    }

    // The real message route: same permissions, limits, attachments, embeds and broadcast.
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
