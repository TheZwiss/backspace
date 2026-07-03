import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  schema,
}));

vi.mock('./federationAuth.js', async () => {
  const actual = await vi.importActual<typeof import('./federationAuth.js')>('./federationAuth.js');
  return {
    ...actual,
    getOurOrigin: () => 'https://local.example',
    generateHmacSecret: () => 'mock-hmac-secret',
  };
});

vi.mock('../routes/federation.js', () => ({
  validateOrigin: (raw: string) => {
    try {
      const url = new URL(raw);
      return url.origin;
    } catch {
      return null;
    }
  },
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    sendToUser: vi.fn(),
    getAllOnlineUserIds: () => [],
  },
}));

vi.mock('./federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(async () => undefined),
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

function seedInstanceSettings(): void {
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceName: 'Local Backspace',
    instanceId: 'test-epoch-local',
    autoAcceptPeering: 1,
    registrationOpen: 1,
    updatedAt: Date.now(),
  }).run();
}

describe('performHandshake — persist remote instanceName', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('writes remote.instanceName from response body when handshake succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ accepted: true, instanceName: 'Remote Backspace' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const { ensurePeered, _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
    const result = await ensurePeered('https://remote.example', { kind: 'system' });

    expect(result.status).toBe('active');
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.instanceName).toBe('Remote Backspace');
    expect(row?.status).toBe('active');
  });

  it('writes null instanceName when remote response omits the field (old peer)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));

    const { ensurePeered, _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
    const result = await ensurePeered('https://remote.example', { kind: 'system' });

    expect(result.status).toBe('active');
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.instanceName).toBeNull();
    expect(row?.status).toBe('active');
  });

  it('does not crash when remote returns non-JSON body on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ));

    const { ensurePeered, _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
    const result = await ensurePeered('https://remote.example', { kind: 'system' });

    expect(result.status).toBe('active');
    const row = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(row?.status).toBe('active');
    expect(row?.instanceName).toBeNull();
  });
});
