import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(4);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable state — see invites.test.ts for the rationale on why
// the `getDb` mock closes over a getter rather than the binding directly.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;
const ADMIN_ID = 'admin-1';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = ADMIN_ID;
  },
  requireAdmin: async () => {
    // tests run as admin
  },
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

async function buildApp(): Promise<FastifyInstance> {
  const { settingsRoutes } = await import('./settings.js');
  const f = Fastify();
  await f.register(settingsRoutes);
  return f;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  // Seed the singleton instance_settings row (mirrors ensureDefaults at boot).
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    updatedAt: Date.now(),
  }).run();

  // Seed the admin user — settings routes require an authenticated admin.
  testDb.insert(schema.users).values({
    id: ADMIN_ID,
    username: 'admin',
    passwordHash: 'x',
    isAdmin: 1,
    createdAt: Date.now(),
  }).run();

  app = await buildApp();
});

describe('GET /api/settings/instance', () => {
  it('surfaces federatedRegistrationOpen (default true)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/instance' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.federatedRegistrationOpen).toBe(true);
  });

  it('reflects federatedRegistrationOpen=false when toggled off in DB', async () => {
    testDb.update(schema.instanceSettings)
      .set({ federatedRegistrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/settings/instance' });
    expect(res.statusCode).toBe(200);
    expect(res.json().federatedRegistrationOpen).toBe(false);
  });
});

describe('PATCH /api/settings/instance — federatedRegistrationOpen', () => {
  it('accepts federatedRegistrationOpen=false and persists it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings/instance',
      payload: { federatedRegistrationOpen: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().federatedRegistrationOpen).toBe(false);

    // Verify persistence
    const row = testDb.select().from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.id, 1)).get();
    expect(row?.federatedRegistrationOpen).toBe(0);
  });

  it('accepts federatedRegistrationOpen=true (re-enable)', async () => {
    testDb.update(schema.instanceSettings)
      .set({ federatedRegistrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings/instance',
      payload: { federatedRegistrationOpen: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().federatedRegistrationOpen).toBe(true);

    const row = testDb.select().from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.id, 1)).get();
    expect(row?.federatedRegistrationOpen).toBe(1);
  });

  it('rejects non-boolean federatedRegistrationOpen with 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings/instance',
      payload: { federatedRegistrationOpen: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/federatedRegistrationOpen/);
  });

  it('leaves federatedRegistrationOpen unchanged when omitted from payload', async () => {
    // First toggle the DB column to false. If the field's value comes from the
    // schema default (1) instead of the actual DB row, this test would still
    // pass for the wrong reason. Toggling to non-default then asserting the
    // non-default survives a partial PATCH proves real preservation.
    testDb.update(schema.instanceSettings)
      .set({ federatedRegistrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings/instance',
      payload: { instanceName: 'NewName' },
    });
    expect(res.statusCode).toBe(200);
    // Field still false (the partial PATCH did not touch it)
    expect(res.json().federatedRegistrationOpen).toBe(false);
    expect(res.json().instanceName).toBe('NewName');

    // Verify against the DB directly to rule out a response-shape-only fix
    const row = testDb.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    expect(row?.federatedRegistrationOpen).toBe(0);
  });
});

describe('error codes on the settings routes', () => {
  it('rejects an out-of-range maxBitrateKbps with streaming_max_bitrate_out_of_range', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/streaming', payload: { maxBitrateKbps: 10 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'streaming_max_bitrate_out_of_range',
      details: { min: 500, max: 1000000 },
      error: 'maxBitrateKbps must be between 500 and 1000000',
    });
  });

  it('names the offending resolutions in streaming_resolutions_invalid', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/streaming', payload: { allowedResolutions: [999, 720] } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('streaming_resolutions_invalid');
    expect(body.details.invalid).toBe('999');
    expect(body.details.allowed).toMatch(/native/);
  });

  it('rejects min >= max with streaming_min_bitrate_not_below_max', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/streaming', payload: { minBitrateKbps: 5000, maxBitrateKbps: 5000 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('streaming_min_bitrate_not_below_max');
  });

  it('rejects a bad matrix key with streaming_bitrate_matrix_key_invalid', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/streaming', payload: { bitrateMatrixOverrides: { bogus: 100 } } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'streaming_bitrate_matrix_key_invalid', details: { key: 'bogus' } });
  });

  it('rejects an over-long instance name with instance_name_length', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { instanceName: 'x'.repeat(33) } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'instance_name_length', details: { min: 1, max: 32 } });
  });

  it('rejects a non-boolean federatedRegistrationOpen with field_not_boolean', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { federatedRegistrationOpen: 'yes' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'field_not_boolean', details: { field: 'federatedRegistrationOpen' } });
  });

  it('rejects a bad relay TTL with relay_ttl_out_of_range', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { federationRelayTtlDays: 0 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'relay_ttl_out_of_range', details: { min: 1, max: 365 } });
  });
});
