import type { Activity, BotActivity, BotActivityType } from '@backspace/shared';
import { ACTIVITY_LIMITS } from '@backspace/shared/src/activities.js';
import { BOT_ACTIVITY_TYPES } from '@backspace/shared/src/constants.js';

/**
 * A bot's stored status (`users.bot_activity`): the owner sets it in Settings >
 * Bots, the bot shows it as its live activity while connected. Pure helpers,
 * free of the connection manager, so routes, the WS handler and the federation
 * receivers can all import them.
 */

const BOT_ACTIVITY_TYPE_SET: ReadonlySet<string> = new Set(BOT_ACTIVITY_TYPES);

/** Longest status text, after trim: the same limit as any activity name. */
export const BOT_ACTIVITY_NAME_MAX_LENGTH = ACTIVITY_LIMITS.MAX_NAME_LENGTH;

/**
 * A `BotActivity` from untrusted input (an owner's request, a peer's payload,
 * the stored column), with the text trimmed. Null when anything is malformed:
 * an unknown type, a text that is not a string, empty after trim, or too long.
 */
export function normalizeBotActivity(raw: unknown): BotActivity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { type, name } = raw as Record<string, unknown>;
  if (typeof type !== 'string' || !BOT_ACTIVITY_TYPE_SET.has(type)) return null;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > BOT_ACTIVITY_NAME_MAX_LENGTH) return null;
  return { type: type as BotActivityType, name: trimmed };
}

/** The stored column as a `BotActivity`; null for none, or for a value that does not validate. */
export function parseStoredBotActivity(column: string | null | undefined): BotActivity | null {
  if (!column) return null;
  try {
    return normalizeBotActivity(JSON.parse(column));
  } catch {
    return null;
  }
}

/** The column value for a status: JSON with exactly `type` and `name`, or null. */
export function serializeBotActivity(activity: BotActivity | null): string | null {
  return activity ? JSON.stringify({ type: activity.type, name: activity.name }) : null;
}

/** The live activity list a stored status stands for: one activity, or none. */
export function botActivityAsLive(activity: BotActivity | null): Activity[] {
  return activity ? [{ type: activity.type, name: activity.name }] : [];
}
