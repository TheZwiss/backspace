import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '../utils/permissions.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sql.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedUser(id: string): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: 'x',
    homeUserId: id,
    homeInstance: null,
    createdAt: Date.now(),
  }).run();
}

function seedSpace(spaceId: string): void {
  seedUser('owner');
  testDb.insert(schema.spaces).values({
    id: spaceId,
    name: 'Test Space',
    ownerId: 'owner',
    createdAt: Date.now(),
  }).run();
}

function seedChannel(id: string, spaceId: string, type: 'text' | 'voice'): void {
  testDb.insert(schema.channels).values({
    id,
    spaceId,
    name: type,
    type,
    position: 0,
    createdAt: Date.now(),
  }).run();
}

// @everyone role (id === spaceId) granting VIEW_CHANNEL, so non-owner members can
// see the space's channels (mirrors real space creation).
function seedEveryoneRole(spaceId: string): void {
  testDb.insert(schema.roles).values({
    id: spaceId,
    spaceId,
    name: '@everyone',
    color: '#b9bbbe',
    position: 0,
    permissions: permissionsToString(PermissionBits.VIEW_CHANNEL),
    createdAt: Date.now(),
  }).run();
}

// Make a channel private by denying VIEW_CHANNEL to @everyone (role override).
function seedDenyViewOverride(channelId: string, spaceId: string): void {
  testDb.insert(schema.channelOverrides).values({
    channelId,
    targetType: 'role',
    targetId: spaceId,
    allow: '0',
    deny: permissionsToString(PermissionBits.VIEW_CHANNEL),
  }).run();
}

function seedRestriction(spaceId: string, userId: string, restrictionType: 'mute' | 'deafen'): void {
  testDb.insert(schema.voiceRestrictions).values({
    spaceId,
    userId,
    restrictionType,
    createdAt: Date.now(),
  }).run();
}

async function importManager() {
  const mod = await import('./handler.js');
  return mod.connectionManager;
}

interface FakeWs {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
}

function fakeWs(): FakeWs {
  return { readyState: 1, send: vi.fn() };
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('connectionManager.buildSpaceVoiceState', () => {
  it('returns participants, statuses, space-mute and permission-mute for one space', async () => {
    const cm = await importManager();
    const spaceId = 'sp-build-1';
    const voiceCh = 'vc-build-1';
    const textCh = 'tc-build-1';
    seedSpace(spaceId);
    seedChannel(voiceCh, spaceId, 'voice');
    seedChannel(textCh, spaceId, 'text');

    // Two users actively connected to the voice channel.
    cm.createRoom(voiceCh, 'space', { type: 'space', spaceId });
    cm.joinRoom(voiceCh, 'u-muted');
    cm.joinRoom(voiceCh, 'u-perm');
    cm.setVoiceUserStatus('u-muted', true, false, false, false);
    cm.setVoiceUserStatus('u-perm', false, false, true, false);

    // u-muted is space-muted (persisted), u-perm is permission-muted (ephemeral).
    seedUser('u-muted');
    seedRestriction(spaceId, 'u-muted', 'mute');
    cm.setPermissionMuted(spaceId, 'u-perm', true);

    // Query as the space owner (sees every channel).
    const snap = cm.buildSpaceVoiceState(spaceId, 'owner');

    expect(snap.voiceStates[voiceCh]?.sort()).toEqual(['u-muted', 'u-perm']);
    // Text channels never appear.
    expect(snap.voiceStates[textCh]).toBeUndefined();

    expect(snap.voiceUserStates['u-muted']).toEqual({ isMuted: true, isDeafened: false, isCameraOn: false, isScreenSharing: false });
    expect(snap.voiceUserStates['u-perm']).toEqual({ isMuted: false, isDeafened: false, isCameraOn: true, isScreenSharing: false });

    expect(snap.spaceVoiceStates[`${spaceId}:u-muted`]?.spaceMuted).toBe(true);
    expect(snap.spaceVoiceStates[`${spaceId}:u-perm`]?.permissionMuted).toBe(true);
  });

  it('returns empty maps for a space with no active voice participants', async () => {
    const cm = await importManager();
    const spaceId = 'sp-build-empty';
    seedSpace(spaceId);
    seedChannel('vc-empty', spaceId, 'voice');

    const snap = cm.buildSpaceVoiceState(spaceId, 'owner');
    expect(Object.keys(snap.voiceStates)).toHaveLength(0);
    expect(Object.keys(snap.voiceUserStates)).toHaveLength(0);
    expect(Object.keys(snap.spaceVoiceStates)).toHaveLength(0);
  });

  it('excludes voice channels the viewing user cannot VIEW (private channels)', async () => {
    const cm = await importManager();
    const spaceId = 'sp-private-1';
    const publicCh = 'vc-public-1';
    const privateCh = 'vc-private-1';
    seedSpace(spaceId);
    seedEveryoneRole(spaceId);
    seedChannel(publicCh, spaceId, 'voice');
    seedChannel(privateCh, spaceId, 'voice');
    seedDenyViewOverride(privateCh, spaceId);

    cm.createRoom(publicCh, 'space', { type: 'space', spaceId });
    cm.joinRoom(publicCh, 'u-in-public');
    cm.createRoom(privateCh, 'space', { type: 'space', spaceId });
    cm.joinRoom(privateCh, 'u-in-private');

    // 'u-viewer' is a plain @everyone member (no special roles, not the owner).
    const snap = cm.buildSpaceVoiceState(spaceId, 'u-viewer');

    expect(snap.voiceStates[publicCh]).toEqual(['u-in-public']);
    expect(snap.voiceStates[privateCh]).toBeUndefined();
    // The hidden channel's occupant must not leak through voiceUserStates either.
    expect(snap.voiceUserStates['u-in-private']).toBeUndefined();
  });
});

describe('connectionManager.addUserSpace voice-state push', () => {
  it('pushes space_voice_state to the joining user when the space has active voice', async () => {
    const cm = await importManager();
    const spaceId = 'sp-push-1';
    const voiceCh = 'vc-push-1';
    seedSpace(spaceId);
    seedEveryoneRole(spaceId);
    seedChannel(voiceCh, spaceId, 'voice');

    cm.createRoom(voiceCh, 'space', { type: 'space', spaceId });
    cm.joinRoom(voiceCh, 'u-already-here');
    cm.setVoiceUserStatus('u-already-here', false, false, false, false);

    const ws = fakeWs();
    cm.addConnection('u-joiner', ws as never);

    cm.addUserSpace('u-joiner', spaceId);

    const frames = ws.send.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((e) => e.type === 'space_voice_state');
    expect(frames).toHaveLength(1);
    expect(frames[0].spaceId).toBe(spaceId);
    expect(frames[0].voiceStates[voiceCh]).toEqual(['u-already-here']);
    expect(frames[0].voiceUserStates['u-already-here']).toBeDefined();
  });

  it('does not push a frame when the joined space has no active voice', async () => {
    const cm = await importManager();
    const spaceId = 'sp-push-empty';
    seedSpace(spaceId);
    seedChannel('vc-push-empty', spaceId, 'voice');

    const ws = fakeWs();
    cm.addConnection('u-joiner-2', ws as never);

    cm.addUserSpace('u-joiner-2', spaceId);

    const frames = ws.send.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((e) => e.type === 'space_voice_state');
    expect(frames).toHaveLength(0);
  });
});
