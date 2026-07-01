import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function seedEpoch(instanceId: string): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceId,
    updatedAt: Date.now(),
  } as typeof schema.instanceSettings.$inferInsert).run();
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  const { __resetInstanceIdCacheForTest } = await import('./federationEpoch.js');
  __resetInstanceIdCacheForTest();
});

describe('getInstanceId', () => {
  it('returns the persisted epoch', async () => {
    seedEpoch('123e4567-e89b-12d3-a456-426614174000');
    const { getInstanceId } = await import('./federationEpoch.js');
    const id = getInstanceId();
    expect(id).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('caches the value after the first read', async () => {
    seedEpoch('123e4567-e89b-12d3-a456-426614174000');
    const { getInstanceId } = await import('./federationEpoch.js');
    expect(getInstanceId()).toBe('123e4567-e89b-12d3-a456-426614174000');

    // Mutate the underlying row; a cached reader must NOT observe the change.
    testDb.update(schema.instanceSettings)
      .set({ instanceId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
      .run();
    expect(getInstanceId()).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('re-reads after __resetInstanceIdCacheForTest clears the cache', async () => {
    seedEpoch('123e4567-e89b-12d3-a456-426614174000');
    const { getInstanceId, __resetInstanceIdCacheForTest } = await import('./federationEpoch.js');
    expect(getInstanceId()).toBe('123e4567-e89b-12d3-a456-426614174000');

    testDb.update(schema.instanceSettings)
      .set({ instanceId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })
      .run();
    __resetInstanceIdCacheForTest();
    expect(getInstanceId()).toBe('ffffffff-ffff-ffff-ffff-ffffffffffff');
  });

  it('throws when the epoch is unset (invariant: ensureDefaults must run first)', async () => {
    // No row seeded — instance_settings is empty.
    const { getInstanceId } = await import('./federationEpoch.js');
    expect(() => getInstanceId()).toThrow(/instance_id is not set/);
  });
});
