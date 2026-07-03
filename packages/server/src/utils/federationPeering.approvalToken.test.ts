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
  onPeerDeactivated: vi.fn(async () => undefined),
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

describe('performHandshake — approval token capture & clear', () => {
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seedInstanceSettings();
    const { _clearInFlightPeering } = await import('./federationPeering.js');
    _clearInFlightPeering();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('stores approvalToken on the peer row when remote returns 202 with token', async () => {
    const fakeToken = 'a'.repeat(64);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ queued: true, message: 'queued', approvalToken: fakeToken }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://remote.example', { kind: 'system' });

    expect(result.status).toBe('pending');

    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('awaiting_approval');
    expect(peer?.approvalToken).toBe(fakeToken);
  });

  it('stores null approvalToken when 202 omits the field (legacy receiver)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ queued: true, message: 'queued' }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://legacy.example', { kind: 'system' });

    expect(result.status).toBe('pending');
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://legacy.example')).get();
    expect(peer?.status).toBe('awaiting_approval');
    expect(peer?.approvalToken).toBeNull();
  });

  it('handles non-JSON 202 body gracefully (token stays null)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 202 }),
    );

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://empty.example', { kind: 'system' });

    expect(result.status).toBe('pending');
    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://empty.example')).get();
    expect(peer?.approvalToken).toBeNull();
  });

  it('clears approvalToken on 200 activation even if previously stored', async () => {
    testDb.insert(schema.federationPeers).values({
      id: 'peer-existing',
      origin: 'https://remote.example',
      hmacSecret: 'old-secret',
      status: 'pending',
      approvalToken: 'old-token',
      createdAt: Date.now(),
    }).run();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: true, instanceName: 'Remote' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { ensurePeered } = await import('./federationPeering.js');
    const result = await ensurePeered('https://remote.example', { kind: 'system' });
    expect(result.status).toBe('active');

    const peer = testDb.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, 'https://remote.example')).get();
    expect(peer?.status).toBe('active');
    expect(peer?.approvalToken).toBeNull();
  });
});
