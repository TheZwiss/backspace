import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type {
  BotCommand,
  BotCommandChoice,
  BotCommandOption,
  BotCommandOptionType,
  BotCommandsResponse,
  SetBotCommandsRequest,
} from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { requireBot } from '../utils/botAuth.js';
import { sendError } from '../utils/httpErrors.js';
import { generateSnowflake } from '../utils/snowflake.js';

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const DESCRIPTION_MAX = 100;
const MAX_COMMANDS = 100;
const MAX_OPTIONS = 10;
const MAX_CHOICES = 25;
const OPTION_TYPES: readonly BotCommandOptionType[] = ['string', 'integer', 'number', 'boolean'];

interface Problem { field: string; reason: string }
interface NormalizedCommand { name: string; description: string; options: BotCommandOption[] }

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

function validateOptions(raw: unknown, path: string): BotCommandOption[] | Problem {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return { field: path, reason: 'must be an array' };
  if (raw.length > MAX_OPTIONS) return { field: path, reason: `at most ${MAX_OPTIONS} options` };

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
    if (item.required !== undefined && typeof item.required !== 'boolean') {
      return { field: `${here}.required`, reason: 'must be a boolean' };
    }
    const required = item.required === true;
    if (!required) sawOptional = true;
    else if (sawOptional) return { field: `${here}.required`, reason: 'required options must come before optional ones' };

    const option: BotCommandOption = { name: item.name, description, type, required };
    if (item.choices !== undefined) {
      if (type === 'boolean') return { field: `${here}.choices`, reason: 'not allowed for a boolean option' };
      if (!Array.isArray(item.choices)) return { field: `${here}.choices`, reason: 'must be an array' };
      if (item.choices.length < 1 || item.choices.length > MAX_CHOICES) {
        return { field: `${here}.choices`, reason: `must hold 1 to ${MAX_CHOICES} choices` };
      }
      const values = new Set<string | number>();
      const choices: BotCommandChoice[] = [];
      for (let c = 0; c < item.choices.length; c++) {
        const choice = validateChoice(item.choices[c], type, `${here}.choices[${c}]`);
        if (isProblem(choice)) return choice;
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
    out.push({ name: item.name, description, options });
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
            .set({ description: command.description, options, updatedAt: now })
            .where(eq(schema.botCommands.id, row.id))
            .run();
        } else {
          tx.insert(schema.botCommands)
            .values({ id: generateSnowflake(), botId, name: command.name, description: command.description, options, updatedAt: now })
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
