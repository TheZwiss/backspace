import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type {
  BotCommand,
  BotCommandChoice,
  BotCommandOption,
  BotCommandOptionType,
  BotCommandValueType,
  BotCommandsResponse,
  ChannelType,
  SetBotCommandsRequest,
} from '@backspace/shared';
import { COMMAND_STRING_OPTION_MAX } from '@backspace/shared/src/constants.js';
import { ALL_PERMISSIONS, PermissionBits, parsePermissionString, permissionsToString } from '@backspace/shared/src/permissions.js';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { requireBot } from '../utils/botAuth.js';
import { sendError } from '../utils/httpErrors.js';
import { generateSnowflake } from '../utils/snowflake.js';

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const DESCRIPTION_MAX = 100;
const MAX_COMMANDS = 100;
const MAX_OPTIONS = 10;
const MAX_SUBCOMMANDS = 25;
const MAX_CHOICES = 25;
const VALUE_TYPES: readonly BotCommandValueType[] = ['string', 'integer', 'number', 'boolean', 'user', 'channel', 'role'];
/** The steps of a command's path: a subcommand holds value options, a group holds subcommands. */
const STEP_TYPES: readonly BotCommandOptionType[] = ['subcommand', 'subcommand_group'];
const OPTION_TYPES: readonly BotCommandOptionType[] = [...VALUE_TYPES, ...STEP_TYPES];
const CHANNEL_TYPES: readonly ChannelType[] = ['text', 'voice'];
/** The option types that may list choices. */
const CHOICE_TYPES: ReadonlySet<BotCommandOptionType> = new Set(['string', 'integer', 'number']);

interface Problem { field: string; reason: string }
interface NormalizedCommand { name: string; description: string; options: BotCommandOption[]; requiredPermissions: string | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProblem(value: unknown): value is Problem {
  return isRecord(value) && typeof value.field === 'string' && typeof value.reason === 'string';
}

function text(raw: unknown, field: string): string | Problem {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length < 1 || value.length > DESCRIPTION_MAX) {
    return { field, reason: `must be 1 to ${DESCRIPTION_MAX} characters` };
  }
  return value;
}

/**
 * The permissions a command or a step asks of the people who use it: a
 * canonical decimal mask or a list of permission names, stored as the mask.
 * Null for none (absent, `"0"` or an empty list).
 */
function validatePermissions(raw: unknown, field: string): string | null | Problem {
  if (raw === undefined || raw === null) return null;
  let bits = 0n;
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const name = raw[i];
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PermissionBits, name)) {
        return { field: `${field}[${i}]`, reason: 'must be a permission name' };
      }
      bits |= PermissionBits[name as keyof typeof PermissionBits];
    }
  } else {
    const parsed = parsePermissionString(raw);
    if (parsed === null) return { field, reason: 'must be a decimal permission mask or a list of permission names' };
    if ((parsed & ~ALL_PERMISSIONS) !== 0n) return { field, reason: 'names a permission that does not exist' };
    bits = parsed;
  }
  return bits === 0n ? null : permissionsToString(bits);
}

function validateChoice(raw: unknown, type: BotCommandOptionType, path: string): BotCommandChoice | Problem {
  if (!isRecord(raw)) return { field: path, reason: 'must be an object' };
  const name = text(raw.name, `${path}.name`);
  if (isProblem(name)) return name;
  const value = raw.value;
  if (type === 'string') {
    if (typeof value !== 'string' || value.length < 1 || value.length > DESCRIPTION_MAX) {
      return { field: `${path}.value`, reason: `must be a string of 1 to ${DESCRIPTION_MAX} characters` };
    }
  } else if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      return { field: `${path}.value`, reason: 'must be a safe integer' };
    }
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { field: `${path}.value`, reason: 'must be a finite number' };
  }
  return { name, value: value as string | number };
}

type OptionBounds = Pick<BotCommandOption, 'minValue' | 'maxValue' | 'minLength' | 'maxLength' | 'channelTypes'>;

/**
 * The type-specific limits of an option: `minValue`/`maxValue` (integer and
 * number), `minLength`/`maxLength` (string) and `channelTypes` (channel). Each
 * is refused on another type; a pair must not cross.
 */
function validateBounds(item: Record<string, unknown>, type: BotCommandOptionType, here: string): OptionBounds | Problem {
  const out: OptionBounds = {};
  const numeric = type === 'integer' || type === 'number';
  for (const key of ['minValue', 'maxValue'] as const) {
    const value = item[key];
    if (value === undefined) continue;
    if (!numeric) return { field: `${here}.${key}`, reason: `not allowed for a ${type} option` };
    const ok = typeof value === 'number' && (type === 'integer' ? Number.isSafeInteger(value) : Number.isFinite(value));
    if (!ok) return { field: `${here}.${key}`, reason: type === 'integer' ? 'must be a safe integer' : 'must be a finite number' };
    out[key] = value as number;
  }
  if (out.minValue !== undefined && out.maxValue !== undefined && out.minValue > out.maxValue) {
    return { field: `${here}.minValue`, reason: 'must not be greater than maxValue' };
  }
  for (const key of ['minLength', 'maxLength'] as const) {
    const value = item[key];
    if (value === undefined) continue;
    if (type !== 'string') return { field: `${here}.${key}`, reason: `not allowed for a ${type} option` };
    const least = key === 'maxLength' ? 1 : 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < least || value > COMMAND_STRING_OPTION_MAX) {
      return { field: `${here}.${key}`, reason: `must be an integer from ${least} to ${COMMAND_STRING_OPTION_MAX}` };
    }
    out[key] = value;
  }
  if (out.minLength !== undefined && out.maxLength !== undefined && out.minLength > out.maxLength) {
    return { field: `${here}.minLength`, reason: 'must not be greater than maxLength' };
  }
  if (item.channelTypes !== undefined) {
    if (type !== 'channel') return { field: `${here}.channelTypes`, reason: `not allowed for a ${type} option` };
    const list = item.channelTypes;
    if (!Array.isArray(list) || list.length === 0 || list.some((t) => !CHANNEL_TYPES.includes(t as ChannelType))
      || new Set(list).size !== list.length) {
      return { field: `${here}.channelTypes`, reason: `must be a non-empty list of distinct ${CHANNEL_TYPES.join(', ')}` };
    }
    out.channelTypes = list as ChannelType[];
  }
  return out;
}

/** Why `value` breaks the option's own limits (range or length), or null when it does not. */
function outsideLimits(option: BotCommandOption, value: string | number): string | null {
  if (typeof value === 'number') {
    if (option.minValue !== undefined && value < option.minValue) return `must be at least minValue (${option.minValue})`;
    if (option.maxValue !== undefined && value > option.maxValue) return `must be at most maxValue (${option.maxValue})`;
    return null;
  }
  if (option.minLength !== undefined && value.length < option.minLength) return `must be at least minLength (${option.minLength}) characters`;
  if (option.maxLength !== undefined && value.length > option.maxLength) return `must be at most maxLength (${option.maxLength}) characters`;
  return null;
}

/**
 * Where a list of options sits: right under a command (values, or the steps of
 * a path), in a group (subcommands only) or in a subcommand (values only).
 */
type Level = 'command' | 'group' | 'subcommand';

function isStep(item: unknown): boolean {
  return isRecord(item) && STEP_TYPES.includes(item.type as BotCommandOptionType);
}

/**
 * A command's, a group's or a subcommand's options. A list holds either value
 * options (at most 10; required ones first) or the steps of a path (at most
 * 25 subcommands and groups), never both: a group holds subcommands, a
 * subcommand holds values, so a path is at most two words.
 */
function validateOptions(raw: unknown, path: string, level: Level = 'command'): BotCommandOption[] | Problem {
  if (raw === undefined) {
    return level === 'group' ? { field: path, reason: `must hold 1 to ${MAX_SUBCOMMANDS} subcommands` } : [];
  }
  if (!Array.isArray(raw)) return { field: path, reason: 'must be an array' };
  const steps = level === 'group' || (level === 'command' && raw.some(isStep));
  if (steps) {
    if (raw.length < (level === 'group' ? 1 : 0) || raw.length > MAX_SUBCOMMANDS) {
      return { field: path, reason: level === 'group' ? `must hold 1 to ${MAX_SUBCOMMANDS} subcommands` : `at most ${MAX_SUBCOMMANDS} subcommands and groups` };
    }
  } else if (raw.length > MAX_OPTIONS) {
    return { field: path, reason: `at most ${MAX_OPTIONS} options` };
  }

  const seen = new Set<string>();
  const out: BotCommandOption[] = [];
  let sawOptional = false;
  for (let i = 0; i < raw.length; i++) {
    const here = `${path}[${i}]`;
    const item: unknown = raw[i];
    if (!isRecord(item)) return { field: here, reason: 'must be an object' };
    if (typeof item.name !== 'string' || !NAME_RE.test(item.name)) {
      return { field: `${here}.name`, reason: 'must be 1 to 32 characters of a-z, 0-9, _ and -' };
    }
    if (seen.has(item.name)) return { field: `${here}.name`, reason: 'duplicate option name' };
    seen.add(item.name);
    const description = text(item.description, `${here}.description`);
    if (isProblem(description)) return description;
    if (!OPTION_TYPES.includes(item.type as BotCommandOptionType)) {
      return { field: `${here}.type`, reason: `must be one of ${OPTION_TYPES.join(', ')}` };
    }
    const type = item.type as BotCommandOptionType;
    if (level === 'group' && type !== 'subcommand') {
      return { field: `${here}.type`, reason: 'a group holds subcommands only' };
    }
    if (level === 'subcommand' && STEP_TYPES.includes(type)) {
      return { field: `${here}.type`, reason: 'a subcommand holds value options only' };
    }
    if (steps !== STEP_TYPES.includes(type)) {
      return { field: `${here}.type`, reason: 'subcommands and groups cannot sit beside value options' };
    }
    if (item.required !== undefined && typeof item.required !== 'boolean') {
      return { field: `${here}.required`, reason: 'must be a boolean' };
    }

    if (steps) {
      if (item.required === true) return { field: `${here}.required`, reason: `not allowed for a ${type}` };
      const needs = validatePermissions(item.requiredPermissions, `${here}.requiredPermissions`);
      if (isProblem(needs)) return needs;
      if (item.options !== undefined && !Array.isArray(item.options)) return { field: `${here}.options`, reason: 'must be an array' };
      for (const key of ['choices', 'strictChoices', 'minValue', 'maxValue', 'minLength', 'maxLength', 'channelTypes'] as const) {
        if (item[key] !== undefined) return { field: `${here}.${key}`, reason: `not allowed for a ${type}` };
      }
      const inner = validateOptions(item.options, `${here}.options`, type === 'subcommand' ? 'subcommand' : 'group');
      if (isProblem(inner)) return inner;
      out.push({ name: item.name, description, type, required: false, options: inner, ...(needs ? { requiredPermissions: needs } : {}) });
      continue;
    }

    if (item.options !== undefined) return { field: `${here}.options`, reason: `not allowed for a ${type} option` };
    if (item.requiredPermissions !== undefined) return { field: `${here}.requiredPermissions`, reason: `not allowed for a ${type} option` };
    const required = item.required === true;
    if (!required) sawOptional = true;
    else if (sawOptional) return { field: `${here}.required`, reason: 'required options must come before optional ones' };
    const option: BotCommandOption = { name: item.name, description, type, required };
    const bounds = validateBounds(item, type, here);
    if (isProblem(bounds)) return bounds;
    Object.assign(option, bounds);
    if (item.strictChoices !== undefined) {
      if (typeof item.strictChoices !== 'boolean') return { field: `${here}.strictChoices`, reason: 'must be a boolean' };
      if (item.choices === undefined) return { field: `${here}.strictChoices`, reason: 'needs choices' };
      if (item.strictChoices) option.strictChoices = true;
    }
    if (item.choices !== undefined) {
      if (!CHOICE_TYPES.has(type)) return { field: `${here}.choices`, reason: `not allowed for a ${type} option` };
      if (!Array.isArray(item.choices)) return { field: `${here}.choices`, reason: 'must be an array' };
      if (item.choices.length < 1 || item.choices.length > MAX_CHOICES) {
        return { field: `${here}.choices`, reason: `must hold 1 to ${MAX_CHOICES} choices` };
      }
      const values = new Set<string | number>();
      const choices: BotCommandChoice[] = [];
      for (let c = 0; c < item.choices.length; c++) {
        const choice = validateChoice(item.choices[c], type, `${here}.choices[${c}]`);
        if (isProblem(choice)) return choice;
        // A listed value must be one the option itself accepts.
        const outside = outsideLimits(option, choice.value);
        if (outside) return { field: `${here}.choices[${c}].value`, reason: outside };
        if (values.has(choice.value)) return { field: `${here}.choices[${c}].value`, reason: 'duplicate choice value' };
        values.add(choice.value);
        choices.push(choice);
      }
      option.choices = choices;
    }
    out.push(option);
  }
  return out;
}

function validateCommands(raw: unknown): NormalizedCommand[] | Problem {
  if (!Array.isArray(raw)) return { field: 'commands', reason: 'must be an array' };
  if (raw.length > MAX_COMMANDS) return { field: 'commands', reason: `at most ${MAX_COMMANDS} commands` };

  const seen = new Set<string>();
  const out: NormalizedCommand[] = [];
  for (let i = 0; i < raw.length; i++) {
    const here = `commands[${i}]`;
    const item: unknown = raw[i];
    if (!isRecord(item)) return { field: here, reason: 'must be an object' };
    if (typeof item.name !== 'string' || !NAME_RE.test(item.name)) {
      return { field: `${here}.name`, reason: 'must be 1 to 32 characters of a-z, 0-9, _ and -' };
    }
    if (seen.has(item.name)) return { field: `${here}.name`, reason: 'duplicate command name' };
    seen.add(item.name);
    const description = text(item.description, `${here}.description`);
    if (isProblem(description)) return description;
    const options = validateOptions(item.options, `${here}.options`);
    if (isProblem(options)) return options;
    const requiredPermissions = validatePermissions(item.requiredPermissions, `${here}.requiredPermissions`);
    if (isProblem(requiredPermissions)) return requiredPermissions;
    out.push({ name: item.name, description, options, requiredPermissions });
  }
  return out;
}

function commandsOf(botId: string): BotCommand[] {
  return getDb().select().from(schema.botCommands)
    .where(eq(schema.botCommands.botId, botId))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => ({
      id: row.id,
      botId: row.botId,
      name: row.name,
      description: row.description,
      options: JSON.parse(row.options) as BotCommandOption[],
      ...(row.requiredPermissions ? { requiredPermissions: row.requiredPermissions } : {}),
      updatedAt: row.updatedAt,
    }));
}

/**
 * A bot's own slash commands. The bot registers them with its token; the whole
 * list is replaced in one call (idempotent, and a command that keeps its name
 * keeps its id). Invoking a command is a separate step.
 */
export async function botCommandRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/bots/@me/commands', { preHandler: [authenticate, requireBot] }, async (request, reply) => {
    const response: BotCommandsResponse = { commands: commandsOf(request.userId) };
    return reply.send(response);
  });

  app.put<{ Body: SetBotCommandsRequest }>('/api/bots/@me/commands', {
    preHandler: [authenticate, requireBot],
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const parsed = validateCommands(request.body?.commands);
    if (isProblem(parsed)) return sendError(reply, 400, 'validation_failed', { field: parsed.field, reason: parsed.reason });

    const botId = request.userId;
    const now = Date.now();
    getDb().transaction((tx) => {
      const existing = tx.select().from(schema.botCommands).where(eq(schema.botCommands.botId, botId)).all();
      const byName = new Map(existing.map((row) => [row.name, row]));
      const keep = new Set<string>();
      for (const command of parsed) {
        keep.add(command.name);
        const options = JSON.stringify(command.options);
        const row = byName.get(command.name);
        if (row) {
          tx.update(schema.botCommands)
            .set({ description: command.description, options, requiredPermissions: command.requiredPermissions, updatedAt: now })
            .where(eq(schema.botCommands.id, row.id))
            .run();
        } else {
          tx.insert(schema.botCommands)
            .values({
              id: generateSnowflake(),
              botId,
              name: command.name,
              description: command.description,
              options,
              requiredPermissions: command.requiredPermissions,
              updatedAt: now,
            })
            .run();
        }
      }
      for (const row of existing) {
        if (!keep.has(row.name)) tx.delete(schema.botCommands).where(eq(schema.botCommands.id, row.id)).run();
      }
    });

    const response: BotCommandsResponse = { commands: commandsOf(botId) };
    return reply.send(response);
  });
}
