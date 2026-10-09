import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import {
  isMuteActive,
  isNotificationLevel,
  isNotificationMuteDuration,
  NOTIFICATION_MUTE_DURATION_MS,
  type NotificationLevel,
  type NotificationMuteDuration,
  type NotificationSetting,
  type NotificationSettingsResponse,
  type UpdateNotificationSettingRequest,
} from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { computePermissions, isMember, PermissionBits } from '../utils/permissions.js';
import { sendError } from '../utils/httpErrors.js';
import { connectionManager } from '../ws/handler.js';

/**
 * Per-space and per-channel notification settings of the signed-in user.
 *
 * Stored on the instance that hosts the space, keyed by the caller's row on
 * this instance. A federated member reaches these routes with their account
 * here (the client routes by the space's origin), so `request.userId` is
 * already the right identity; no global user id is assumed.
 *
 * Every change is pushed to the user's other sessions on this instance as
 * `notification_settings_updated`. See docs/systems/api.md and
 * docs/systems/sounds.md ("Notification settings").
 */

type SettingRow = typeof schema.notificationSettings.$inferSelect;

/** What a PATCH leaves the row as, before it is stored or deleted. */
interface SettingState {
  suppressEveryone: boolean;
  suppressRoles: boolean;
  level: NotificationLevel | null;
  muted: boolean;
  mutedUntil: number | null;
}

export function rowToNotificationSetting(row: SettingRow): NotificationSetting {
  return {
    suppressEveryone: row.suppressEveryone === 1,
    suppressRoles: row.suppressRoles === 1,
    spaceId: row.spaceId,
    channelId: row.channelId ?? null,
    level: isNotificationLevel(row.level) ? row.level : null,
    muted: row.muted === 1,
    mutedUntil: row.muted === 1 ? row.mutedUntil ?? null : null,
    updatedAt: row.updatedAt,
  };
}

type SettingChange = {
  level: NotificationLevel | null | undefined;
  mute: NotificationMuteDuration | null | undefined;
  suppressEveryone?: boolean;
  suppressRoles?: boolean;
};

type ParsedBody =
  | ({ ok: true } & SettingChange)
  | { ok: false };

/** Validates a PATCH body. At least one known field, each of the right shape. */
export function parseUpdateBody(body: unknown, isChannel = false): ParsedBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };
  const input = body as Record<string, unknown>;
  const validators = {
    level: (value: unknown) => value === null || isNotificationLevel(value),
    mute: (value: unknown) => value === null || isNotificationMuteDuration(value),
    suppressEveryone: (value: unknown) => typeof value === 'boolean',
    suppressRoles: (value: unknown) => typeof value === 'boolean',
  };
  const fields = (Object.keys(validators) as (keyof typeof validators)[])
    .filter(field => Object.prototype.hasOwnProperty.call(input, field));
  if (fields.length === 0) return { ok: false };
  for (const field of fields) {
    // Suppression belongs to the space and cannot be bypassed by a channel override.
    if (isChannel && field.startsWith('suppress')) return { ok: false };
    if (!validators[field](input[field])) return { ok: false };
  }
  return {
    ok: true,
    level: input.level as NotificationLevel | null | undefined,
    mute: input.mute as NotificationMuteDuration | null | undefined,
    suppressEveryone: input.suppressEveryone as boolean | undefined,
    suppressRoles: input.suppressRoles as boolean | undefined,
  };
}

/**
 * The state after applying a change to the stored one. A mute that already
 * ended is read as no mute, so it never survives into the new row.
 */
export function applyUpdate(
  existing: SettingRow | undefined,
  change: SettingChange,
  now: number,
): SettingState {
  const stored = existing ? rowToNotificationSetting(existing) : null;
  const level = change.level !== undefined ? change.level : stored?.level ?? null;

  let muted = isMuteActive(stored, now);
  let mutedUntil = muted ? stored?.mutedUntil ?? null : null;
  if (change.mute === null) {
    muted = false;
    mutedUntil = null;
  } else if (change.mute !== undefined) {
    muted = true;
    mutedUntil = change.mute === 'indefinite' ? null : now + NOTIFICATION_MUTE_DURATION_MS[change.mute];
  }

  return {
    level, muted, mutedUntil,
    suppressEveryone: change.suppressEveryone ?? stored?.suppressEveryone ?? false,
    suppressRoles: change.suppressRoles ?? stored?.suppressRoles ?? false,
  };
}

function findRow(userId: string, spaceId: string, channelId: string | null): SettingRow | undefined {
  const db = getDb();
  const t = schema.notificationSettings;
  return db.select().from(t)
    .where(channelId === null
      ? and(eq(t.userId, userId), eq(t.spaceId, spaceId), isNull(t.channelId))
      : and(eq(t.userId, userId), eq(t.channelId, channelId)))
    .get();
}

/**
 * Writes the new state for one target and returns what the client is sent.
 * A state with nothing chosen deletes the row; the returned setting then
 * carries level null, not muted and no suppression, so other sessions learn to
 * drop theirs.
 */
function storeSetting(
  userId: string,
  spaceId: string,
  channelId: string | null,
  change: SettingChange,
): NotificationSetting {
  const db = getDb();
  const t = schema.notificationSettings;
  return db.transaction(() => {
    const existing = findRow(userId, spaceId, channelId);
    const now = Date.now();
    const next = applyUpdate(existing, change, now);
    // Strictly after the stored write, so a client's last-write-wins merge
    // never ties two different states on one timestamp.
    const updatedAt = Math.max(now, (existing?.updatedAt ?? 0) + 1);

    if (next.level === null && !next.muted && !next.suppressEveryone && !next.suppressRoles) {
      if (existing) {
        db.delete(t)
          .where(channelId === null
            ? and(eq(t.userId, userId), eq(t.spaceId, spaceId), isNull(t.channelId))
            : and(eq(t.userId, userId), eq(t.channelId, channelId)))
          .run();
      }
      return { spaceId, channelId, ...next, updatedAt };
    }

    const values = {
      suppressEveryone: next.suppressEveryone ? 1 : 0,
      suppressRoles: next.suppressRoles ? 1 : 0,
      level: next.level,
      muted: next.muted ? 1 : 0,
      mutedUntil: next.mutedUntil,
      updatedAt,
    };
    if (existing) {
      db.update(t)
        .set(values)
        .where(channelId === null
          ? and(eq(t.userId, userId), eq(t.spaceId, spaceId), isNull(t.channelId))
          : and(eq(t.userId, userId), eq(t.channelId, channelId)))
        .run();
    } else {
      db.insert(t).values({ userId, spaceId, channelId, ...values }).run();
    }
    return { spaceId, channelId, ...next, updatedAt };
  });
}

function canViewChannel(userId: string, spaceId: string, channelId: string): boolean {
  const perms = computePermissions(userId, spaceId, channelId);
  return (perms & PermissionBits.VIEW_CHANNEL) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
}

function respondWithSetting(reply: FastifyReply, userId: string, setting: NotificationSetting): FastifyReply {
  connectionManager.sendToUser(userId, { type: 'notification_settings_updated', setting });
  return reply.code(200).send(setting);
}

export async function notificationSettingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/users/@me/notification-settings: every stored setting of the
  // caller on this instance, limited to spaces they are a member of and to
  // channels they can still see.
  app.get('/api/users/@me/notification-settings', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();
    const rows = db.select().from(schema.notificationSettings)
      .where(eq(schema.notificationSettings.userId, request.userId))
      .all();

    const memberOf = new Map<string, boolean>();
    const settings: NotificationSetting[] = [];
    for (const row of rows) {
      let member = memberOf.get(row.spaceId);
      if (member === undefined) {
        member = isMember(row.spaceId, request.userId);
        memberOf.set(row.spaceId, member);
      }
      if (!member) continue;
      if (row.channelId !== null && !canViewChannel(request.userId, row.spaceId, row.channelId)) continue;
      settings.push(rowToNotificationSetting(row));
    }

    const body: NotificationSettingsResponse = { settings };
    return reply.code(200).send(body);
  });

  // PATCH /api/spaces/:spaceId/notification-settings: the space-wide setting.
  app.patch<{ Params: { spaceId: string }; Body: UpdateNotificationSettingRequest }>(
    '/api/spaces/:spaceId/notification-settings',
    { preHandler: authenticate },
    async (request, reply) => {
      const { spaceId } = request.params;
      const parsed = parseUpdateBody(request.body);
      if (!parsed.ok) return sendError(reply, 400, 'validation_failed');

      const db = getDb();
      const space = db.select({ id: schema.spaces.id }).from(schema.spaces)
        .where(eq(schema.spaces.id, spaceId)).get();
      if (!space) return sendError(reply, 404, 'space_not_found');
      if (!isMember(spaceId, request.userId)) return sendError(reply, 403, 'not_space_member');

      const setting = storeSetting(request.userId, spaceId, null, parsed);
      return respondWithSetting(reply, request.userId, setting);
    },
  );

  // PATCH /api/channels/:channelId/notification-settings: one channel's setting.
  app.patch<{ Params: { channelId: string }; Body: UpdateNotificationSettingRequest }>(
    '/api/channels/:channelId/notification-settings',
    { preHandler: authenticate },
    async (request, reply) => {
      const { channelId } = request.params;
      const parsed = parseUpdateBody(request.body, true);
      if (!parsed.ok) return sendError(reply, 400, 'validation_failed');

      const db = getDb();
      const channel = db.select({ id: schema.channels.id, spaceId: schema.channels.spaceId })
        .from(schema.channels)
        .where(eq(schema.channels.id, channelId))
        .get();
      if (!channel) return sendError(reply, 404, 'channel_not_found');
      if (!isMember(channel.spaceId, request.userId)) return sendError(reply, 403, 'not_space_member');
      // Refused as the message routes refuse a channel the caller cannot see.
      if (!canViewChannel(request.userId, channel.spaceId, channelId)) {
        return sendError(reply, 403, 'missing_permission', { permission: 'VIEW_CHANNEL' });
      }

      const setting = storeSetting(request.userId, channel.spaceId, channelId, parsed);
      return respondWithSetting(reply, request.userId, setting);
    },
  );
}
