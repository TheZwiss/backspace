import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

import { inviteStatus, generateInviteToken, createInvite, getInviteByToken, listInvites, listRedemptions } from './inviteService.js';
import { eq } from 'drizzle-orm';

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

function seedAdmin(): string {
  const adminId = 'admin-user-1';
  testDb.insert(schema.users).values({
    id: adminId,
    username: 'admin',
    passwordHash: 'x',
    isAdmin: 1,
    createdAt: Date.now(),
  }).run();
  return adminId;
}

describe('inviteStatus', () => {
  const base = { revokedAt: null, expiresAt: null, maxUses: null, usedCount: 0 };

  it('returns active for a fresh invite', () => {
    expect(inviteStatus(base)).toBe('active');
  });

  it('returns revoked when revokedAt is set', () => {
    expect(inviteStatus({ ...base, revokedAt: 100 })).toBe('revoked');
  });

  it('returns expired when expiresAt is past', () => {
    expect(inviteStatus({ ...base, expiresAt: Date.now() - 1000 })).toBe('expired');
  });

  it('returns active when expiresAt is future', () => {
    expect(inviteStatus({ ...base, expiresAt: Date.now() + 100_000 })).toBe('active');
  });

  it('returns exhausted when usedCount >= maxUses', () => {
    expect(inviteStatus({ ...base, maxUses: 5, usedCount: 5 })).toBe('exhausted');
    expect(inviteStatus({ ...base, maxUses: 5, usedCount: 6 })).toBe('exhausted');
  });

  it('returns active when usedCount < maxUses', () => {
    expect(inviteStatus({ ...base, maxUses: 5, usedCount: 4 })).toBe('active');
  });

  it('revoked beats expired', () => {
    expect(inviteStatus({ ...base, revokedAt: 100, expiresAt: Date.now() - 1000 })).toBe('revoked');
  });

  it('expired beats exhausted', () => {
    expect(inviteStatus({ ...base, expiresAt: Date.now() - 1000, maxUses: 5, usedCount: 5 })).toBe('expired');
  });

  it('treats maxUses null as unlimited', () => {
    expect(inviteStatus({ ...base, maxUses: null, usedCount: 1_000_000 })).toBe('active');
  });
});

describe('generateInviteToken', () => {
  it('returns 22-char base64url string', () => {
    const t = generateInviteToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('returns different tokens on subsequent calls', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
  });
});

describe('createInvite', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it('creates an invite with required fields', () => {
    const adminId = seedAdmin();
    const invite = createInvite({ name: 'Friends batch 1', maxUses: 10, expiresAt: Date.now() + 86_400_000 }, adminId);
    expect(invite.name).toBe('Friends batch 1');
    expect(invite.maxUses).toBe(10);
    expect(invite.usedCount).toBe(0);
    expect(invite.revokedAt).toBeNull();
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(invite.status).toBe('active');
    expect(invite.createdBy).toBe(adminId);
    expect(invite.createdByUsername).toBe('admin');
  });

  it('accepts null maxUses (unlimited)', () => {
    const adminId = seedAdmin();
    const invite = createInvite({ name: 'unlimited', maxUses: null, expiresAt: null }, adminId);
    expect(invite.maxUses).toBeNull();
    expect(invite.expiresAt).toBeNull();
    expect(invite.status).toBe('active');
  });

  it('rejects empty name', () => {
    const adminId = seedAdmin();
    expect(() => createInvite({ name: '', maxUses: null, expiresAt: null }, adminId)).toThrow();
  });

  it('rejects name longer than 64 chars', () => {
    const adminId = seedAdmin();
    expect(() => createInvite({ name: 'x'.repeat(65), maxUses: null, expiresAt: null }, adminId)).toThrow();
  });

  it('rejects non-positive maxUses', () => {
    const adminId = seedAdmin();
    expect(() => createInvite({ name: 'a', maxUses: 0, expiresAt: null }, adminId)).toThrow();
    expect(() => createInvite({ name: 'a', maxUses: -1, expiresAt: null }, adminId)).toThrow();
  });

  it('rejects past expiresAt', () => {
    const adminId = seedAdmin();
    expect(() => createInvite({ name: 'a', maxUses: null, expiresAt: Date.now() - 1000 }, adminId)).toThrow();
  });
});

describe('getInviteByToken', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it('returns the invite when token matches', () => {
    const adminId = seedAdmin();
    const created = createInvite({ name: 'a', maxUses: null, expiresAt: null }, adminId);
    const found = getInviteByToken(created.token);
    expect(found?.id).toBe(created.id);
  });

  it('returns null when token has invalid format', () => {
    expect(getInviteByToken('tooshort')).toBeNull();
    expect(getInviteByToken('nonexistent_token_aaaaaa')).toBeNull(); // 24 chars
  });

  it('returns null when token is well-formed but not in DB', () => {
    expect(getInviteByToken('aaaaaaaaaaaaaaaaaaaaaa')).toBeNull(); // 22 chars, valid format
  });
});

describe('listInvites', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it('returns active invites only with status=active', () => {
    const adminId = seedAdmin();
    const a = createInvite({ name: 'active1', maxUses: null, expiresAt: null }, adminId);
    const b = createInvite({ name: 'active2', maxUses: 1, expiresAt: null }, adminId);
    // Manually exhaust b
    testDb.update(schema.inviteLinks).set({ usedCount: 1 }).where(eq(schema.inviteLinks.id, b.id)).run();

    const list = listInvites('active');
    expect(list.map(i => i.id)).toEqual([a.id]);
  });

  it('returns archived invites only with status=archived', () => {
    const adminId = seedAdmin();
    createInvite({ name: 'active', maxUses: null, expiresAt: null }, adminId);
    const exhausted = createInvite({ name: 'exhausted', maxUses: 1, expiresAt: null }, adminId);
    testDb.update(schema.inviteLinks).set({ usedCount: 1 }).where(eq(schema.inviteLinks.id, exhausted.id)).run();
    const revoked = createInvite({ name: 'revoked', maxUses: null, expiresAt: null }, adminId);
    testDb.update(schema.inviteLinks).set({ revokedAt: Date.now() }).where(eq(schema.inviteLinks.id, revoked.id)).run();

    const list = listInvites('archived');
    expect(list.map(i => i.id).sort()).toEqual([exhausted.id, revoked.id].sort());
    expect(list.find(i => i.id === exhausted.id)?.status).toBe('exhausted');
    expect(list.find(i => i.id === revoked.id)?.status).toBe('revoked');
  });

  it('JOIN surfaces createdByUsername; tombstoned creator -> "Deleted User"', () => {
    const adminId = seedAdmin();
    createInvite({ name: 'i1', maxUses: null, expiresAt: null }, adminId);
    // Tombstone admin
    testDb.update(schema.users).set({ isDeleted: 1, username: '!deleted:' + adminId }).where(eq(schema.users.id, adminId)).run();

    const list = listInvites('active');
    expect(list[0]?.createdByUsername).toBe('Deleted User');
  });

  it('sorts by createdAt DESC', async () => {
    const adminId = seedAdmin();
    const a = createInvite({ name: 'first', maxUses: null, expiresAt: null }, adminId);
    await new Promise(r => setTimeout(r, 5));
    const b = createInvite({ name: 'second', maxUses: null, expiresAt: null }, adminId);
    const list = listInvites('active');
    expect(list.map(i => i.id)).toEqual([b.id, a.id]);
  });
});

describe('listRedemptions', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it('returns redemption rows with currentUsername joined', () => {
    const adminId = seedAdmin();
    const invite = createInvite({ name: 'i', maxUses: null, expiresAt: null }, adminId);
    const userId = 'user-1';
    testDb.insert(schema.users).values({ id: userId, username: 'alice', passwordHash: 'x', createdAt: Date.now() }).run();
    testDb.insert(schema.inviteRedemptions).values({
      id: 'red-1',
      inviteId: invite.id,
      userId,
      registrantUsername: 'alice',
      redeemedAt: Date.now(),
    }).run();

    const list = listRedemptions(invite.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.registrantUsername).toBe('alice');
    expect(list[0]?.currentUsername).toBe('alice');
    expect(list[0]?.isDeleted).toBe(false);
  });

  it('marks tombstoned users with currentUsername="Deleted User" and isDeleted=true', () => {
    const adminId = seedAdmin();
    const invite = createInvite({ name: 'i', maxUses: null, expiresAt: null }, adminId);
    const userId = 'user-2';
    testDb.insert(schema.users).values({ id: userId, username: 'bob', passwordHash: 'x', isDeleted: 1, createdAt: Date.now() }).run();
    testDb.insert(schema.inviteRedemptions).values({
      id: 'red-2',
      inviteId: invite.id,
      userId,
      registrantUsername: 'bob',
      redeemedAt: Date.now(),
    }).run();

    const list = listRedemptions(invite.id);
    expect(list[0]?.currentUsername).toBe('Deleted User');
    expect(list[0]?.isDeleted).toBe(true);
  });

  it('handles null userId (hard-deleted user)', () => {
    const adminId = seedAdmin();
    const invite = createInvite({ name: 'i', maxUses: null, expiresAt: null }, adminId);
    testDb.insert(schema.inviteRedemptions).values({
      id: 'red-3',
      inviteId: invite.id,
      userId: null,
      registrantUsername: 'ghost',
      redeemedAt: Date.now(),
    }).run();

    const list = listRedemptions(invite.id);
    expect(list[0]?.userId).toBeNull();
    expect(list[0]?.currentUsername).toBeNull();
    expect(list[0]?.isDeleted).toBe(false);
  });
});
