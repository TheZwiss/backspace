import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));
vi.mock('../ws/handler.js', () => ({
  connectionManager: { sendToSpace: vi.fn(), removeUserSpace: vi.fn() },
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

const SPACE = 'sp-trace';
const OTHER_SPACE = 'sp-other';

function seed(): void {
  const now = Date.now();
  const user = (id: string, isBot: number) => testDb.insert(schema.users).values({
    id, username: id, passwordHash: 'x', homeUserId: id, homeInstance: null, createdAt: now, isBot,
  }).run();
  user('owner', 0); user('bot', 1); user('person', 0);
  for (const sp of [SPACE, OTHER_SPACE]) {
    testDb.insert(schema.spaces).values({ id: sp, name: sp, ownerId: 'owner', createdAt: now }).run();
    testDb.insert(schema.roles).values({ id: `r-${sp}`, spaceId: sp, name: 'r', color: '#fff', position: 1, permissions: '0', createdAt: now }).run();
    testDb.insert(schema.channels).values({ id: `c-${sp}`, spaceId: sp, name: 'c', type: 'text', position: 0, createdAt: now }).run();
    for (const uid of ['bot', 'person']) {
      testDb.insert(schema.spaceMembers).values({ spaceId: sp, userId: uid, joinedAt: now }).run();
      testDb.insert(schema.memberRoles).values({ spaceId: sp, userId: uid, roleId: `r-${sp}` }).run();
      testDb.insert(schema.channelOverrides).values({ channelId: `c-${sp}`, targetType: 'member', targetId: uid, allow: '1', deny: '0' }).run();
    }
  }
}

const rolesOf = (uid: string, sp: string) =>
  testDb.select().from(schema.memberRoles).where(eq(schema.memberRoles.userId, uid)).all().filter(r => r.spaceId === sp);
const overridesOf = (uid: string, sp: string) =>
  testDb.select().from(schema.channelOverrides).where(eq(schema.channelOverrides.targetId, uid)).all().filter(o => o.channelId === `c-${sp}`);

beforeEach(() => {
  const sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  seed();
});

describe('removeUserFromSpace', () => {
  it('a bot leaves no roles and no member overrides in that space, and keeps the other space intact', async () => {
    const { removeUserFromSpace } = await import('./spaceMembership.js');
    removeUserFromSpace(SPACE, 'bot');
    expect(rolesOf('bot', SPACE)).toEqual([]);
    expect(overridesOf('bot', SPACE)).toEqual([]);
    expect(rolesOf('bot', OTHER_SPACE)).toHaveLength(1);
    expect(overridesOf('bot', OTHER_SPACE)).toHaveLength(1);
  });

  it('a person keeps their roles and overrides, as before', async () => {
    const { removeUserFromSpace } = await import('./spaceMembership.js');
    removeUserFromSpace(SPACE, 'person');
    expect(rolesOf('person', SPACE)).toHaveLength(1);
    expect(overridesOf('person', SPACE)).toHaveLength(1);
  });
});
