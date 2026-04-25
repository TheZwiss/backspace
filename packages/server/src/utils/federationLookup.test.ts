import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

const PEER_ORIGIN = 'https://orbit.test';
const PEER_SECRET = 'a'.repeat(64);

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('./federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('./federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://home.test' };
});

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

function seedActivePeer(): void {
  testDb
    .insert(schema.federationPeers)
    .values({
      id: 'peer-1',
      origin: PEER_ORIGIN,
      hmacSecret: PEER_SECRET,
      status: 'active',
      nonceSupported: 1,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      consecutiveFailures: 0,
      consecutiveAuthFailures: 0,
    } as typeof schema.federationPeers.$inferInsert)
    .run();
}

const VALID_RESPONSE_BODY = {
  found: true,
  user: {
    homeUserId: 'remote-uid-1',
    username: 'bob',
    profile: {
      displayName: 'Bob',
      avatar: null,
      avatarColor: null,
      banner: null,
      bio: 'hello from orbit',
    },
  },
};

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  seedActivePeer();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lookupRemoteUser', () => {
  it('1. returns ok:true with homeUserId/username/profile on HTTP 200 + valid body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => VALID_RESPONSE_BODY,
    }));

    const { lookupRemoteUser } = await import('./federationLookup.js');
    const result = await lookupRemoteUser(PEER_ORIGIN, 'bob');

    expect(result).toEqual({
      ok: true,
      homeUserId: 'remote-uid-1',
      username: 'bob',
      profile: {
        displayName: 'Bob',
        avatar: null,
        avatarColor: null,
        banner: null,
        bio: 'hello from orbit',
      },
    });
  });

  it('2. returns ok:false reason:not_found on HTTP 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
    }));

    const { lookupRemoteUser } = await import('./federationLookup.js');
    const result = await lookupRemoteUser(PEER_ORIGIN, 'nobody');

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('3. returns ok:false reason:rate_limited with retryAfter on HTTP 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === 'Retry-After' ? '60' : null) },
    }));

    const { lookupRemoteUser } = await import('./federationLookup.js');
    const result = await lookupRemoteUser(PEER_ORIGIN, 'bob');

    expect(result).toEqual({ ok: false, reason: 'rate_limited', retryAfter: 60 });
  });

  it('4. returns ok:false reason:unreachable on network error (TypeError)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const { lookupRemoteUser } = await import('./federationLookup.js');
    const result = await lookupRemoteUser(PEER_ORIGIN, 'bob');

    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('5. returns ok:false reason:unreachable on AbortError (timeout)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const { lookupRemoteUser } = await import('./federationLookup.js');
    const result = await lookupRemoteUser(PEER_ORIGIN, 'bob');

    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('6. throws when no peer record exists in federation_peers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => VALID_RESPONSE_BODY,
    }));

    const { lookupRemoteUser } = await import('./federationLookup.js');
    await expect(lookupRemoteUser('https://unknown.test', 'bob')).rejects.toThrow(
      'lookupRemoteUser: no peer record for https://unknown.test',
    );
  });

  it('7. signs the request with correct HMAC headers', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        capturedInit = init;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => VALID_RESPONSE_BODY,
        });
      }),
    );

    const { lookupRemoteUser } = await import('./federationLookup.js');
    await lookupRemoteUser(PEER_ORIGIN, 'bob');

    expect(capturedInit).toBeDefined();
    const headers = capturedInit!.headers as Record<string, string>;

    // URL
    const fetchMock = (globalThis.fetch as ReturnType<typeof vi.fn>);
    expect(fetchMock).toHaveBeenCalledWith(
      `${PEER_ORIGIN}/api/federation/users/lookup`,
      expect.anything(),
    );

    // Required HMAC headers
    expect(headers['X-Federation-Origin']).toBe('https://home.test');
    expect(headers['X-Federation-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['X-Federation-Nonce']).toBeTruthy();
    expect(headers['X-Federation-Timestamp']).toMatch(/^\d+$/);
  });

  it('8. throws on malformed 200 body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ found: false, code: 'user_not_found' }),
    }));

    const { lookupRemoteUser } = await import('./federationLookup.js');
    await expect(lookupRemoteUser(PEER_ORIGIN, 'bob')).rejects.toThrow(
      `lookupRemoteUser: peer ${PEER_ORIGIN} returned malformed body`,
    );
  });
});
