import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { PermissionBits, permissionsToString } from '@backspace/shared/src/permissions.js';

// #299: voice moderation (space mute, space deafen, move, disconnect) follows
// the role hierarchy like kick and ban do. A refusal names the ErrorCode.

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
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const SPACE_ID = 'sp-hier';
const ROOM_A = 'vc-hier-a';
const ROOM_B = 'vc-hier-b';
const VOICE_MOD = permissionsToString(
  PermissionBits.VIEW_CHANNEL | PermissionBits.CONNECT | PermissionBits.MUTE_MEMBERS
  | PermissionBits.DEAFEN_MEMBERS | PermissionBits.MOVE_MEMBERS | PermissionBits.DISCONNECT_MEMBERS,
);

function seedUser(id: string): void {
  testDb.insert(schema.users).values({ id, username: id, passwordHash: 'x', createdAt: Date.now() }).run();
}

function seedMember(userId: string, roleId?: string): void {
  seedUser(userId);
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId, joinedAt: Date.now() }).run();
  if (roleId) testDb.insert(schema.memberRoles).values({ spaceId: SPACE_ID, userId, roleId }).run();
}

function fakeWs(): { readyState: number; send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() };
}

function sent(ws: ReturnType<typeof fakeWs>): Array<Record<string, unknown>> {
  return ws.send.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);

  seedUser('owner');
  testDb.insert(schema.spaces).values({ id: SPACE_ID, name: 'Space', ownerId: 'owner', createdAt: Date.now() }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: 'owner', joinedAt: Date.now() }).run();
  testDb.insert(schema.roles).values([
    { id: SPACE_ID, spaceId: SPACE_ID, name: '@everyone', position: 0, permissions: permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.CONNECT), createdAt: 1 },
    { id: 'r-mod', spaceId: SPACE_ID, name: 'Moderators', position: 2, permissions: VOICE_MOD, createdAt: 1 },
    { id: 'r-helper', spaceId: SPACE_ID, name: 'Helpers', position: 1, permissions: VOICE_MOD, createdAt: 1 },
  ]).run();
  seedMember('mod', 'r-mod');
  seedMember('helper', 'r-helper');
  for (const id of [ROOM_A, ROOM_B]) {
    testDb.insert(schema.channels).values({ id, spaceId: SPACE_ID, name: id, type: 'voice', position: 0, createdAt: Date.now() }).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const cm = (await import('./handler.js')).connectionManager;
  const { handleClientEvent } = await import('./events.js');
  cm.createRoom(ROOM_A, 'space', { type: 'space', spaceId: SPACE_ID });
  cm.joinRoom(ROOM_A, 'mod');
  cm.joinRoom(ROOM_A, 'helper');
  const helperWs = fakeWs();
  const modWs = fakeWs();
  cm.addConnection('helper', helperWs as never);
  cm.addUserSpace('helper', SPACE_ID);
  cm.addConnection('mod', modWs as never);
  cm.addUserSpace('mod', SPACE_ID);
  const send = (actor: string, event: Record<string, unknown>) =>
    handleClientEvent(event, actor, actor, (actor === 'mod' ? modWs : helperWs) as never, false);
  return { cm, helperWs, modWs, send };
}

describe('voice moderation follows the role hierarchy', () => {
  it('refuses a helper space-muting a moderator, with the role_hierarchy code', async () => {
    const { helperWs, send } = await setup();
    send('helper', { type: 'voice_space_mute', userId: 'mod', muted: true });

    const events = sent(helperWs);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'role_hierarchy' }));
    expect(events.some((e) => e.type === 'voice_space_muted')).toBe(false);
    expect(testDb.select().from(schema.voiceRestrictions).all()).toHaveLength(0);
  });

  it('refuses a helper deafening, moving or disconnecting a moderator', async () => {
    const { cm, helperWs, send } = await setup();
    send('helper', { type: 'voice_space_deafen', userId: 'mod', deafened: true });
    send('helper', { type: 'voice_move', userId: 'mod', targetChannelId: ROOM_B });
    send('helper', { type: 'voice_disconnect', userId: 'mod' });

    const refusals = sent(helperWs).filter((e) => e.type === 'error' && e.code === 'role_hierarchy');
    expect(refusals).toHaveLength(3);
    expect(cm.getUserRoom('mod')?.roomId).toBe(ROOM_A);
  });

  it('lets a moderator mute and move a helper', async () => {
    const { cm, modWs, send } = await setup();
    send('mod', { type: 'voice_space_mute', userId: 'helper', muted: true });
    send('mod', { type: 'voice_move', userId: 'helper', targetChannelId: ROOM_B });

    expect(sent(modWs).some((e) => e.type === 'error')).toBe(false);
    expect(testDb.select().from(schema.voiceRestrictions).all()).toHaveLength(1);
    expect(cm.getUserRoom('helper')?.roomId).toBe(ROOM_B);
  });
});
