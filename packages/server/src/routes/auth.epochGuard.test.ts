import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { hashPassword } from '../utils/auth.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(2);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level mutable state — mirrors auth.test.ts: the getDb mock closes over
// a getter so each beforeEach can swap in a fresh in-memory DB.
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
  const { authRoutes } = await import('./auth.js');
  const f = Fastify();
  await f.register(authRoutes);
  return f;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });
  app = await buildApp();
});

describe('login: federation_home_orphaned freeze', () => {
  it('rejects login for a frozen (orphaned) federated account even with the correct password', async () => {
    // Seed a real federated account with a known password, then freeze it.
    const passwordHash = await hashPassword('correct-horse');
    testDb.insert(schema.users).values({
      id: 'user-frozen-1',
      username: 'carol@orbit.ddns.net',
      passwordHash,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'old-home-id',
      federationHomeOrphaned: 1,
      avatarColor: '#fff',
      createdAt: Date.now(),
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'carol@orbit.ddns.net', password: 'correct-horse' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Invalid username or password');
  });

  it('allows login for a non-frozen federated account with the correct password (freeze is targeted)', async () => {
    // Control: same shape, but federationHomeOrphaned = 0 must authenticate,
    // proving the freeze targets the flag rather than all federated accounts.
    const passwordHash = await hashPassword('correct-horse');
    testDb.insert(schema.users).values({
      id: 'user-ok-1',
      username: 'dave@orbit.ddns.net',
      passwordHash,
      homeInstance: 'orbit.ddns.net',
      homeUserId: 'live-home-id',
      federationHomeOrphaned: 0,
      avatarColor: '#fff',
      createdAt: Date.now(),
    }).run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'dave@orbit.ddns.net', password: 'correct-horse' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });
});
