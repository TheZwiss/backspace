import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { DEFAULT_EVERYONE_PERMISSIONS, PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';
import { soundboardWavDuration } from '@backspace/shared/src/soundboard.js';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

const config = vi.hoisted(() => ({ uploadDir: '', maxUploadSize: 20 * 1024 * 1024 }));
const voice = vi.hoisted(() => ({
  getUserRoom: vi.fn(), getVoiceWs: vi.fn(), getRoomParticipants: vi.fn(),
  getVoiceUserStatus: vi.fn(), isSpaceMuted: vi.fn(), isPermissionMuted: vi.fn(), isSpaceDeafened: vi.fn(), sendToSpace: vi.fn(),
}));
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: FastifyInstance;
vi.mock('../db/index.js', () => ({ getDb: () => db, schema }));
vi.mock('../config.js', () => ({ config }));
vi.mock('../ws/handler.js', () => ({ connectionManager: voice }));
vi.mock('../utils/auth.js', () => ({ authenticate: async (request: { userId: string; headers: Record<string, string> }, reply: { code: (status: number) => { send: () => void } }) => {
  if (!request.headers.authorization) return reply.code(401).send();
  request.userId = request.headers.authorization;
} }));
import { soundboardRoutes, _resetSoundboardLimits } from './soundboard.js';

function wav(seconds = 1): Buffer {
  const bytes = Buffer.alloc(44 + seconds * 48000 * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

beforeEach(async () => {
  vi.resetAllMocks(); _resetSoundboardLimits(); setWorkerId(1);
  config.uploadDir = await mkdtemp(path.join(tmpdir(), 'soundboard-test-'));
  sqlite = new Database(':memory:'); sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: path.resolve('drizzle') });
  for (const id of ['owner', 'alice', 'bob', 'outsider', 'remote-row']) db.insert(schema.users).values({
    id, username: id, passwordHash: 'test', createdAt: 1,
    ...(id === 'remote-row' ? { homeInstance: 'remote.test', homeUserId: 'different-home-id' } : {}),
  }).run();
  for (const id of ['space', 'other']) {
    db.insert(schema.spaces).values({ id, name: id, ownerId: 'owner', createdAt: 1 }).run();
    db.insert(schema.roles).values({ id, spaceId: id, name: '@everyone', permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS), createdAt: 1 }).run();
  }
  for (const userId of ['owner', 'alice', 'bob', 'remote-row']) db.insert(schema.spaceMembers).values({ spaceId: 'space', userId, joinedAt: 1 }).run();
  db.insert(schema.channels).values({ id: 'voice', spaceId: 'space', name: 'voice', type: 'voice', createdAt: 1 }).run();
  db.insert(schema.channels).values({ id: 'elsewhere', spaceId: 'other', name: 'voice', type: 'voice', createdAt: 1 }).run();
  voice.getUserRoom.mockReturnValue({ roomId: 'voice' });
  voice.getVoiceWs.mockReturnValue({ readyState: 1, send: vi.fn() });
  voice.getRoomParticipants.mockReturnValue(new Set(['alice', 'bob']));
  voice.getVoiceUserStatus.mockReturnValue({ isMuted: false, isDeafened: false });
  app = Fastify(); await app.register(soundboardRoutes);
});
afterEach(async () => { await app.close(); sqlite.close(); await rm(config.uploadDir, { recursive: true, force: true }); });

const root = '/api/spaces/space/soundboard';
const headers = (user = 'alice') => ({ authorization: user });
const upload = (user = 'alice', bytes = wav()) => app.inject({ method: 'POST', url: root, headers: headers(user), payload: { name: ' Hello ', emoji: '🔊', audio: bytes.toString('base64') } });
const policy = (patch: Record<string, unknown>, user = 'owner') => app.inject({ method: 'PATCH', url: `${root}/settings`, headers: headers(user), payload: { enabled: true, allowMemberUploads: true, maxDurationSeconds: 10, maxSounds: 50, ...patch } });
const play = (id: string, user = 'alice', channelId = 'voice') => app.inject({ method: 'POST', url: `${root}/${id}/play`, headers: headers(user), payload: { channelId } });

describe('soundboard routes and validated media', () => {
  it('requires authentication and membership, even for instance administrators', async () => {
    expect((await app.inject({ method: 'GET', url: root })).statusCode).toBe(401);
    db.update(schema.users).set({ isAdmin: 1 }).where(eq(schema.users.id, 'outsider')).run();
    expect((await app.inject({ method: 'GET', url: root, headers: headers('outsider') })).statusCode).toBe(403);
    expect((await upload('outsider')).statusCode).toBe(403);
  });
  it('stores canonical audio, trims names, and derives duration from samples', async () => {
    const response = await upload(); expect(response.statusCode).toBe(201);
    const sound = response.json(); expect(sound.name).toBe('Hello'); expect(sound.durationSeconds).toBe(1);
    expect(await readFile(path.join(config.uploadDir, sound.filename))).toEqual(wav());
    expect(voice.sendToSpace).toHaveBeenCalledWith('space', { type: 'soundboard_updated', spaceId: 'space' });
  });
  it('rejects bogus headers, trailing bytes and blank names without creating rows', async () => {
    const altered = wav(); altered.writeUInt32LE(1, 24);
    expect((await upload('alice', altered)).json().code).toBe('soundboard_invalid_audio');
    expect((await upload('alice', Buffer.concat([wav(), Buffer.from('bad')]))).statusCode).toBe(400);
    expect(soundboardWavDuration(Buffer.from('not audio'))).toBeNull();
    expect((await app.inject({ method: 'POST', url: root, headers: headers(), payload: { name: ' ', emoji: 'x', audio: wav().toString('base64') } })).statusCode).toBe(400);
    expect(db.select().from(schema.soundboardSounds).all()).toHaveLength(0);
  });
  it('enforces duration, supports null, and does not delete clips when the cap drops', async () => {
    expect((await policy({ maxDurationSeconds: 0.5 })).statusCode).toBe(200);
    expect((await upload()).json().code).toBe('soundboard_duration_limit');
    expect((await policy({ maxDurationSeconds: null })).statusCode).toBe(200);
    const sound = (await upload()).json();
    await policy({ maxDurationSeconds: 0.5 });
    expect((await play(sound.id)).json().code).toBe('soundboard_duration_limit');
    expect((await app.inject({ method: 'GET', url: root, headers: headers() })).json().sounds).toHaveLength(1);
  });
  it('rejects invalid policy values and non-managers', async () => {
    expect((await policy({ maxSounds: 0 })).statusCode).toBe(400);
    expect((await policy({ maxDurationSeconds: -1 })).statusCode).toBe(400);
    expect((await policy({ maxDurationSeconds: 0 })).statusCode).toBe(400);
    const denied = await policy({}, 'alice');
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'missing_permission', details: { permission: 'MANAGE_SPACE' } });
  });
  it('honors upload policy, Attach Files permission, disable switch and quotas', async () => {
    await policy({ allowMemberUploads: false });
    expect((await upload()).json()).toMatchObject({ code: 'missing_permission', details: { permission: 'MANAGE_SPACE' } });
    expect((await upload('owner')).statusCode).toBe(201);
    await policy({ maxSounds: 1 });
    expect((await upload()).json().code).toBe('soundboard_full');
    await policy({ enabled: false });
    expect((await upload('owner')).json().code).toBe('soundboard_disabled');
    await policy({});
    db.update(schema.roles).set({ permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS & ~PermissionBits.ATTACH_FILES) }).where(eq(schema.roles.id, 'space')).run();
    expect((await upload()).json()).toMatchObject({ code: 'missing_permission', details: { permission: 'ATTACH_FILES' } });
  });
  it('respects the instance upload-size cap', async () => {
    db.insert(schema.instanceSettings).values({ id: 1, maxUploadSizeBytes: 1000, updatedAt: 1 }).run();
    expect((await upload()).json().code).toBe('soundboard_invalid_audio');
  });
  it('only the uploader or a manager can delete, scoped to the correct space', async () => {
    const sound = (await upload()).json();
    expect((await app.inject({ method: 'DELETE', url: `${root}/${sound.id}`, headers: headers('bob') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/spaces/other/soundboard/${sound.id}`, headers: headers('owner') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `${root}/${sound.id}`, headers: headers() })).statusCode).toBe(200);
    expect((await play(sound.id)).json().code).toBe('soundboard_not_found');
  });
  it('uses the federated member row, not their home id', async () => {
    const response = await upload('remote-row'); expect(response.statusCode).toBe(201);
    expect(response.json().uploaderId).toBe('remote-row');
    expect((await play(response.json().id, 'remote-row')).statusCode).toBe(200);
  });
  it('sends playback only to voice-owning sockets in this room and skips deafened listeners', async () => {
    const sound = (await upload()).json();
    const alice = { readyState: 1, send: vi.fn() }; const bob = { readyState: 1, send: vi.fn() };
    voice.getVoiceWs.mockImplementation((id: string) => id === 'alice' ? alice : bob);
    voice.getVoiceUserStatus.mockImplementation((id: string) => ({ isDeafened: id === 'bob' }));
    expect((await play(sound.id)).statusCode).toBe(200);
    expect(alice.send).toHaveBeenCalledOnce(); expect(bob.send).not.toHaveBeenCalled();
    expect(JSON.parse(alice.send.mock.calls[0]![0])).toMatchObject({ type: 'soundboard_play', channelId: 'voice', sound: { id: sound.id } });
  });
  it.each(['isSpaceMuted', 'isPermissionMuted', 'isSpaceDeafened'] as const)('cannot bypass %s', async method => {
    const sound = (await upload()).json(); voice[method].mockReturnValue(true);
    expect((await play(sound.id)).statusCode).toBe(403);
  });
  it('refuses absent voice sessions, wrong rooms and denied channel Speak', async () => {
    const sound = (await upload()).json();
    expect((await play(sound.id, 'alice', 'elsewhere')).statusCode).toBe(403);
    voice.getUserRoom.mockReturnValue(null);
    const denied = await play(sound.id);
    expect(denied.statusCode).toBe(403); expect(denied.json().code).toBe('forbidden');
    voice.getUserRoom.mockReturnValue({ roomId: 'voice' });
    db.insert(schema.channelOverrides).values({ channelId: 'voice', targetType: 'member', targetId: 'alice', allow: '0', deny: permissionsToString(PermissionBits.SPEAK) }).run();
    expect((await play(sound.id)).statusCode).toBe(403);
  });
  it('rate limits both individual actors and shared rooms', async () => {
    const sound = (await upload()).json();
    expect((await play(sound.id)).statusCode).toBe(200);
    expect((await play(sound.id)).statusCode).toBe(429);
    expect((await play(sound.id, 'bob')).statusCode).toBe(429);
  });
});
