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
import { config } from '../config.js';

setWorkerId(3);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable state — see invites.test.ts for the rationale on why
// the `getDb` mock closes over a getter rather than the binding directly.
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

// The real config with a mutable directory block, so the directoryAvailable
// tests can switch the endpoint off; beforeEach puts it back. Everything else
// (version in particular) stays real, so the version assertion below still
// compares against the package manifest and not against a fixture.
const mockDirectory = vi.hoisted(() => ({ endpoint: 'https://hub.test' }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { config: { ...actual.config, directory: mockDirectory } };
});

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
  const { instanceRoutes } = await import('./instance.js');
  const f = Fastify();
  await f.register(instanceRoutes);
  return f;
}

beforeEach(async () => {
  mockDirectory.endpoint = 'https://hub.test';
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  // Seed the singleton instance_settings row mirroring ensureDefaults() —
  // tests don't run the boot-time helper, so we insert manually with the
  // schema-default values for the new federatedRegistrationOpen column plus
  // the persistent epoch (instanceId) that ensureDefaults mints on boot.
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
    updatedAt: Date.now(),
  }).run();

  app = await buildApp();
});

describe('GET /api/instance/info', () => {
  it('includes federatedRegistrationOpen (default true)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instance/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.federatedRegistrationOpen).toBe(true);
  });

  it('reflects federatedRegistrationOpen=false when toggled off', async () => {
    testDb.update(schema.instanceSettings)
      .set({ federatedRegistrationOpen: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/instance/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.federatedRegistrationOpen).toBe(false);
  });

  it('returns the full contract: name, version, registrationOpen, federatedRegistrationOpen, sourceCodeUrl, commit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instance/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.name).toBe('string');
    // Asserted by value, not by type. `typeof === 'string'` passed happily
    // while this endpoint reported a hardcoded 1.0.0 through two releases, so a
    // type check here is not coverage. config.version is read from
    // packages/server/package.json; see test/version-consistency.test.ts.
    expect(body.version).toBe(config.version);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof body.registrationOpen).toBe('boolean');
    expect(typeof body.federatedRegistrationOpen).toBe('boolean');
    // AGPL § 13 source offer — always a URL; commit is a string or null.
    expect(typeof body.sourceCodeUrl).toBe('string');
    expect(body.sourceCodeUrl).toMatch(/^https?:\/\//);
    expect(body.commit === null || typeof body.commit === 'string').toBe(true);
    // Persistent per-instance epoch (incarnation UUID) is always advertised.
    expect(typeof body.instanceId).toBe('string');
    expect(body.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports directoryEnabled=false by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instance/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json().directoryEnabled).toBe(false);
  });

  it('reports directoryEnabled=true when the admin turned the directory on', async () => {
    testDb.update(schema.instanceSettings)
      .set({ directoryEnabled: 1 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/instance/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json().directoryEnabled).toBe(true);
  });

  // directoryAvailable is whether this instance can browse the directory at
  // all (DIRECTORY_ENDPOINT non-empty). It is independent of directoryEnabled,
  // the admin's listing opt-in: a fresh instance that lists nothing must still
  // be able to browse.
  it('reports directoryAvailable=true when an endpoint is configured, whatever the listing toggle', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instance/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ directoryAvailable: true, directoryEnabled: false });
  });

  it('reports directoryAvailable=false when DIRECTORY_ENDPOINT is empty, even with listing on', async () => {
    mockDirectory.endpoint = '';
    testDb.update(schema.instanceSettings)
      .set({ directoryEnabled: 1 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/instance/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ directoryAvailable: false, directoryEnabled: true });
  });

  // The second half of directoryAvailable: the admin's own switch for whether
  // the people here browse at all. The endpoint sits above it, so no setting
  // can report a directory this instance cannot reach.
  it('reports directoryAvailable=false when the admin turned browsing off', async () => {
    testDb.update(schema.instanceSettings)
      .set({ directoryBrowseEnabled: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/instance/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json().directoryAvailable).toBe(false);
  });

  it('reports directoryAvailable=true again once browsing is switched back on', async () => {
    testDb.update(schema.instanceSettings)
      .set({ directoryBrowseEnabled: 0 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();
    expect((await app.inject({ method: 'GET', url: '/api/instance/info' })).json().directoryAvailable).toBe(false);

    testDb.update(schema.instanceSettings)
      .set({ directoryBrowseEnabled: 1 })
      .where(eq(schema.instanceSettings.id, 1))
      .run();
    expect((await app.inject({ method: 'GET', url: '/api/instance/info' })).json().directoryAvailable).toBe(true);
  });

  it('reports directoryAvailable=false with no endpoint whatever the browse setting says', async () => {
    mockDirectory.endpoint = '';
    for (const directoryBrowseEnabled of [0, 1]) {
      testDb.update(schema.instanceSettings)
        .set({ directoryBrowseEnabled })
        .where(eq(schema.instanceSettings.id, 1))
        .run();
      const res = await app.inject({ method: 'GET', url: '/api/instance/info' });
      expect(res.json().directoryAvailable).toBe(false);
    }
  });

  it('browses by default: a fresh row has the setting on', async () => {
    const row = testDb.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    expect(row?.directoryBrowseEnabled).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/instance/info' })).json().directoryAvailable).toBe(true);
  });
});
