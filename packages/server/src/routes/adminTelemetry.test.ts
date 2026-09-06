import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { ensureDefaults } from '../db/migrate.js';
import { setWorkerId } from '../utils/snowflake.js';

// Auth is mocked the way adminUpdates.test.ts mocks it: the contract under test
// is the admin gate, the response shapes and the id lifecycle, not JWT
// verification (covered in auth.test.ts). The database is real, because every
// route here reads or writes instance_settings.
setWorkerId(3);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;
let callerIsAdmin = true;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.headers.authorization) {
      return reply.code(401).send({ error: 'Missing or invalid authorization header', statusCode: 401 });
    }
    (request as FastifyRequest & { userId: string }).userId = 'admin';
  },
  requireAdmin: async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!callerIsAdmin) {
      return reply.code(403).send({ error: 'Only instance admins can perform this action', statusCode: 403 });
    }
  },
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

function stateRow(): {
  telemetry_enabled: number | null;
  telemetry_id: string | null;
  telemetry_last_day: string | null;
} {
  return sqlite.prepare(
    'SELECT telemetry_enabled, telemetry_id, telemetry_last_day FROM instance_settings WHERE id = 1',
  ).get() as { telemetry_enabled: number | null; telemetry_id: string | null; telemetry_last_day: string | null };
}

let app: FastifyInstance;
const AUTH = { authorization: 'Bearer token' };

beforeEach(async () => {
  callerIsAdmin = true;
  sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  ensureDefaults(sqlite);
  testDb = drizzle(sqlite, { schema });
  const { adminTelemetryRoutes } = await import('./adminTelemetry.js');
  app = Fastify();
  await app.register(adminTelemetryRoutes);
});

describe('admin telemetry routes', () => {
  it('requires an admin', async () => {
    callerIsAdmin = false;
    for (const url of ['/api/admin/telemetry', '/api/admin/telemetry/preview']) {
      const res = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode).toBe(403);
    }
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: true },
    });
    expect(put.statusCode).toBe(403);
    expect(stateRow().telemetry_enabled).toBeNull();
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/telemetry' });
    expect(res.statusCode).toBe(401);
  });

  it('reads the never-asked state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/telemetry', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: null, id: null, lastDay: null, lastError: null });
  });

  it('mints an id on the first enable and keeps it on a repeated save', async () => {
    const first = await app.inject({
      method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: true },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { enabled: boolean; id: string; lastDay: string; lastError: null };
    expect(body.enabled).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body.lastDay).toBe(new Date().toISOString().slice(0, 10));
    expect(body.lastError).toBeNull();

    const again = await app.inject({
      method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: true },
    });
    expect(again.json()).toEqual(body);
    expect(stateRow().telemetry_id).toBe(body.id);
  });

  it('clears the id when switched off', async () => {
    await app.inject({ method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: true } });
    const res = await app.inject({
      method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, id: null, lastDay: null, lastError: null });
    expect(stateRow()).toMatchObject({ telemetry_enabled: 0, telemetry_id: null });
  });

  it('rejects a body without a boolean', async () => {
    for (const payload of [{ enabled: 'yes' }, { enabled: 1 }, {}]) {
      const res = await app.inject({ method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'validation_failed' });
    }
    expect(stateRow().telemetry_enabled).toBeNull();
  });

  it('previews the real payload while off without writing anything', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/telemetry/preview', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      schema: 1,
      instance: 'preview',
      day: new Date().toISOString().slice(0, 10),
    });
    expect(stateRow()).toEqual({ telemetry_enabled: null, telemetry_id: null, telemetry_last_day: null });
  });

  it('previews under the real id once opted in', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/telemetry', headers: AUTH, payload: { enabled: true },
    });
    const id = (put.json() as { id: string }).id;
    const res = await app.inject({ method: 'GET', url: '/api/admin/telemetry/preview', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { instance: string }).instance).toBe(id);
  });
});
