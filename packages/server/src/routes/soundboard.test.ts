import { setWorkerId } from '../utils/snowflake.js';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import * as schema from '../db/schema.js';
import { DEFAULT_EVERYONE_PERMISSIONS, PermissionBits } from '@backspace/shared/src/permissions.js';
const mocks = vi.hoisted(() => ({ current: null as unknown, status: {} as Record<string, unknown>, sendData: vi.fn().mockResolvedValue(undefined) }));
let db: ReturnType<typeof drizzle<typeof schema>>; let sqlite: Database.Database; let app: FastifyInstance;
vi.mock('../db/index.js', () => ({ getDb: () => db, schema }));
vi.mock('../config.js', () => ({ config: { livekit: { url: 'ws://127.0.0.1:7880', apiKey: 'key', apiSecret: 'secret' } } }));
vi.mock('../utils/federationAuth.js', () => ({ getOurOrigin: () => 'https://chat.test' }));
vi.mock('../ws/handler.js', () => ({ connectionManager: { getUserRoom: () => mocks.current, getVoiceUserStatus: () => mocks.status } }));
vi.mock('livekit-server-sdk', () => ({ DataPacket_Kind: { RELIABLE: 0 }, RoomServiceClient: class { sendData = mocks.sendData; } }));
vi.mock('../utils/auth.js', () => ({ authenticate: async (request: FastifyRequest & { userId?: string; username?: string }, reply: FastifyReply) => { if (!request.headers.authorization) return reply.code(401).send(); request.userId = request.headers.authorization; request.username = request.userId; } }));
import { soundboardRoutes, _resetSoundboardLimits } from './soundboard.js';
import { validateSoundboardWav } from '../utils/soundboardAudio.js';
function wav(samples = 4800) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}
const headers = (user = 'owner') => ({ authorization: user });
const upload = (space = 's1', user = 'owner', audio = wav()) => app.inject({ method: 'POST', url: `/api/spaces/${space}/soundboard`, headers: headers(user), payload: { name: 'Effect', audio: audio.toString('base64'), volume: 0.8 } });
beforeEach(async () => {
  setWorkerId(1);
  vi.stubEnv('DISABLE_RATE_LIMITS', ''); _resetSoundboardLimits(); mocks.sendData.mockClear(); mocks.status = {};
  mocks.current = { roomId: 'voice', room: { roomId: 'voice', roomType: 'space', metadata: { type: 'space', spaceId: 's1' }, participants: new Set(['owner', 'member']) } };
  sqlite = new Database(':memory:'); sqlite.pragma('foreign_keys=ON'); db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: path.resolve('drizzle') });
  for (const id of ['owner', 'member', 'outsider']) db.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: 1 }).run();
  for (const id of ['s1', 's2']) {
    db.insert(schema.spaces).values({ id, name: id, ownerId: 'owner', createdAt: 1 }).run();
    db.insert(schema.roles).values({ id, spaceId: id, name: '@everyone', permissions: DEFAULT_EVERYONE_PERMISSIONS.toString(), createdAt: 1 }).run();
    for (const userId of ['owner', 'member']) db.insert(schema.spaceMembers).values({ spaceId: id, userId, joinedAt: 1 }).run();
  }
  app = Fastify();
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(soundboardRoutes);
});
afterEach(async () => { await app.close(); sqlite.close(); vi.unstubAllEnvs(); });
it('validates actual canonical PCM duration and rejects spoofed formats', () => {
  expect(validateSoundboardWav(wav())).toBe(100);
  expect(validateSoundboardWav(wav(249601))).toBeNull();
  const invalid = wav(); invalid.writeUInt16LE(2, 22); expect(validateSoundboardWav(invalid)).toBeNull();
  expect(validateSoundboardWav(Buffer.from('not audio'))).toBeNull();
});
it('requires authentication, membership and creation permission, deduplicating assets', async () => {
  expect((await app.inject({ url: '/api/soundboard' })).statusCode).toBe(401);
  expect((await upload('s1', 'member')).statusCode).toBe(403);
  expect((await upload('s1', 'outsider')).statusCode).toBe(403);
  const first = await upload(); expect(first.statusCode, first.body).toBe(201);
  expect((await upload('s2')).statusCode).toBe(201);
  expect(db.select().from(schema.soundboardAssets).all()).toHaveLength(1);
  const list = await app.inject({ url: '/api/soundboard', headers: headers('outsider') }); expect(list.json()).toEqual([]);
  expect((await app.inject({ url: `/api/soundboard/${first.json().id}/audio`, headers: headers('outsider') })).statusCode).toBe(403);
});
it('enforces forty sounds per server and only removes assets after their final use', async () => {
  const first = (await upload()).json(); const other = (await upload('s2')).json();
  for (let i = 0; i < 39; i++) db.insert(schema.soundboardSounds).values({ id: `sound${i}`, spaceId: 's1', assetId: first.assetId, creatorId: 'owner', name: 'Other', createdAt: 1 }).run();
  expect((await upload()).statusCode).toBe(409);
  expect((await app.inject({ method: 'DELETE', url: `/api/soundboard/${first.id}`, headers: headers('member') })).statusCode).toBe(403);
  db.delete(schema.spaces).where(eq(schema.spaces.id, 's1')).run(); expect(db.select().from(schema.soundboardAssets).all()).toHaveLength(1);
  await app.inject({ method: 'DELETE', url: `/api/soundboard/${other.id}`, headers: headers() });
  expect(db.select().from(schema.soundboardAssets).all()).toHaveLength(0);
});
it('authorizes sound playback against the current room and sends only a short server event', async () => {
  const sound = (await upload()).json();
  const played = await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') });
  expect(played.statusCode).toBe(200); expect(mocks.sendData).toHaveBeenCalledOnce();
  const [room, data] = mocks.sendData.mock.calls[0]!; expect(room).toBe('voice'); expect(data.byteLength).toBeLessThan(2048);
  const event = JSON.parse(new TextDecoder().decode(data));
  expect(event.senderIdentity).toBe('member:member'); expect(event.senderUserId).toBe('member');
  const audio = await app.inject({ url: `/api/soundboard/playback/${event.ticket}` }); expect(audio.statusCode).toBe(200); expect(audio.rawPayload).toEqual(wav());
  expect((await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') })).statusCode).toBe(200);
  mocks.current = null;
  expect((await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers() })).statusCode).toBe(403);
});
it('checks external-sound permission, server mute and active private calls', async () => {
  const sound = (await upload('s2')).json();
  db.update(schema.roles).set({ permissions: (DEFAULT_EVERYONE_PERMISSIONS & ~PermissionBits.USE_EXTERNAL_SOUNDS).toString() }).where(eq(schema.roles.id, 's1')).run();
  expect((await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') })).statusCode).toBe(403);
  db.insert(schema.voiceRestrictions).values({ spaceId: 's1', userId: 'owner', restrictionType: 'mute', createdAt: 1 }).run();
  expect((await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers() })).statusCode).toBe(403);
  mocks.status = {}; mocks.current = { roomId: 'dm', room: { roomId: 'dm', roomType: 'dm', metadata: { state: 'active' } } };
  expect((await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') })).statusCode).toBe(200);
});

it('sends reliable sound events while self-muted but rejects deafen and missing SPEAK permission', async () => {
  const sound = (await upload()).json();
  mocks.status = { isMuted: true, isDeafened: false };
  const played = await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') });
  expect(played.statusCode).toBe(200);
  expect(mocks.sendData).toHaveBeenCalledWith('voice', expect.any(Uint8Array), 0, { topic: 'backspace.soundboard.v1' });
  mocks.status.isDeafened = true;
  expect((await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') })).statusCode).toBe(403);
  mocks.status.isDeafened = false;
  db.update(schema.roles).set({ permissions: (DEFAULT_EVERYONE_PERMISSIONS & ~PermissionBits.SPEAK).toString() }).where(eq(schema.roles.id, 's1')).run();
  expect((await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') })).statusCode).toBe(403);
  expect(mocks.sendData).toHaveBeenCalledOnce();
});

it('accepts rapid playback beyond the general API budget and retains only the high flood ceiling', async () => {
  const sound = (await upload()).json();
  mocks.status = { isMuted: true };
  const requests = await Promise.all(Array.from({ length: 240 }, () => app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') })));
  expect(requests.every((response) => response.statusCode === 200)).toBe(true);
  expect(mocks.sendData).toHaveBeenCalledTimes(240);
  const remaining = await Promise.all(Array.from({ length: 960 }, () => app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') })));
  expect(remaining.every((response) => response.statusCode === 200)).toBe(true);
  expect(mocks.sendData).toHaveBeenCalledTimes(1200);
  expect((await app.inject({ method: 'POST', url: `/api/soundboard/${sound.id}/play`, headers: headers('member') })).statusCode).toBe(429);
  // The soundboard burst must not exhaust normal API requests.
  expect((await app.inject({ url: '/api/soundboard', headers: headers('member') })).statusCode).toBe(200);
}, 15000);

it('keeps the existing upload limit', async () => {
  for (let index = 0; index < 10; index++) expect((await upload()).statusCode).toBe(201);
  expect((await upload()).statusCode).toBe(429);
});
