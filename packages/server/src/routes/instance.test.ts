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
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  // Seed the singleton instance_settings row mirroring ensureDefaults() —
  // tests don't run the boot-time helper, so we insert manually with the
  // schema-default values for the new federatedRegistrationOpen column.
  testDb.insert(schema.instanceSettings).values({
    id: 1,
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
    expect(typeof body.version).toBe('string');
    expect(typeof body.registrationOpen).toBe('boolean');
    expect(typeof body.federatedRegistrationOpen).toBe('boolean');
    // AGPL § 13 source offer — always a URL; commit is a string or null.
    expect(typeof body.sourceCodeUrl).toBe('string');
    expect(body.sourceCodeUrl).toMatch(/^https?:\/\//);
    expect(body.commit === null || typeof body.commit === 'string').toBe(true);
  });
});
