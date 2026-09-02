import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt } from '../utils/auth.js';

setWorkerId(24);
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

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    setUserShowActivity: vi.fn(),
    clearUserActivities: vi.fn(),
    getUserStatus: vi.fn(() => 'online'),
    forceDisconnectUser: vi.fn(),
  },
}));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const { userRoutes } = await import('./users.js');
  const f = Fastify({ logger: false });
  await f.register(userRoutes);
  await f.ready();
  return f;
}

// Obvious fakes only — never a real hash or secret.
const LOCAL_ID = 'u-local-1';
const LOCAL_USERNAME = 'erin';
const FEDERATED_ID = 'u-fed-1';
const FEDERATED_USERNAME = 'kim@orbit.test';
const DETACHED_ID = 'u-detached-1';
const DETACHED_USERNAME = 'lee@dead.test';

const REMOTE = 'https://orbit.test';

function credential(
  userId: string,
  username: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: '/api/users/@me/federation-credential',
    headers: { authorization: `Bearer ${signJwt({ userId, username })}` },
    payload,
  });
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  applyMigrations(sqlite);
  testDb = drizzle(sqlite, { schema });

  testDb.insert(schema.users).values([
    {
      id: LOCAL_ID, username: LOCAL_USERNAME, passwordHash: 'not-a-real-hash',
      avatarColor: 'mint', homeInstance: null, createdAt: 1,
    },
    {
      id: FEDERATED_ID, username: FEDERATED_USERNAME, passwordHash: 'not-a-real-hash',
      avatarColor: 'sky', homeInstance: 'orbit.test', homeUserId: 'home-kim-1', createdAt: 1,
    },
    {
      id: DETACHED_ID, username: DETACHED_USERNAME, passwordHash: 'not-a-real-hash',
      avatarColor: 'peach', homeInstance: 'dead.test', homeUserId: 'home-lee-1',
      federationHomeOrphaned: 1, createdAt: 1,
    },
  ]).run();

  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/users/@me/federation-credential', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/@me/federation-credential',
      payload: { origin: REMOTE },
    });
    expect(res.statusCode).toBe(401);
  });

  it('issues a high-entropy secret that is not derived from the account password', async () => {
    const res = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { origin: string; secret: string; provisioned: boolean };
    expect(body.origin).toBe(REMOTE);
    expect(body.provisioned).toBe(false);
    expect(body.secret.length).toBeGreaterThanOrEqual(32);
    expect(body.secret).not.toContain('not-a-real-hash');

    const row = testDb.select().from(schema.userFederationCredentials)
      .where(and(
        eq(schema.userFederationCredentials.userId, LOCAL_ID),
        eq(schema.userFederationCredentials.origin, REMOTE),
      )).get();
    expect(row?.secret).toBe(body.secret);
    expect(row?.provisionedAt).toBeNull();
  });

  it('is first-writer-wins: a second call returns the same secret, never a fresh one', async () => {
    const first = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    const second = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    expect(second.statusCode).toBe(200);
    expect(second.json().secret).toBe(first.json().secret);

    const rows = testDb.select().from(schema.userFederationCredentials)
      .where(eq(schema.userFederationCredentials.userId, LOCAL_ID)).all();
    expect(rows).toHaveLength(1);
  });

  it('issues a DIFFERENT secret per remote origin', async () => {
    const a = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    const b = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: 'https://zeta.test' });
    expect(a.json().secret).not.toBe(b.json().secret);
  });

  it('scopes rows to the caller — one user never reads another user\'s secret', async () => {
    const mine = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    const theirs = await credential(DETACHED_ID, DETACHED_USERNAME, { origin: REMOTE });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().secret).not.toBe(mine.json().secret);
  });

  it('normalizes the origin so host-only and trailing-slash forms share one row', async () => {
    const canonical = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    const sloppy = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: 'orbit.test/' });
    expect(sloppy.statusCode).toBe(200);
    expect(sloppy.json().origin).toBe(REMOTE);
    expect(sloppy.json().secret).toBe(canonical.json().secret);
    expect(
      testDb.select().from(schema.userFederationCredentials)
        .where(eq(schema.userFederationCredentials.userId, LOCAL_ID)).all(),
    ).toHaveLength(1);
  });

  it('rejects a missing or unparseable origin', async () => {
    expect((await credential(LOCAL_ID, LOCAL_USERNAME, {})).statusCode).toBe(400);
    expect((await credential(LOCAL_ID, LOCAL_USERNAME, { origin: '   ' })).statusCode).toBe(400);
    expect((await credential(LOCAL_ID, LOCAL_USERNAME, { origin: 'ht!tp://\\/' })).statusCode).toBe(400);
  });

  it('rejects our own origin — a credential is only ever for a remote', async () => {
    const { getOurOrigin } = await import('../utils/federationAuth.js');
    const res = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: getOurOrigin() });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to issue credentials for a replicated federated account (its home does that)', async () => {
    const res = await credential(FEDERATED_ID, FEDERATED_USERNAME, { origin: 'https://zeta.test' });
    expect(res.statusCode).toBe(409);
    expect(
      testDb.select().from(schema.userFederationCredentials)
        .where(eq(schema.userFederationCredentials.userId, FEDERATED_ID)).all(),
    ).toHaveLength(0);
  });

  it('DOES issue credentials for a detached account (sovereign local, no home to ask)', async () => {
    const res = await credential(DETACHED_ID, DETACHED_USERNAME, { origin: REMOTE });
    expect(res.statusCode).toBe(200);
    expect(res.json().secret.length).toBeGreaterThanOrEqual(32);
  });

  it('markProvisioned latches the row and never rotates the stored secret', async () => {
    const first = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    expect(first.json().provisioned).toBe(false);

    const marked = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE, markProvisioned: true });
    expect(marked.json().provisioned).toBe(true);
    expect(marked.json().secret).toBe(first.json().secret);

    const reread = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    expect(reread.json().provisioned).toBe(true);

    const row = testDb.select().from(schema.userFederationCredentials)
      .where(and(
        eq(schema.userFederationCredentials.userId, LOCAL_ID),
        eq(schema.userFederationCredentials.origin, REMOTE),
      )).get();
    expect(row?.provisionedAt).toBeGreaterThan(0);
  });

  it('markProvisioned on a first call creates the row already provisioned', async () => {
    const res = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE, markProvisioned: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().provisioned).toBe(true);
  });

  it('rejects a request from a deleted account', async () => {
    testDb.update(schema.users).set({ isDeleted: 1 }).where(eq(schema.users.id, LOCAL_ID)).run();
    const res = await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    expect(res.statusCode).toBe(401);
  });
});

describe('federation credentials are scrubbed with the account', () => {
  it('tombstoneUser removes every stored remote credential for the deleted user', async () => {
    await credential(LOCAL_ID, LOCAL_USERNAME, { origin: REMOTE });
    await credential(LOCAL_ID, LOCAL_USERNAME, { origin: 'https://zeta.test' });
    // Positive control: the rows really are there before the deletion runs, so a
    // later "length 0" assertion cannot pass vacuously.
    expect(
      testDb.select().from(schema.userFederationCredentials)
        .where(eq(schema.userFederationCredentials.userId, LOCAL_ID)).all(),
    ).toHaveLength(2);

    const { tombstoneUser } = await import('../utils/userDeletion.js');
    tombstoneUser(LOCAL_ID);

    expect(
      testDb.select().from(schema.userFederationCredentials)
        .where(eq(schema.userFederationCredentials.userId, LOCAL_ID)).all(),
    ).toHaveLength(0);
  });
});
