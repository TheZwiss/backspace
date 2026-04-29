import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { fetchSpaceInviteSnapshot, getLocalInviteSnapshot } from './spaceInviteSnapshot';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable DB state — the vi.mock factory below closes over these
// bindings via a getter, so reassignment in beforeEach is observed.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

// Mock the ssrf module so tests don't need real DNS resolution.
// Default: validateExternalUrl resolves (allow). Individual tests override as needed.
vi.mock('./ssrf.js', () => ({
  validateExternalUrl: vi.fn().mockResolvedValue(undefined),
  isPrivateIp: vi.fn().mockReturnValue(false),
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

describe('fetchSpaceInviteSnapshot', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn() as any; });
  afterEach(() => { global.fetch = originalFetch; });

  it('returns snapshot when preview endpoint succeeds', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        spaceId: 'S1',
        spaceName: 'Aether',
        description: 'desc',
        icon: null,
        avatarColor: 'mint',
        memberCount: 12,
        instanceName: 'Backspace',
      }),
    });
    const snap = await fetchSpaceInviteSnapshot('https://z.example', 'abc123');
    expect(snap).toEqual({
      spaceId: 'S1',
      spaceName: 'Aether',
      description: 'desc',
      icon: null,
      avatarColor: 'mint',
      memberCount: 12,
      instanceName: 'Backspace',
    });
  });

  it('returns null when preview returns 404', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const snap = await fetchSpaceInviteSnapshot('https://z.example', 'badcode');
    expect(snap).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const snap = await fetchSpaceInviteSnapshot('https://z.example', 'abc123');
    expect(snap).toBeNull();
  });

  it('aborts after timeout', async () => {
    (global.fetch as any).mockImplementationOnce((_url: string, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const snap = await fetchSpaceInviteSnapshot('https://z.example', 'abc', 50);
    expect(snap).toBeNull();
  });

  it('returns null when SSRF validator rejects the origin', async () => {
    // Override the module-level mock to reject for this test only.
    const ssrf = await import('./ssrf.js');
    const spy = vi.spyOn(ssrf, 'validateExternalUrl').mockRejectedValueOnce(new Error('blocked'));
    const fetchSpy = global.fetch as any;

    const snap = await fetchSpaceInviteSnapshot('http://127.0.0.1:9200', 'abc');
    expect(snap).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();   // CRITICAL — the fetch must NOT happen

    spy.mockRestore();
  });
});

describe('getLocalInviteSnapshot', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    // Seed an owner user so the FK on spaces.ownerId is satisfied.
    testDb.insert(schema.users).values({
      id: 'owner-1',
      username: 'owner',
      displayName: null,
      passwordHash: 'x',
      status: 'offline',
      isAdmin: 0,
      isDeleted: 0,
      discoverable: 1,
      homeInstance: null,
      homeUserId: null,
      createdAt: Date.now(),
    }).run();
  });

  it('returns snapshot for an existing local invite code', () => {
    testDb.insert(schema.spaces).values({
      id: 'S1',
      name: 'Aether',
      icon: null,
      banner: null,
      avatarColor: 'mint',
      ownerId: 'owner-1',
      inviteCode: 'abc123',
      visibility: 'private',
      description: 'a calm space',
      createdAt: Date.now(),
    }).run();
    testDb.insert(schema.spaceMembers).values({
      spaceId: 'S1',
      userId: 'owner-1',
      nickname: null,
      joinedAt: Date.now(),
    }).run();
    testDb.insert(schema.instanceSettings).values({
      id: 1,
      instanceName: 'TestHost',
      updatedAt: Date.now(),
    }).run();

    const snap = getLocalInviteSnapshot('abc123');
    expect(snap).toEqual({
      spaceId: 'S1',
      spaceName: 'Aether',
      description: 'a calm space',
      icon: null,
      avatarColor: 'mint',
      memberCount: 1,
      instanceName: 'TestHost',
    });
  });

  it('returns null for unknown code', () => {
    expect(getLocalInviteSnapshot('does-not-exist')).toBeNull();
  });

  it('falls back to "Backspace" when no instance settings row exists', () => {
    testDb.insert(schema.spaces).values({
      id: 'S2',
      name: 'NoSettings',
      icon: null,
      banner: null,
      avatarColor: null,
      ownerId: 'owner-1',
      inviteCode: 'nosettings',
      visibility: 'private',
      description: null,
      createdAt: Date.now(),
    }).run();

    const snap = getLocalInviteSnapshot('nosettings');
    expect(snap).not.toBeNull();
    expect(snap?.instanceName).toBe('Backspace');
    expect(snap?.memberCount).toBe(0);
  });
});
