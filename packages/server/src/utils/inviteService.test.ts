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

import { inviteStatus, generateInviteToken, createInvite, getInviteByToken } from './inviteService.js';

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

  it('returns null when token not found', () => {
    expect(getInviteByToken('nonexistent_token_aaaaaa')).toBeNull();
  });
});
