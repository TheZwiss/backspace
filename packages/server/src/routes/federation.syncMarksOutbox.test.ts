import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signRequest } from '../utils/federationAuth.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A peer that pulls `/api/federation/sync` may receive, from the mutation log,
 * an event that still sits unsent in our outbox for it. Serving a page marks
 * that peer's queued rows of the pulled context as offered, so the outbox no
 * longer treats them as never delivered (it would otherwise drop a delete
 * together with a create the peer now holds).
 */

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const HOME_ORIGIN = 'https://home.test';
const ORBIT_ORIGIN = 'https://orbit.test';
const SECRET = 'c'.repeat(64);

let sqlite: Database.Database;
let db: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => db,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => HOME_ORIGIN };
});

function applyMigrations(target: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) target.exec(clean);
    }
  }
}

function seedOutboxRow(id: string, peerId: string, contextType: string): void {
  db.insert(schema.federationOutbox).values({
    id,
    peerId,
    contextId: 'ctx',
    entityId: `entity-${id}`,
    queueKey: `message:entity-${id}`,
    contextType,
    eventType: contextType === 'dm' ? 'create' : 'profile_update',
    payload: '{}',
    encryptionVersion: 0,
    attempts: 0,
    nextRetryAt: Date.now(),
    expiresAt: Date.now() + 1_000_000,
    createdAt: Date.now() - 10,
  }).run();
}

function offeredAt(id: string): number | null {
  const row = sqlite.prepare('SELECT offered_at AS offeredAt FROM federation_outbox WHERE id = ?').get(id) as { offeredAt: number | null };
  return row.offeredAt;
}

async function orbitPulls(app: FastifyInstance, contextType?: 'friend' | 'profile'): Promise<void> {
  const body = JSON.stringify({ sinceTimestamp: 0, limit: 100, ...(contextType ? { contextType } : {}) });
  const timestamp = Date.now();
  const nonce = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/api/federation/sync',
    headers: {
      'X-Federation-Origin': ORBIT_ORIGIN,
      'X-Federation-Timestamp': String(timestamp),
      'X-Federation-Nonce': nonce,
      'X-Federation-Signature': `sha256=${signRequest(body, SECRET, timestamp, nonce)}`,
      'Content-Type': 'application/json',
    },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
}

describe('POST /api/federation/sync marks the pulling peer\'s queued rows as offered', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    for (const [id, origin] of [['peer-orbit', ORBIT_ORIGIN], ['peer-other', 'https://other.test']] as const) {
      db.insert(schema.federationPeers).values({
        id, origin, hmacSecret: SECRET, status: 'active', createdAt: Date.now(),
      }).run();
    }
    seedOutboxRow('dm-for-orbit', 'peer-orbit', 'dm');
    seedOutboxRow('profile-for-orbit', 'peer-orbit', 'profile');
    seedOutboxRow('dm-for-other', 'peer-other', 'dm');

    app = Fastify({ logger: false });
    const { _resetLookupRateBuckets, federationRoutes } = await import('./federation.js');
    _resetLookupRateBuckets();
    await app.register(federationRoutes);
    await app.ready();
  });

  it('marks the DM rows when the DM log is pulled, and only those of the puller', async () => {
    await orbitPulls(app);
    expect(offeredAt('dm-for-orbit')).not.toBeNull();
    expect(offeredAt('profile-for-orbit')).toBeNull();
    expect(offeredAt('dm-for-other')).toBeNull();
  });

  it('marks the profile rows when the profile log is pulled', async () => {
    await orbitPulls(app, 'profile');
    expect(offeredAt('profile-for-orbit')).not.toBeNull();
    expect(offeredAt('dm-for-orbit')).toBeNull();
  });
});
