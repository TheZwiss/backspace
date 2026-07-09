import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import {
  PermissionBits,
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  permissionsToString,
} from '@backspace/shared/src/permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const statements = sqlText.split(/-->\s*statement-breakpoint/);
    for (const stmt of statements) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const OWNER_ID = 'owner-1';
const MEMBER_ID = 'member-1';
const OUTSIDER_ID = 'outsider-1';
const ADMIN_ID = 'admin-1';
const SPACE_ID = 'space-1';
const now = 1_700_000_000_000;

function seed(): void {
  for (const [id, isAdmin] of [
    [OWNER_ID, 0],
    [MEMBER_ID, 0],
    [OUTSIDER_ID, 0],
    [ADMIN_ID, 1],
  ] as const) {
    testDb.insert(schema.users).values({
      id,
      username: id,
      passwordHash: 'x',
      isAdmin,
      createdAt: now,
    }).run();
  }

  testDb.insert(schema.spaces).values({
    id: SPACE_ID,
    name: 'Test Space',
    ownerId: OWNER_ID,
    inviteCode: 'code-1',
    visibility: 'request',
    createdAt: now,
  }).run();

  // @everyone role (id === spaceId) carries the default member permissions.
  testDb.insert(schema.roles).values({
    id: SPACE_ID,
    spaceId: SPACE_ID,
    name: '@everyone',
    permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS),
    createdAt: now,
  }).run();

  // Owner and one ordinary member are enrolled; OUTSIDER and ADMIN are not.
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: OWNER_ID, joinedAt: now }).run();
  testDb.insert(schema.spaceMembers).values({ spaceId: SPACE_ID, userId: MEMBER_ID, joinedAt: now }).run();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  seed();
});

describe('computePermissions', () => {
  it('returns 0n for a user who is not a member of the space', async () => {
    const { computePermissions } = await import('./permissions.js');
    expect(computePermissions(OUTSIDER_ID, SPACE_ID)).toBe(0n);
  });

  it('does not grant CREATE_INVITE to a non-member via @everyone', async () => {
    const { hasPermission } = await import('./permissions.js');
    expect(hasPermission(OUTSIDER_ID, SPACE_ID, PermissionBits.CREATE_INVITE)).toBe(false);
  });

  it('does not grant read access to a non-member via @everyone', async () => {
    const { hasPermission } = await import('./permissions.js');
    const read = PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY;
    expect(hasPermission(OUTSIDER_ID, SPACE_ID, read)).toBe(false);
  });

  it('grants @everyone permissions to an enrolled member', async () => {
    const { computePermissions } = await import('./permissions.js');
    const perms = computePermissions(MEMBER_ID, SPACE_ID);
    expect(perms).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    expect(perms & PermissionBits.CREATE_INVITE).toBe(PermissionBits.CREATE_INVITE);
  });

  it('grants ALL_PERMISSIONS to the space owner', async () => {
    const { computePermissions } = await import('./permissions.js');
    expect(computePermissions(OWNER_ID, SPACE_ID)).toBe(ALL_PERMISSIONS);
  });

  it('grants ALL_PERMISSIONS to an instance admin even when not a member', async () => {
    const { computePermissions } = await import('./permissions.js');
    expect(computePermissions(ADMIN_ID, SPACE_ID)).toBe(ALL_PERMISSIONS);
  });
});
