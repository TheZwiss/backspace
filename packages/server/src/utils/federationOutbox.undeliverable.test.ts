import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('./federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('./federationAuth.js')>('./federationAuth.js');
  return {
    ...actual,
    getOurOrigin: () => 'https://local.example',
    buildFederationHeaders: () => ({}),
  };
});

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

function seedActivePeer(origin: string): void {
  testDb.insert(schema.federationPeers).values({
    id: `peer-${origin}`,
    origin,
    hmacSecret: 'secret',
    status: 'active',
    instanceName: 'Peer',
    lastSyncedAt: 0,
    createdAt: Date.now(),
  }).run();
}

let sqlite: Database.Database;

describe('sendCallRelay response shape', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedActivePeer('https://peer.example');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  const baseEvent = {
    eventType: 'dm_call_start' as const,
    messageId: 'msg-X',
    encryptionVersion: 0 as const,
    timestamp: Date.now(),
    federatedId: 'fed-X',
    call: {
      livekitUrl: 'wss://lk.example',
      tokens: {},
      caller: { homeUserId: 'c', homeInstance: 'https://local.example', displayName: 'C' },
      participants: [],
    },
  };

  it('returns {ok:true, undeliverable:[]} when remote omits the field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ accepted: ['msg-X'], rejected: [], maxUploadSize: 1000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const { sendCallRelay } = await import('./federationOutbox.js');
    const result = await sendCallRelay('https://peer.example', [baseEvent]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.undeliverable).toEqual([]);
    }
  });

  it('returns {ok:true, undeliverable:["msg-X"]} when remote lists it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        accepted: [],
        rejected: [],
        undeliverable: [{ messageId: 'msg-X', reason: 'no_recipient' }],
        maxUploadSize: 1000,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const { sendCallRelay } = await import('./federationOutbox.js');
    const result = await sendCallRelay('https://peer.example', [baseEvent]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.undeliverable).toEqual(['msg-X']);
    }
  });

  it('failure shape unchanged on HTTP 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('server down', { status: 503 }),
    ));

    const { sendCallRelay } = await import('./federationOutbox.js');
    const result = await sendCallRelay('https://peer.example', [baseEvent]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('peer_transient_failure');
    }
  });
});
