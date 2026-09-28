import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';

setWorkerId(1);

/**
 * A client route waits for the identity's home only briefly. A home that does
 * not answer in time costs one short wait: the row falls back to its id name,
 * and the same identity is not asked again right away.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const fetchCalls: string[] = [];

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../ws/handler.js', () => ({
  connectionManager: { sendToUser: vi.fn(), sendToDmMembers: vi.fn(), sendToAdmins: vi.fn(), getAllOnlineUserIds: () => [] },
}));
vi.mock('./federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('./federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://test.example' };
});
// A home that accepts the connection and never answers: the request ends only
// when the caller's abort signal fires.
vi.mock('./federationFetch.js', () => ({
  federationFetch: vi.fn((origin: string, pathname: string, init: RequestInit) => {
    fetchCalls.push(`${origin}${pathname}`);
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }),
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const KAI_ID = '1234567890123456789';

describe('resolveRemoteIdentityForClient against a home that does not answer', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    fetchCalls.length = 0;
    testDb.insert(schema.federationPeers).values({
      id: 'peer-friend',
      origin: 'https://friend.example',
      hmacSecret: 'a'.repeat(64),
      status: 'active',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }).run();
    const { _resetHomeLookupCache } = await import('./federationClientIdentity.js');
    _resetHomeLookupCache();
  });

  it('gives up after the short first-contact timeout and falls back to the id-named row', async () => {
    const { resolveRemoteIdentityForClient, CLIENT_HOME_LOOKUP_TIMEOUT_MS } = await import('./federationClientIdentity.js');
    expect(CLIENT_HOME_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    const started = Date.now();
    const user = await resolveRemoteIdentityForClient(KAI_ID, 'friend.example', testDb);
    const elapsed = Date.now() - started;
    expect(user?.username).toBe(`${KAI_ID}@friend.example`);
    expect(elapsed).toBeGreaterThanOrEqual(CLIENT_HOME_LOOKUP_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(CLIENT_HOME_LOOKUP_TIMEOUT_MS + 2000);
    expect(fetchCalls).toEqual(['https://friend.example/api/federation/users/by-home-id']);
  }, 10_000);

  it('does not ask the same home again right after it did not answer', async () => {
    const { resolveRemoteIdentityForClient } = await import('./federationClientIdentity.js');
    await resolveRemoteIdentityForClient(KAI_ID, 'friend.example', testDb);
    const started = Date.now();
    const again = await resolveRemoteIdentityForClient(KAI_ID, 'friend.example', testDb);
    expect(Date.now() - started).toBeLessThan(500);
    expect(again?.username).toBe(`${KAI_ID}@friend.example`);
    expect(fetchCalls).toHaveLength(1);
  }, 10_000);
});
