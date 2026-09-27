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

function insertUser(id: string, homeInstance: string | null, federationHomeOrphaned = 0): void {
  testDb.insert(schema.users).values({
    id,
    username: id,
    passwordHash: 'x',
    status: 'offline',
    homeInstance,
    homeUserId: homeInstance ? `home-${id}` : null,
    federationHomeOrphaned,
    createdAt: 1,
  }).run();
}

function row(id: string): { status: string | null; chosen: string } | undefined {
  return testDb
    .select({ status: schema.users.status, chosen: schema.users.chosenStatus })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .get();
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
});

describe('applyChosenStatus without a live connection', () => {
  it('stores the choice of a native account and leaves it offline', async () => {
    insertUser('native', null);
    const { applyChosenStatus } = await import('./presence.js');
    applyChosenStatus('native', 'dnd');
    expect(row('native')).toEqual({ status: 'offline', chosen: 'dnd' });
  });

  it('stores the choice of a detached account, which owns it', async () => {
    insertUser('detached', 'reset.example', 1);
    const { applyChosenStatus } = await import('./presence.js');
    applyChosenStatus('detached', 'dnd');
    expect(row('detached')).toEqual({ status: 'offline', chosen: 'dnd' });
  });

  it("never writes a replicated row's chosen status", async () => {
    insertUser('replicated', 'home.example');
    const { applyChosenStatus } = await import('./presence.js');
    applyChosenStatus('replicated', 'dnd');
    expect(row('replicated')).toEqual({ status: 'offline', chosen: 'online' });
  });
});
