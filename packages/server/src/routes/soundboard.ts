import { getOurOrigin } from '../utils/federationAuth.js';
import type { FastifyInstance } from 'fastify';
import { and, count, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { hasPermission, PermissionBits } from '../utils/permissions.js';
import { sendError } from '../utils/httpErrors.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { validateSoundboardWav } from '../utils/soundboardAudio.js';
import { createFixedWindowLimit } from '../utils/fixedWindowLimit.js';
import { connectionManager } from '../ws/handler.js';
import { config } from '../config.js';

const uploadLimit = createFixedWindowLimit({ max: 10, windowMs: 60_000 });
const grants = new Map<string, { assetId: string; until: number }>();
export function _resetSoundboardLimits(): void { uploadLimit.reset(); grants.clear(); }
const member = (spaceId: string, userId: string) => getDb().select().from(schema.spaceMembers).where(and(eq(schema.spaceMembers.spaceId, spaceId), eq(schema.spaceMembers.userId, userId))).get();
const can = (spaceId: string, userId: string, permission: bigint) => hasPermission(userId, spaceId, permission);
const metadata = (spaceId: string) => getDb().select({ id: schema.soundboardSounds.id, spaceId: schema.soundboardSounds.spaceId,
  name: schema.soundboardSounds.name, assetId: schema.soundboardSounds.assetId, creatorId: schema.soundboardSounds.creatorId,
  durationMs: schema.soundboardAssets.durationMs, volume: schema.soundboardSounds.volume,
}).from(schema.soundboardSounds).innerJoin(schema.soundboardAssets, eq(schema.soundboardAssets.id, schema.soundboardSounds.assetId)).where(eq(schema.soundboardSounds.spaceId, spaceId)).all();

export async function soundboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/soundboard', { preHandler: authenticate }, async (request) => {
    const spaces = getDb().select({ id: schema.spaces.id, name: schema.spaces.name }).from(schema.spaces)
      .innerJoin(schema.spaceMembers, eq(schema.spaceMembers.spaceId, schema.spaces.id)).where(eq(schema.spaceMembers.userId, request.userId)).all();
    return spaces.map((space) => ({ spaceId: space.id, name: space.name,
      canCreate: can(space.id, request.userId, PermissionBits.CREATE_SOUNDBOARD),
      canManage: can(space.id, request.userId, PermissionBits.MANAGE_SOUNDBOARD), sounds: metadata(space.id) }));
  });
  app.post<{ Params: { spaceId: string }; Body: { name: string; audio: string; volume?: number } }>('/api/spaces/:spaceId/soundboard', {
    preHandler: authenticate, bodyLimit: 720_000,
    schema: { body: { type: 'object', required: ['name', 'audio'], additionalProperties: false, properties: {
      name: { type: 'string', minLength: 2, maxLength: 32 }, audio: { type: 'string', maxLength: 670000 }, volume: { type: 'number', minimum: 0, maximum: 1 },
    } } },
  }, async (request, reply) => {
    const { spaceId } = request.params;
    if (!member(spaceId, request.userId) || !can(spaceId, request.userId, PermissionBits.CREATE_SOUNDBOARD)) return sendError(reply, 403, 'forbidden');
    if (!uploadLimit.consume(request.userId)) return sendError(reply, 429, 'rate_limited');
    const name = request.body.name.trim();
    if (name.length < 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(request.body.audio)) return sendError(reply, 400, 'validation_failed');
    const bytes = Buffer.from(request.body.audio, 'base64');
    const durationMs = validateSoundboardWav(bytes);
    if (!durationMs || durationMs > 5200) return sendError(reply, 400, 'validation_failed');
    const assetId = createHash('sha256').update(bytes).digest('hex');
    const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
    const db = getDb();
    const id = db.transaction((tx) => {
      const used = tx.select({ n: count() }).from(schema.soundboardSounds).where(eq(schema.soundboardSounds.spaceId, spaceId)).get()!.n;
      if (used >= 40) return null;
      tx.insert(schema.soundboardAssets).values({ id: assetId, data: compressed, durationMs }).onConflictDoNothing().run();
      const id = generateSnowflake();
      tx.insert(schema.soundboardSounds).values({ id, spaceId, assetId, creatorId: request.userId, name, volume: request.body.volume ?? 1, createdAt: Date.now() }).run();
      return id;
    });
    if (!id) return sendError(reply, 409, 'soundboard_full');
    return reply.code(201).send(metadata(spaceId).find((sound) => sound.id === id));
  });
  app.delete<{ Params: { id: string } }>('/api/soundboard/:id', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();
    const sound = db.select().from(schema.soundboardSounds).where(eq(schema.soundboardSounds.id, request.params.id)).get();
    if (!sound) return sendError(reply, 404, 'not_found');
    const own = sound.creatorId === request.userId && can(sound.spaceId, request.userId, PermissionBits.CREATE_SOUNDBOARD);
    if (!member(sound.spaceId, request.userId) || (!own && !can(sound.spaceId, request.userId, PermissionBits.MANAGE_SOUNDBOARD))) return sendError(reply, 403, 'forbidden');
    db.transaction((tx) => {
      tx.delete(schema.soundboardSounds).where(eq(schema.soundboardSounds.id, sound.id)).run();
      const references = tx.select({ n: count() }).from(schema.soundboardSounds).where(eq(schema.soundboardSounds.assetId, sound.assetId)).get()!.n;
      if (!references) tx.delete(schema.soundboardAssets).where(eq(schema.soundboardAssets.id, sound.assetId)).run();
    });
    return { success: true };
  });
  app.get<{ Params: { id: string } }>('/api/soundboard/:id/audio', { preHandler: authenticate }, async (request, reply) => {
    const db = getDb();
    const sound = db.select().from(schema.soundboardSounds).where(eq(schema.soundboardSounds.id, request.params.id)).get();
    if (!sound || !member(sound.spaceId, request.userId)) return sendError(reply, 403, 'forbidden');
    const asset = db.select().from(schema.soundboardAssets).where(eq(schema.soundboardAssets.id, sound.assetId)).get();
    if (!asset) return sendError(reply, 404, 'not_found');
    return reply.type('audio/wav').header('Cache-Control', 'private, max-age=86400').send(brotliDecompressSync(asset.data));
  });
  app.get<{ Params: { ticket: string } }>('/api/soundboard/playback/:ticket', async (request, reply) => {
    const grant = grants.get(request.params.ticket);
    if (!grant || grant.until < Date.now()) return sendError(reply, 404, 'not_found');
    const asset = getDb().select().from(schema.soundboardAssets).where(eq(schema.soundboardAssets.id, grant.assetId)).get();
    if (!asset) return sendError(reply, 404, 'not_found');
    return reply.type('audio/wav').header('Cache-Control', 'no-store').send(brotliDecompressSync(asset.data));
  });
  app.post<{ Params: { id: string } }>('/api/soundboard/:id/play', {
    preHandler: authenticate,
    // Allow rapid overlapping clicks without consuming the general API budget.
    // Keep a high per-IP flood ceiling, with no per-effect or per-room cooldown.
    config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const current = connectionManager.getUserRoom(request.userId);
    const status = connectionManager.getVoiceUserStatus(request.userId);
    if (!current || status?.isDeafened) return sendError(reply, 403, 'forbidden');
    const { room } = current;
    if (room.roomType === 'dm' && (room.metadata as { state: string }).state !== 'active') return sendError(reply, 403, 'forbidden');
    const db = getDb();
    const sound = db.select().from(schema.soundboardSounds).where(eq(schema.soundboardSounds.id, request.params.id)).get();
    if (!sound || !member(sound.spaceId, request.userId)) return sendError(reply, 403, 'forbidden');
    if (room.roomType === 'space') {
      const spaceId = (room.metadata as { spaceId: string }).spaceId;
      for (const bit of [PermissionBits.VIEW_CHANNEL, PermissionBits.CONNECT, PermissionBits.SPEAK, PermissionBits.USE_SOUNDBOARD]) {
        if (!hasPermission(request.userId, spaceId, bit, room.roomId)) return sendError(reply, 403, 'forbidden');
      }
      if (sound.spaceId !== spaceId && !hasPermission(request.userId, spaceId, PermissionBits.USE_EXTERNAL_SOUNDS, room.roomId)) return sendError(reply, 403, 'forbidden');
      const restriction = db.select().from(schema.voiceRestrictions).where(and(eq(schema.voiceRestrictions.spaceId, spaceId), eq(schema.voiceRestrictions.userId, request.userId))).get();
      if (restriction) return sendError(reply, 403, 'forbidden');
    }
    if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) return sendError(reply, 503, 'voice_disabled');
    for (const [key, value] of grants) if (value.until < Date.now()) grants.delete(key);
    if (grants.size >= 2000) grants.delete(grants.keys().next().value!);
    const ticket = randomUUID(); grants.set(ticket, { assetId: sound.assetId, until: Date.now() + 90_000 });
    const channel = room.roomType === 'dm' ? db.select().from(schema.dmChannels).where(eq(schema.dmChannels.id, room.roomId)).get() : null;
    const livekitRoom = room.roomType === 'space' ? room.roomId : channel ? (channel.federatedId ?? `dm-${room.roomId}`) : room.roomId;
    try {
      const client = new RoomServiceClient(config.livekit.url.replace(/^ws/, 'http'), config.livekit.apiKey, config.livekit.apiSecret);
      await client.sendData(livekitRoom, new TextEncoder().encode(JSON.stringify({ type: 'soundboard_play', senderIdentity: `${request.userId}:${request.username}`, senderUserId: request.userId, assetOrigin: getOurOrigin(), ticket, assetId: sound.assetId, name: sound.name, volume: sound.volume, createdAt: Date.now() })), DataPacket_Kind.RELIABLE, { topic: 'backspace.soundboard.v1' });
    } catch { grants.delete(ticket); return sendError(reply, 503, 'voice_disabled'); }
    return { success: true };
  });
}
