import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { NotificationLevel, NotificationSetting, NotificationTargetType, UpdateNotificationSettingRequest } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { getChannelSpaceId, isMember } from '../utils/permissions.js';
import { sendError } from '../utils/httpErrors.js';
import { connectionManager } from '../ws/handler.js';

/**
 * Per-user notification settings for spaces and channels on this instance
 * (docs/systems/api.md, "Notification settings"). The client applies them when
 * deciding whether a message alerts; the server only stores and syncs them.
 */

const LEVELS: readonly NotificationLevel[] = ['all', 'mentions', 'nothing'];
const TARGET_TYPES: readonly NotificationTargetType[] = ['space', 'channel'];

type Row = typeof schema.notificationSettings.$inferSelect;

export function notificationRowToSetting(row: Row): NotificationSetting {
  return {
    targetType: row.targetType as NotificationTargetType,
    targetId: row.targetId,
    level: row.level as NotificationLevel | null,
    mutedUntil: row.mutedUntil,
    suppressEveryone: row.suppressEveryone === 1,
    suppressRoles: row.suppressRoles === 1,
  };
}

/** Every setting the user holds on this instance; part of the ready payload. */
export function listNotificationSettings(userId: string): NotificationSetting[] {
  return getDb().select().from(schema.notificationSettings)
    .where(eq(schema.notificationSettings.userId, userId))
    .all()
    .map(notificationRowToSetting);
}

/** The space a target belongs to, or null when the target does not exist. */
function targetSpaceId(targetType: NotificationTargetType, targetId: string): string | null {
  if (targetType === 'channel') return getChannelSpaceId(targetId);
  const space = getDb().select({ id: schema.spaces.id }).from(schema.spaces)
    .where(eq(schema.spaces.id, targetId)).get();
  return space?.id ?? null;
}

/** Returns the field that fails validation, or null when the body is valid. */
function invalidField(body: UpdateNotificationSettingRequest | undefined): string | null {
  if (!body || typeof body !== 'object') return 'body';
  if (body.level !== null && !LEVELS.includes(body.level)) return 'level';
  if (body.mutedUntil !== null && (!Number.isSafeInteger(body.mutedUntil) || body.mutedUntil <= 0)) return 'mutedUntil';
  if (typeof body.suppressEveryone !== 'boolean') return 'suppressEveryone';
  if (typeof body.suppressRoles !== 'boolean') return 'suppressRoles';
  return null;
}

export async function notificationSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users/@me/notification-settings', { preHandler: authenticate }, async (request) => {
    return listNotificationSettings(request.userId);
  });

  // PUT /api/users/@me/notification-settings/:targetType/:targetId — replace one setting
  app.put<{ Params: { targetType: string; targetId: string }; Body: UpdateNotificationSettingRequest }>(
    '/api/users/@me/notification-settings/:targetType/:targetId',
    { preHandler: authenticate },
    async (request, reply) => {
      const { targetType, targetId } = request.params;
      if (!TARGET_TYPES.includes(targetType as NotificationTargetType)) {
        return sendError(reply, 400, 'validation_failed', { field: 'targetType', reason: 'must be space or channel' });
      }
      const type = targetType as NotificationTargetType;
      const bad = invalidField(request.body);
      if (bad) {
        return sendError(reply, 400, 'validation_failed', { field: bad, reason: 'invalid value' });
      }

      // Suppression is space-scoped; reject channel filters rather than silently discarding them.
      if (type === 'channel' && (request.body.suppressEveryone || request.body.suppressRoles)) {
        return sendError(reply, 400, 'validation_failed', { field: 'suppressEveryone/suppressRoles', reason: 'filters are space-only' });
      }

      const spaceId = targetSpaceId(type, targetId);
      if (!spaceId) {
        return sendError(reply, 404, type === 'space' ? 'space_not_found' : 'channel_not_found');
      }
      if (!isMember(spaceId, request.userId)) {
        return sendError(reply, 403, 'not_space_member');
      }

      const body = request.body;
      // Mention filters are a space-wide choice; a channel row never carries them.
      const values = {
        level: body.level,
        mutedUntil: body.mutedUntil,
        suppressEveryone: type === 'space' && body.suppressEveryone ? 1 : 0,
        suppressRoles: type === 'space' && body.suppressRoles ? 1 : 0,
        updatedAt: Date.now(),
      };
      const db = getDb();
      db.insert(schema.notificationSettings)
        .values({ userId: request.userId, targetType: type, targetId, ...values })
        .onConflictDoUpdate({
          target: [schema.notificationSettings.userId, schema.notificationSettings.targetType, schema.notificationSettings.targetId],
          set: values,
        })
        .run();

      const row = db.select().from(schema.notificationSettings)
        .where(and(
          eq(schema.notificationSettings.userId, request.userId),
          eq(schema.notificationSettings.targetType, type),
          eq(schema.notificationSettings.targetId, targetId),
        ))
        .get();
      if (!row) {
        return sendError(reply, 500, 'internal_error');
      }
      const setting = notificationRowToSetting(row);

      // Multi-device sync: every session of this user applies the new setting.
      connectionManager.sendToUser(request.userId, { type: 'notification_setting_updated', setting });
      return reply.code(200).send(setting);
    },
  );
}
