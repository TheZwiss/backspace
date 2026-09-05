import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;
let sqlite: Database.Database;
vi.mock('../db/index.js', () => ({ getDb: () => testDb, schema }));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values({ id: 'u1', username: 'u1', passwordHash: 'x', createdAt: 1 }).run();
});

describe('recordConnectionActivity', () => {
  it('stores today and the parsed client kind on auth', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    recordConnectionActivity('u1', { type: 'auth', token: 't', client: 'desktop' }, new Date('2026-09-06T10:00:00Z'));
    const row = testDb.select({ d: schema.users.lastActiveDay, c: schema.users.lastClient }).from(schema.users).where(eq(schema.users.id, 'u1')).get();
    expect(row).toEqual({ d: '2026-09-06', c: 'desktop' });
  });
  it('swallows a failed write instead of throwing at the caller', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlite.close();
    expect(() => recordConnectionActivity('u1', null, new Date('2026-09-06T10:00:00Z'))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  it('stores today without touching the client on a pong', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    recordConnectionActivity('u1', { type: 'auth', token: 't', client: 'mobile' }, new Date('2026-09-06T10:00:00Z'));
    recordConnectionActivity('u1', null, new Date('2026-09-07T10:00:00Z'));
    const row = testDb.select({ d: schema.users.lastActiveDay, c: schema.users.lastClient }).from(schema.users).where(eq(schema.users.id, 'u1')).get();
    expect(row).toEqual({ d: '2026-09-07', c: 'mobile' });
  });
});
