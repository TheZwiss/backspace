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
  it('swallows a failed write and warns at most once an hour', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlite.close();

    const at = (iso: string) => new Date(iso);
    expect(() => recordConnectionActivity('u1', null, at('2026-09-06T10:00:00Z'))).not.toThrow();
    // The pong path runs every 30 seconds per socket, so a database that keeps
    // refusing the write must not flood the log.
    recordConnectionActivity('u1', null, at('2026-09-06T10:00:30Z'));
    recordConnectionActivity('u1', null, at('2026-09-06T10:59:59Z'));
    expect(warn).toHaveBeenCalledTimes(1);

    // ...and must not go silent for the life of the process either: an outage
    // that outlives the first warning has to stay visible in the log.
    recordConnectionActivity('u1', null, at('2026-09-06T11:00:00Z'));
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });
  it('stores today without touching the client on a pong', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    recordConnectionActivity('u1', { type: 'auth', token: 't', client: 'mobile' }, new Date('2026-09-06T10:00:00Z'));
    recordConnectionActivity('u1', null, new Date('2026-09-07T10:00:00Z'));
    const row = testDb.select({ d: schema.users.lastActiveDay, c: schema.users.lastClient }).from(schema.users).where(eq(schema.users.id, 'u1')).get();
    expect(row).toEqual({ d: '2026-09-07', c: 'mobile' });
  });
  it('touches the row at most once per calendar day per connection', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    const connection = {};
    const stored = () =>
      testDb.select({ d: schema.users.lastActiveDay }).from(schema.users)
        .where(eq(schema.users.id, 'u1')).get()?.d;

    recordConnectionActivity('u1', null, new Date('2026-09-06T10:00:00Z'), connection);
    expect(stored()).toBe('2026-09-06');

    // Move the row out from under the connection. A second write inside the
    // same day would put it back, so the old value surviving is the proof that
    // no statement ran, not merely that one ran and changed nothing.
    testDb.update(schema.users).set({ lastActiveDay: '1999-01-01' })
      .where(eq(schema.users.id, 'u1')).run();
    recordConnectionActivity('u1', null, new Date('2026-09-06T23:59:59Z'), connection);
    expect(stored()).toBe('1999-01-01');

    // The first pong after the day rolls over writes again. A desktop client
    // left open for a week is exactly the case the pong path exists for, and
    // it must not stop reporting on day two.
    recordConnectionActivity('u1', null, new Date('2026-09-07T00:00:01Z'), connection);
    expect(stored()).toBe('2026-09-07');
  });

  it('gives each connection its own memo and never skips the auth path', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    const first = {};
    const second = {};
    const stored = () =>
      testDb.select({ d: schema.users.lastActiveDay, c: schema.users.lastClient })
        .from(schema.users).where(eq(schema.users.id, 'u1')).get();

    recordConnectionActivity('u1', null, new Date('2026-09-06T10:00:00Z'), first);
    testDb.update(schema.users).set({ lastActiveDay: '1999-01-01' })
      .where(eq(schema.users.id, 'u1')).run();

    // A second socket for the same user carries its own memo: it has not asked
    // today, so it writes.
    recordConnectionActivity('u1', null, new Date('2026-09-06T10:00:01Z'), second);
    expect(stored()?.d).toBe('2026-09-06');

    // And an auth message is never skipped, whatever the memo holds: it carries
    // the client kind, which can differ between two connections on one day.
    testDb.update(schema.users).set({ lastActiveDay: '1999-01-01', lastClient: 'web' })
      .where(eq(schema.users.id, 'u1')).run();
    recordConnectionActivity('u1', { type: 'auth', token: 't', client: 'desktop' },
      new Date('2026-09-06T10:00:02Z'), second);
    expect(stored()).toEqual({ d: '2026-09-06', c: 'desktop' });
  });
});
