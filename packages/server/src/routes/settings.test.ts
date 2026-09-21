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
import { markDirectoryDirty } from '../directory/state.js';

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

// Spy on the dirty mark; the real readDirectoryState stays in place so the
// GET mapping is exercised against the actual columns.
vi.mock('../directory/state.js', async (orig) => ({
  ...(await orig<typeof import('../directory/state.js')>()),
  markDirectoryDirty: vi.fn(),
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

  vi.mocked(markDirectoryDirty).mockClear();
  app = await buildApp();
});

function setSettings(values: Partial<typeof schema.instanceSettings.$inferInsert>): void {
  testDb.update(schema.instanceSettings).set(values).where(eq(schema.instanceSettings.id, 1)).run();
}

function readSettings(): typeof schema.instanceSettings.$inferSelect {
  const row = testDb.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
  if (!row) throw new Error('instance_settings row missing');
  return row;
}

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

describe('directory fields on GET /api/settings/instance', () => {
  it('returns directoryEnabled, directoryLastPingAt and directoryLastError (defaults)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/instance' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      directoryEnabled: false,
      directoryLastPingAt: null,
      directoryLastError: null,
    });
  });

  it('returns the stored ping state with the error parsed', async () => {
    setSettings({
      directoryEnabled: 1,
      directoryLastPingAt: 1_700_000_000_000,
      directoryLastError: JSON.stringify({ at: 1_700_000_100_000, status: 'fetch', reason: 'unreachable' }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/settings/instance' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      directoryEnabled: true,
      directoryLastPingAt: 1_700_000_000_000,
      directoryLastError: { at: 1_700_000_100_000, status: 'fetch', reason: 'unreachable' },
    });
  });
});

describe('PATCH /api/settings/instance directory invariant', () => {
  it('rejects directoryEnabled=true while discovery is off with directory_requires_discovery', async () => {
    setSettings({ discoveryEnabled: 0 });
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { directoryEnabled: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('directory_requires_discovery');
    expect(readSettings().directoryEnabled).toBe(0);
    expect(markDirectoryDirty).not.toHaveBeenCalled();
  });

  it('rejects directoryEnabled=true when the same PATCH turns discovery off', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings/instance',
      payload: { discoveryEnabled: false, directoryEnabled: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('directory_requires_discovery');
    expect(readSettings().discoveryEnabled).toBe(1);
  });

  it('accepts directoryEnabled=true when the same PATCH turns discovery on', async () => {
    setSettings({ discoveryEnabled: 0 });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings/instance',
      payload: { discoveryEnabled: true, directoryEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ discoveryEnabled: true, directoryEnabled: true });
    expect(readSettings().directoryEnabled).toBe(1);
  });

  it('rejects a non-boolean directoryEnabled with field_not_boolean', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { directoryEnabled: 'yes' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'field_not_boolean', details: { field: 'directoryEnabled' } });
  });

  it('turning discovery off also clears directoryEnabled', async () => {
    setSettings({ directoryEnabled: 1 });
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { discoveryEnabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ discoveryEnabled: false, directoryEnabled: false });
    expect(readSettings().directoryEnabled).toBe(0);
  });

  it('ignores directoryLastPingAt and directoryLastError in the body', async () => {
    setSettings({ directoryLastPingAt: 5, directoryLastError: null });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings/instance',
      payload: { directoryLastPingAt: 99, directoryLastError: { at: 1, status: 500 } },
    });
    expect(res.statusCode).toBe(200);
    const row = readSettings();
    expect(row.directoryLastPingAt).toBe(5);
    expect(row.directoryLastError).toBeNull();
    expect(res.json().directoryLastPingAt).toBe(5);
  });
});

describe('PATCH /api/settings/instance dirty marks', () => {
  it('marks dirty when directoryEnabled changes', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { directoryEnabled: true } });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('marks dirty when discoveryEnabled changes', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { discoveryEnabled: false } });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('marks dirty when instanceName changes', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { instanceName: 'Renamed' } });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('marks dirty when federatedRegistrationOpen changes', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { federatedRegistrationOpen: false } });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('marks once when discovery off clears directory in the same write', async () => {
    setSettings({ directoryEnabled: 1 });
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { discoveryEnabled: false } });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('does not mark when the PATCH repeats the stored values', async () => {
    setSettings({ instanceName: 'Same', directoryEnabled: 1 });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings/instance',
      payload: { instanceName: 'Same', directoryEnabled: true, discoveryEnabled: true, federatedRegistrationOpen: true },
    });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).not.toHaveBeenCalled();
  });

  it('does not mark for fields outside the served document', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/instance', payload: { registrationOpen: false, autoAcceptPeering: true } });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/settings/streaming directory invariant', () => {
  it('turning discovery off also clears directoryEnabled', async () => {
    setSettings({ directoryEnabled: 1 });
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/streaming', payload: { discoveryEnabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().discoveryEnabled).toBe(false);
    expect(readSettings().directoryEnabled).toBe(0);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('marks dirty when discoveryEnabled changes without the directory being on', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings/streaming', payload: { discoveryEnabled: false } });
    expect(res.statusCode).toBe(200);
    expect(markDirectoryDirty).toHaveBeenCalledTimes(1);
  });

  it('does not mark when discoveryEnabled is unchanged or absent', async () => {
    const same = await app.inject({ method: 'PATCH', url: '/api/settings/streaming', payload: { discoveryEnabled: true } });
    expect(same.statusCode).toBe(200);
    const other = await app.inject({ method: 'PATCH', url: '/api/settings/streaming', payload: { maxFramerate: 30 } });
    expect(other.statusCode).toBe(200);
    expect(markDirectoryDirty).not.toHaveBeenCalled();
  });
});
