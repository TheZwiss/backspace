import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
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

// Enroll a user as a space member. computePermissions grants @everyone
// permissions only to actual members, and every real join path inserts this row
// before voice state is built/pushed — so visibility tests must seed it too.
function seedMember(spaceId: string, userId: string): void {
  seedUser(userId);
  testDb.insert(schema.spaceMembers).values({
    spaceId,
    userId,
    joinedAt: Date.now(),
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
    cm.getRoom(voiceCh)!.startedAt = Date.now() - 65_000;
    cm.setVoiceUserStatus('u-muted', true, false, false, false);
    cm.setVoiceUserStatus('u-perm', false, false, true, false);

    // u-muted is space-muted (persisted), u-perm is permission-muted (ephemeral).
    seedUser('u-muted');
    seedRestriction(spaceId, 'u-muted', 'mute');
    cm.setPermissionMuted(spaceId, 'u-perm', true);

    // Query as the space owner (sees every channel).
    const snap = cm.buildSpaceVoiceState(spaceId, 'owner');

    expect(snap.voiceStates[voiceCh]?.sort()).toEqual(['u-muted', 'u-perm']);
    expect(snap.voiceChannelElapsedSeconds[voiceCh]).toBe(65);
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
    expect(Object.keys(snap.voiceChannelElapsedSeconds)).toHaveLength(0);
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
    seedMember(spaceId, 'u-viewer');
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
    expect(snap.voiceChannelElapsedSeconds[publicCh]).toBe(0);
    expect(snap.voiceChannelElapsedSeconds[privateCh]).toBeUndefined();
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
    seedMember(spaceId, 'u-joiner');
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
    expect(frames[0].voiceChannelElapsedSeconds[voiceCh]).toBe(0);
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

describe('connectionManager.announceSpaceAccessChange', () => {
  // A member gains a private voice channel through a role. The access change
  // reaches every connected member; each affected one also gets the voice
  // state they can see now, so the people already in that channel show at
  // once instead of after the next join or leave.
  async function privateVoiceSpace(spaceId: string) {
    const cm = await importManager();
    const publicCh = `${spaceId}-vc-public`;
    const privateCh = `${spaceId}-vc-private`;
    seedSpace(spaceId);
    seedEveryoneRole(spaceId);
    seedChannel(publicCh, spaceId, 'voice');
    seedChannel(privateCh, spaceId, 'voice');
    seedDenyViewOverride(privateCh, spaceId);
    testDb.insert(schema.roles).values({
      id: `${spaceId}-vip`, spaceId, name: 'VIP', color: '#c4b5fd', position: 1, permissions: '0', createdAt: Date.now(),
    }).run();
    testDb.insert(schema.channelOverrides).values({
      channelId: privateCh, targetType: 'role', targetId: `${spaceId}-vip`,
      allow: permissionsToString(PermissionBits.VIEW_CHANNEL), deny: '0',
    }).run();
    for (const [ch, occupant] of [[publicCh, 'u-in-public'], [privateCh, 'u-in-private']] as const) {
      cm.createRoom(ch, 'space', { type: 'space', spaceId });
      cm.joinRoom(ch, occupant);
      cm.setVoiceUserStatus(occupant, false, false, false, false);
    }
    return { cm, publicCh, privateCh, vip: `${spaceId}-vip` };
  }

  function connect(cm: Awaited<ReturnType<typeof importManager>>, spaceId: string, userId: string): FakeWs {
    seedMember(spaceId, userId);
    const ws = fakeWs();
    cm.addConnection(userId, ws as never);
    cm.setUserSpaces(userId, [spaceId]);
    return ws;
  }

  function frames(ws: FakeWs): { type: string; [key: string]: unknown }[] {
    return ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
  }

  it('sends an affected member who gained a private voice channel its occupants, after the access change', async () => {
    const spaceId = 'sp-gain';
    const { cm, publicCh, privateCh, vip } = await privateVoiceSpace(spaceId);
    const ws = connect(cm, spaceId, 'u-gainer');
    testDb.insert(schema.memberRoles).values({ spaceId, userId: 'u-gainer', roleId: vip }).run();

    cm.announceSpaceAccessChange(spaceId, ['u-gainer']);

    const sent = frames(ws);
    expect(sent.map((e) => e.type)).toEqual(['space_access_changed', 'space_voice_state']);
    expect(sent[0]).toEqual({ type: 'space_access_changed', spaceId });
    const voice = sent[1] as unknown as { spaceId: string; voiceStates: Record<string, string[]>; voiceUserStates: Record<string, unknown> };
    expect(voice.spaceId).toBe(spaceId);
    expect(voice.voiceStates[privateCh]).toEqual(['u-in-private']);
    expect(voice.voiceStates[publicCh]).toEqual(['u-in-public']);
    expect(voice.voiceUserStates['u-in-private']).toBeDefined();
  });

  it('sends each affected member only the voice channels they can see', async () => {
    const spaceId = 'sp-scope';
    const { cm, publicCh, privateCh } = await privateVoiceSpace(spaceId);
    const ws = connect(cm, spaceId, 'u-plain');

    cm.announceSpaceAccessChange(spaceId, ['u-plain']);

    const voice = frames(ws).find((e) => e.type === 'space_voice_state') as unknown as { voiceStates: Record<string, string[]>; voiceUserStates: Record<string, unknown> };
    expect(voice.voiceStates[publicCh]).toEqual(['u-in-public']);
    expect(voice.voiceStates[privateCh]).toBeUndefined();
    expect(voice.voiceUserStates['u-in-private']).toBeUndefined();
  });

  it('sends members who are not affected the access change alone', async () => {
    const spaceId = 'sp-bystander';
    const { cm, vip } = await privateVoiceSpace(spaceId);
    connect(cm, spaceId, 'u-gainer');
    const bystander = connect(cm, spaceId, 'u-bystander');
    testDb.insert(schema.memberRoles).values({ spaceId, userId: 'u-gainer', roleId: vip }).run();

    cm.announceSpaceAccessChange(spaceId, ['u-gainer']);

    expect(frames(bystander).map((e) => e.type)).toEqual(['space_access_changed']);
  });

  it('sends no voice state when nobody is in voice there', async () => {
    const cm = await importManager();
    const spaceId = 'sp-quiet';
    seedSpace(spaceId);
    seedEveryoneRole(spaceId);
    seedChannel('vc-quiet', spaceId, 'voice');
    const ws = connect(cm, spaceId, 'u-quiet');

    cm.announceSpaceAccessChange(spaceId, ['u-quiet']);

    expect(frames(ws).map((e) => e.type)).toEqual(['space_access_changed']);
  });
});

describe('connectionManager.announceUserAccessChange', () => {
  // An instance admin promoted or demoted: their own permissions changed in
  // every space they belong to, and nobody else's did.
  function frames(ws: FakeWs): { type: string; [key: string]: unknown }[] {
    return ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
  }

  async function twoSpaces() {
    const cm = await importManager();
    const voiceSpace = 'sp-admin-voice';
    const plainSpace = 'sp-admin-plain';
    const privateCh = `${voiceSpace}-vc-private`;
    seedSpace(voiceSpace);
    seedEveryoneRole(voiceSpace);
    seedChannel(privateCh, voiceSpace, 'voice');
    seedDenyViewOverride(privateCh, voiceSpace);
    testDb.insert(schema.spaces).values({ id: plainSpace, name: 'Plain', ownerId: 'owner', createdAt: Date.now() }).run();
    seedEveryoneRole(plainSpace);
    cm.createRoom(privateCh, 'space', { type: 'space', spaceId: voiceSpace });
    cm.joinRoom(privateCh, 'u-admin-occupant');
    cm.setVoiceUserStatus('u-admin-occupant', false, false, false, false);
    return { cm, voiceSpace, plainSpace, privateCh };
  }

  it('sends the user one space_access_changed per space on each connection, and nothing to other members', async () => {
    const { cm, voiceSpace, plainSpace, privateCh } = await twoSpaces();
    seedMember(voiceSpace, 'u-promoted');
    testDb.insert(schema.spaceMembers).values({ spaceId: plainSpace, userId: 'u-promoted', joinedAt: Date.now() }).run();
    const tabA = fakeWs();
    const tabB = fakeWs();
    cm.addConnection('u-promoted', tabA as never);
    cm.addConnection('u-promoted', tabB as never);
    cm.setUserSpaces('u-promoted', [voiceSpace, plainSpace]);
    seedMember(voiceSpace, 'u-other');
    const other = fakeWs();
    cm.addConnection('u-other', other as never);
    cm.setUserSpaces('u-other', [voiceSpace]);
    testDb.update(schema.users).set({ isAdmin: 1 }).where(eq(schema.users.id, 'u-promoted')).run();

    cm.announceUserAccessChange('u-promoted', [voiceSpace, plainSpace, voiceSpace]);

    for (const ws of [tabA, tabB]) {
      const sent = frames(ws);
      expect(sent.filter((e) => e.type === 'space_access_changed')).toEqual([
        { type: 'space_access_changed', spaceId: voiceSpace },
        { type: 'space_access_changed', spaceId: plainSpace },
      ]);
      const voice = sent.find((e) => e.type === 'space_voice_state') as unknown as { spaceId: string; voiceStates: Record<string, string[]> };
      expect(voice.spaceId).toBe(voiceSpace);
      expect(voice.voiceStates[privateCh]).toEqual(['u-admin-occupant']);
    }
    expect(frames(other)).toEqual([]);
  });

  it('sends nothing when the user has no connection', async () => {
    const { cm, voiceSpace } = await twoSpaces();
    seedMember(voiceSpace, 'u-offline');
    seedMember(voiceSpace, 'u-online');
    const online = fakeWs();
    cm.addConnection('u-online', online as never);
    cm.setUserSpaces('u-online', [voiceSpace]);

    cm.announceUserAccessChange('u-offline', [voiceSpace]);

    expect(frames(online)).toEqual([]);
  });
});
