import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, count, desc, eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { PermissionBits } from '@backspace/shared/src/permissions.js';
import { DEFAULT_SOUNDBOARD_SETTINGS, MAX_SOUNDBOARD_BYTES, MAX_SOUNDBOARD_SOUNDS, soundboardWavDuration, type SoundboardSettings } from '@backspace/shared/src/soundboard.js';
import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';
import { authenticate } from '../utils/auth.js';
import { hasPermission, isMember } from '../utils/permissions.js';
import { sendError } from '../utils/httpErrors.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { createFixedWindowLimit } from '../utils/fixedWindowLimit.js';
import { connectionManager } from '../ws/handler.js';

const uploads = createFixedWindowLimit({ max: 10, windowMs: 60_000 });
const plays = createFixedWindowLimit({ max: 1, windowMs: 2000 });
export function _resetSoundboardLimits(): void { uploads.reset(); plays.reset(); }
type Params = { spaceId: string; soundId: string };

function settingsFor(spaceId: string): SoundboardSettings {
  return getDb().select().from(schema.soundboardSettings).where(eq(schema.soundboardSettings.spaceId, spaceId)).get()
    ?? { ...DEFAULT_SOUNDBOARD_SETTINGS };
}

function memberGate(userId: string, spaceId: string, reply: FastifyReply): boolean {
  if (isMember(spaceId, userId)) return true;
  sendError(reply, 403, 'not_space_member');
  return false;
}

export async function soundboardRoutes(app: FastifyInstance): Promise<void> {
  const root = '/api/spaces/:spaceId/soundboard';
  app.get<{ Params: Params }>(root, { preHandler: authenticate }, async (request, reply) => {
    const { spaceId } = request.params;
    if (!memberGate(request.userId, spaceId, reply)) return;
    return { settings: settingsFor(spaceId), sounds: getDb().select().from(schema.soundboardSounds)
      .where(eq(schema.soundboardSounds.spaceId, spaceId)).orderBy(desc(schema.soundboardSounds.createdAt)).all() };
  });

  app.patch<{ Params: Params; Body: SoundboardSettings }>(`${root}/settings`, {
    preHandler: authenticate,
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['enabled', 'allowMemberUploads', 'maxDurationSeconds', 'maxSounds'], properties: {
        enabled: { type: 'boolean' }, allowMemberUploads: { type: 'boolean' },
        maxDurationSeconds: { type: ['number', 'null'], minimum: 0.1, maximum: 86400 },
        maxSounds: { type: 'integer', minimum: 1, maximum: MAX_SOUNDBOARD_SOUNDS },
      } } },
  }, async (request, reply) => {
    const { spaceId } = request.params;
    if (!memberGate(request.userId, spaceId, reply)) return;
    if (!hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE)) return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_SPACE' });
    getDb().insert(schema.soundboardSettings).values({ spaceId, ...request.body }).onConflictDoUpdate({
      target: schema.soundboardSettings.spaceId, set: request.body,
    }).run();
    connectionManager.sendToSpace(spaceId, { type: 'soundboard_updated', spaceId });
    return settingsFor(spaceId);
  });

  app.post<{ Params: Params; Body: { name: string; emoji: string; audio: string } }>(root, {
    preHandler: authenticate,
    bodyLimit: Math.ceil(MAX_SOUNDBOARD_BYTES / 3) * 4 + 4096,
    schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'emoji', 'audio'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 48 }, emoji: { type: 'string', minLength: 1, maxLength: 16 },
      audio: { type: 'string', minLength: 4, maxLength: Math.ceil(MAX_SOUNDBOARD_BYTES / 3) * 4 },
    } } },
  }, async (request, reply) => {
    const { spaceId } = request.params;
    if (!memberGate(request.userId, spaceId, reply)) return;
    const settings = settingsFor(spaceId);
    const manager = hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE);
    if ((!settings.allowMemberUploads && !manager) || (!manager && !hasPermission(request.userId, spaceId, PermissionBits.ATTACH_FILES))) {
      return sendError(reply, 403, 'missing_permission', { permission: settings.allowMemberUploads ? 'ATTACH_FILES' : 'MANAGE_SPACE' });
    }
    if (!settings.enabled) return sendError(reply, 403, 'soundboard_disabled');
    if (!uploads.consume(request.userId)) return sendError(reply, 429, 'rate_limited');
    const { name, emoji, audio } = request.body;
    if (!name.trim() || !emoji.trim() || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) return sendError(reply, 400, 'validation_failed');
    const bytes = Buffer.from(audio, 'base64');
    const sizeLimit = Math.min(MAX_SOUNDBOARD_BYTES, getDb().select().from(schema.instanceSettings).get()?.maxUploadSizeBytes ?? config.maxUploadSize);
    const durationSeconds = soundboardWavDuration(bytes);
    if (bytes.length > sizeLimit || bytes.toString('base64') !== audio || durationSeconds === null || durationSeconds < 0.1) {
      return sendError(reply, 400, 'soundboard_invalid_audio');
    }
    if (settings.maxDurationSeconds !== null && durationSeconds > settings.maxDurationSeconds + 1 / 48000) {
      return sendError(reply, 400, 'soundboard_duration_limit', { max: settings.maxDurationSeconds });
    }
    const total = getDb().select({ total: count() }).from(schema.soundboardSounds).where(eq(schema.soundboardSounds.spaceId, spaceId)).get()!.total;
    if (total >= settings.maxSounds) return sendError(reply, 409, 'soundboard_full', { max: settings.maxSounds });
    const id = generateSnowflake();
    const sound = { id, spaceId, uploaderId: request.userId, name: name.trim(), emoji: emoji.trim(), filename: `${id}.wav`, durationSeconds, createdAt: Date.now() };
    const filename = path.join(config.uploadDir, sound.filename);
    mkdirSync(config.uploadDir, { recursive: true });
    // No asynchronous gap: quota, file publication and reference cannot race the janitor or another upload.
    let fileCreated = false;
    try {
      getDb().transaction(tx => {
        writeFileSync(filename, bytes, { flag: 'wx' });
        fileCreated = true;
        tx.insert(schema.soundboardSounds).values(sound).run();
      });
    } catch (error) {
      if (fileCreated) { try { unlinkSync(filename); } catch { /* Preserve the original storage error. */ } }
      throw error;
    }
    connectionManager.sendToSpace(spaceId, { type: 'soundboard_updated', spaceId });
    return reply.code(201).send(sound);
  });

  app.delete<{ Params: Params }>(`${root}/:soundId`, { preHandler: authenticate }, async (request, reply) => {
    const { spaceId, soundId } = request.params;
    if (!memberGate(request.userId, spaceId, reply)) return;
    const where = and(eq(schema.soundboardSounds.id, soundId), eq(schema.soundboardSounds.spaceId, spaceId));
    const sound = getDb().select().from(schema.soundboardSounds).where(where).get();
    if (!sound) return sendError(reply, 404, 'soundboard_not_found');
    if (sound.uploaderId !== request.userId && !hasPermission(request.userId, spaceId, PermissionBits.MANAGE_SPACE)) return sendError(reply, 403, 'missing_permission', { permission: 'MANAGE_SPACE' });
    getDb().delete(schema.soundboardSounds).where(where).run();
    // Unreferenced files are reclaimed by the existing storage janitor, including space/account cascades.
    connectionManager.sendToSpace(spaceId, { type: 'soundboard_updated', spaceId });
    return { success: true };
  });

  app.post<{ Params: Params; Body: { channelId: string } }>(`${root}/:soundId/play`, {
    preHandler: authenticate,
    schema: { body: { type: 'object', required: ['channelId'], additionalProperties: false, properties: { channelId: { type: 'string', minLength: 1 } } } },
  }, async (request, reply) => {
    const { spaceId, soundId } = request.params;
    const { channelId } = request.body;
    if (!memberGate(request.userId, spaceId, reply)) return;
    const channel = getDb().select().from(schema.channels).where(eq(schema.channels.id, channelId)).get();
    const session = connectionManager.getUserRoom(request.userId);
    if (!channel || channel.spaceId !== spaceId || channel.type !== 'voice' || session?.roomId !== channelId
      || !connectionManager.getVoiceWs(request.userId) || !hasPermission(request.userId, spaceId, PermissionBits.VIEW_CHANNEL, channelId)
      || !hasPermission(request.userId, spaceId, PermissionBits.CONNECT, channelId) || !hasPermission(request.userId, spaceId, PermissionBits.SPEAK, channelId)
      || connectionManager.isSpaceMuted(spaceId, request.userId) || connectionManager.isPermissionMuted(spaceId, request.userId)
      || connectionManager.isSpaceDeafened(spaceId, request.userId) || connectionManager.getVoiceUserStatus(request.userId)?.isDeafened) {
      return sendError(reply, 403, 'forbidden');
    }
    const settings = settingsFor(spaceId);
    if (!settings.enabled) return sendError(reply, 403, 'soundboard_disabled');
    const sound = getDb().select().from(schema.soundboardSounds).where(and(eq(schema.soundboardSounds.id, soundId), eq(schema.soundboardSounds.spaceId, spaceId))).get();
    if (!sound) return sendError(reply, 404, 'soundboard_not_found');
    if (settings.maxDurationSeconds !== null && sound.durationSeconds > settings.maxDurationSeconds) return sendError(reply, 400, 'soundboard_duration_limit', { max: settings.maxDurationSeconds });
    if (!plays.consume(`user:${request.userId}`)) return sendError(reply, 429, 'rate_limited');
    if (!plays.consume(`room:${channelId}`)) return sendError(reply, 429, 'rate_limited');
    const payload = JSON.stringify({ type: 'soundboard_play', channelId, spaceId, sound });
    for (const uid of connectionManager.getRoomParticipants(channelId)) {
      if (!isMember(spaceId, uid) || !hasPermission(uid, spaceId, PermissionBits.VIEW_CHANNEL, channelId)
        || connectionManager.isSpaceDeafened(spaceId, uid) || connectionManager.getVoiceUserStatus(uid)?.isDeafened) continue;
      const ws = connectionManager.getVoiceWs(uid);
      if (ws?.readyState === 1) ws.send(payload);
    }
    return { success: true };
  });
}
