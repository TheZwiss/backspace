import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';

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

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function insertUser(overrides: Partial<typeof schema.users.$inferInsert>): string {
  const id = overrides.id ?? `u-${Math.random().toString(36).slice(2, 10)}`;
  testDb
    .insert(schema.users)
    .values({
      id,
      username: overrides.username ?? `user-${id}`,
      passwordHash: overrides.passwordHash ?? 'hash',
      status: overrides.status ?? 'offline',
      isDeleted: overrides.isDeleted ?? 0,
      homeInstance: overrides.homeInstance ?? null,
      homeUserId: overrides.homeUserId ?? null,
      createdAt: overrides.createdAt ?? Date.now(),
      ...overrides,
    } as typeof schema.users.$inferInsert)
    .run();
  return id;
}

function getStatus(id: string): string | null {
  const row = testDb
    .select({ status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .get();
  return row?.status ?? null;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
});

describe('resetStalePresenceOnBoot', () => {
  it('resets locally-homed online users to offline', async () => {
    const aliceId = insertUser({ username: 'alice', status: 'online' });
    const { resetStalePresenceOnBoot } = await import('./presenceBoot.js');

    const changed = resetStalePresenceOnBoot();

    expect(changed).toBe(1);
    expect(getStatus(aliceId)).toBe('offline');
  });

  it('resets locally-homed idle and dnd users to offline', async () => {
    const idleId = insertUser({ username: 'idle-user', status: 'idle' });
    const dndId = insertUser({ username: 'dnd-user', status: 'dnd' });
    const { resetStalePresenceOnBoot } = await import('./presenceBoot.js');

    const changed = resetStalePresenceOnBoot();

    expect(changed).toBe(2);
    expect(getStatus(idleId)).toBe('offline');
    expect(getStatus(dndId)).toBe('offline');
  });

  it('does not modify replicated (federated) user rows', async () => {
    const localId = insertUser({ username: 'local', status: 'online' });
    const remoteOnlineId = insertUser({
      username: 'remote-online',
      status: 'online',
      homeInstance: 'orbit.example',
      homeUserId: 'remote-uid-1',
    });
    const remoteIdleId = insertUser({
      username: 'remote-idle',
      status: 'idle',
      homeInstance: 'nova.example',
      homeUserId: 'remote-uid-2',
    });
    const remoteDndId = insertUser({
      username: 'remote-dnd',
      status: 'dnd',
      homeInstance: 'orbit.example',
      homeUserId: 'remote-uid-3',
    });
    const { resetStalePresenceOnBoot } = await import('./presenceBoot.js');

    const changed = resetStalePresenceOnBoot();

    expect(changed).toBe(1);
    expect(getStatus(localId)).toBe('offline');
    // Replicated rows must keep their projected remote status untouched.
    expect(getStatus(remoteOnlineId)).toBe('online');
    expect(getStatus(remoteIdleId)).toBe('idle');
    expect(getStatus(remoteDndId)).toBe('dnd');
  });

  it('does not modify soft-deleted (tombstoned) users', async () => {
    const tombstonedId = insertUser({
      username: 'gone',
      status: 'online',
      isDeleted: 1,
    });
    const { resetStalePresenceOnBoot } = await import('./presenceBoot.js');

    const changed = resetStalePresenceOnBoot();

    expect(changed).toBe(0);
    // Tombstoned rows are excluded from presence broadcasts; their stored
    // status must not be silently rewritten by a maintenance task.
    expect(getStatus(tombstonedId)).toBe('online');
  });

  it('leaves already-offline users untouched', async () => {
    const offId = insertUser({ username: 'off', status: 'offline' });
    const { resetStalePresenceOnBoot } = await import('./presenceBoot.js');

    const changed = resetStalePresenceOnBoot();

    expect(changed).toBe(0);
    expect(getStatus(offId)).toBe('offline');
  });

  it('is idempotent — second call after the first changes nothing', async () => {
    insertUser({ username: 'a', status: 'online' });
    insertUser({ username: 'b', status: 'idle' });
    const { resetStalePresenceOnBoot } = await import('./presenceBoot.js');

    expect(resetStalePresenceOnBoot()).toBe(2);
    expect(resetStalePresenceOnBoot()).toBe(0);
  });

  it('handles a mixed population correctly', async () => {
    // Locally-homed: should reset 'online' and 'dnd'
    const localOnline = insertUser({ username: 'lo', status: 'online' });
    const localDnd = insertUser({ username: 'ld', status: 'dnd' });
    const localOffline = insertUser({ username: 'loff', status: 'offline' });
    // Federated: should be untouched regardless of status
    const remote = insertUser({
      username: 'rem',
      status: 'online',
      homeInstance: 'peer.example',
      homeUserId: 'peer-1',
    });
    // Tombstoned local: untouched
    const tomb = insertUser({
      username: 'tomb',
      status: 'online',
      isDeleted: 1,
    });

    const { resetStalePresenceOnBoot } = await import('./presenceBoot.js');
    const changed = resetStalePresenceOnBoot();

    expect(changed).toBe(2);
    expect(getStatus(localOnline)).toBe('offline');
    expect(getStatus(localDnd)).toBe('offline');
    expect(getStatus(localOffline)).toBe('offline');
    expect(getStatus(remote)).toBe('online');
    expect(getStatus(tomb)).toBe('online');
  });
});
