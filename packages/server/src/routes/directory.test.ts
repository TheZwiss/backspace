import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { ensureDefaults } from '../db/migrate.js';
import { setWorkerId } from '../utils/snowflake.js';
import * as documentModule from '../directory/document.js';
import { markDirectoryDirty, _resetDirectoryStateForTests } from '../directory/state.js';

setWorkerId(5);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('./federation/origin.js', () => ({
  resolveLocalOrigin: () => 'https://home.test',
}));

vi.mock('../config.js', () => ({
  config: { version: '1.4.0', directory: { endpoint: 'https://hub.test' } },
}));

// Passthrough mock so the builder export lives on a plain object vi.spyOn can wrap.
vi.mock('../directory/document.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../directory/document.js')>();
  return { ...actual };
});

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const { directoryRoutes, _resetDirectoryRouteCacheForTests } = await import('./directory.js');
  _resetDirectoryRouteCacheForTests();
  const f = Fastify({ logger: false });
  await f.register(directoryRoutes);
  await f.ready();
  return f;
}

const T0 = new Date('2026-09-22T12:00:00Z').getTime();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  ensureDefaults(sqlite);
  testDb = drizzle(sqlite, { schema });
  _resetDirectoryStateForTests();

  sqlite.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1', 'u1', 'x', 1)").run();
  sqlite.prepare(
    `INSERT INTO spaces (id, name, owner_id, invite_code, visibility, directory_listed, created_at)
     VALUES ('A', 'Space A', 'u1', 'inv-A', 'public', 1, 1)`,
  ).run();
  sqlite.prepare("INSERT INTO space_members (space_id, user_id, joined_at) VALUES ('A', 'u1', 1)").run();
  sqlite.prepare(
    "UPDATE instance_settings SET instance_name = 'Example', discovery_enabled = 1, directory_enabled = 1 WHERE id = 1",
  ).run();

  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GET /api/directory/spaces', () => {
  it('serves the document without authentication and marks it cacheable for 30 s', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    expect(JSON.parse(res.body)).toEqual({
      schema: 1,
      origin: 'https://home.test',
      instance: { name: 'Example', federatedRegistrationOpen: true, version: '1.4.0' },
      spaces: [
        {
          id: 'A',
          name: 'Space A',
          description: null,
          icon: null,
          banner: null,
          avatarColor: null,
          visibility: 'public',
          memberCount: 1,
          createdAt: 1,
        },
      ],
    });
  });

  it('builds once for two requests inside 30 s', async () => {
    const spy = vi.spyOn(documentModule, 'buildDirectoryDocument');
    await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    vi.setSystemTime(T0 + 29_000);
    const second = await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    expect(second.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds on the next request after markDirectoryDirty', async () => {
    const spy = vi.spyOn(documentModule, 'buildDirectoryDocument');
    await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    sqlite.prepare("UPDATE spaces SET directory_listed = 0 WHERE id = 'A'").run();
    markDirectoryDirty(sqlite);
    const res = await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(res.body).spaces).toEqual([]);
  });

  it('rebuilds on the next request once 30 s have passed', async () => {
    const spy = vi.spyOn(documentModule, 'buildDirectoryDocument');
    await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    vi.setSystemTime(T0 + 30_000);
    await app.inject({ method: 'GET', url: '/api/directory/spaces' });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
