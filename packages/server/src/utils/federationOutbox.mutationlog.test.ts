import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { eq } from 'drizzle-orm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../utils/federationAuth.js', () => ({
  getOurOrigin: () => 'https://test.example',
  buildFederationHeaders: () => ({}),
  generateHmacSecret: () => 'secret',
}));

let _snowflakeCounter = 1;
vi.mock('../utils/snowflake.js', () => ({
  generateSnowflake: () => String(_snowflakeCounter++),
  setWorkerId: vi.fn(),
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

function seedSettings(): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    federationRelayEnabled: 1,
    updatedAt: Date.now(),
  }).run();
}

function seedChannel(id: string, federatedId: string | null): void {
  testDb.insert(schema.dmChannels).values({
    id, federatedId, ownerId: null, createdAt: Date.now(),
  }).run();
}

function seedUser(id: string, username: string): void {
  testDb.insert(schema.users).values({
    id, username, displayName: username, passwordHash: 'x',
    createdAt: Date.now(),
  }).run();
}

function seedDmMember(channelId: string, userId: string): void {
  testDb.insert(schema.dmMembers).values({
    dmChannelId: channelId, userId, closed: 0,
  }).run();
}

describe('queueDmCloseRelay — mutation log capture', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedSettings();
  });

  it('appends a mutation log row for dm_close', async () => {
    const { queueDmCloseRelay } = await import('./federationOutbox.js');
    seedUser('u-1', 'alice');
    seedChannel('ch-1', 'fed-1');
    seedDmMember('ch-1', 'u-1');

    queueDmCloseRelay('ch-1', 'u-1', 'dm_close');

    const rows = testDb.select().from(schema.federationMutationLog)
      .where(eq(schema.federationMutationLog.mutationType, 'dm_close')).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.contextId).toBe('ch-1');
    expect(rows[0]?.contextType).toBe('dm');
  });

  it('appends a mutation log row for dm_reopen', async () => {
    const { queueDmCloseRelay } = await import('./federationOutbox.js');
    seedUser('u-1', 'alice');
    seedChannel('ch-2', 'fed-2');
    seedDmMember('ch-2', 'u-1');

    queueDmCloseRelay('ch-2', 'u-1', 'dm_reopen');

    const rows = testDb.select().from(schema.federationMutationLog)
      .where(eq(schema.federationMutationLog.mutationType, 'dm_reopen')).all();
    expect(rows.length).toBe(1);
  });
});

describe('queueReadStateRelay — mutation log capture', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedSettings();
  });

  it('appends a mutation log row for read_state_update', async () => {
    const { queueReadStateRelay } = await import('./federationOutbox.js');
    seedUser('u-2', 'bob');
    seedChannel('ch-3', 'fed-3');
    seedDmMember('ch-3', 'u-2');
    testDb.insert(schema.dmMessages).values({
      id: 'm-1', dmChannelId: 'ch-3', userId: 'u-2', content: 'hi',
      type: 'user', createdAt: Date.now(),
    }).run();

    queueReadStateRelay('ch-3', 'm-1', 'u-2');

    const rows = testDb.select().from(schema.federationMutationLog)
      .where(eq(schema.federationMutationLog.mutationType, 'read_state_update')).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.contextId).toBe('ch-3');
    expect(rows[0]?.contextType).toBe('dm');
  });
});
