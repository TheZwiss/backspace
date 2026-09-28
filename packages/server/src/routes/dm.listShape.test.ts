import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import type { DmChannel } from '@backspace/shared';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

const ME = 'user-me';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  schema,
}));

vi.mock('../utils/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/auth.js')>('../utils/auth.js');
  return {
    ...actual,
    authenticate: async (req: { userId?: string }) => {
      req.userId = ME;
    },
  };
});

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const now = 1_700_000_000_000;
const ONE_ON_ONE = 'dm-one';
const GROUP = 'dm-group';

function seed(): void {
  testDb.insert(schema.users).values([
    { id: ME, username: 'me', passwordHash: 'x', homeUserId: null, homeInstance: null, createdAt: now },
    { id: 'user-bob', username: 'bob', passwordHash: 'x', homeUserId: 'bob-home', homeInstance: 'remote.example', createdAt: now },
    { id: 'user-carol', username: 'carol', passwordHash: 'x', homeUserId: null, homeInstance: null, createdAt: now },
  ]).run();

  // A federated 1-on-1: every nullable column that a 1-on-1 leaves empty stays null.
  testDb.insert(schema.dmChannels).values({
    id: ONE_ON_ONE, ownerId: null, federatedId: 'f'.repeat(32), createdAt: now,
  }).run();
  // A group with every metadata column set.
  testDb.insert(schema.dmChannels).values({
    id: GROUP,
    ownerId: ME,
    federatedId: '0e0e0e0e-0000-4000-8000-000000000000',
    ownerHomeUserId: ME,
    ownerHomeInstance: 'local.example',
    name: 'Weekend plans',
    icon: '/uploads/group-icon.png',
    metadataUpdatedAt: now + 5,
    createdAt: now,
  }).run();
  testDb.insert(schema.dmMembers).values([
    { dmChannelId: ONE_ON_ONE, userId: ME, closed: 0 },
    { dmChannelId: ONE_ON_ONE, userId: 'user-bob', closed: 0 },
    { dmChannelId: GROUP, userId: ME, closed: 0 },
    { dmChannelId: GROUP, userId: 'user-bob', closed: 0 },
    { dmChannelId: GROUP, userId: 'user-carol', closed: 0 },
  ]).run();
  testDb.insert(schema.dmMessages).values([
    { id: 'msg-one', dmChannelId: ONE_ON_ONE, userId: 'user-bob', content: 'hello', createdAt: now + 1 },
    { id: 'msg-group', dmChannelId: GROUP, userId: 'user-carol', content: 'saturday?', createdAt: now + 2 },
  ]).run();
}

async function readyDmChannels(): Promise<DmChannel[]> {
  const { connectionManager } = await import('../ws/handler.js');
  const ws = { readyState: 1, send: vi.fn() };
  connectionManager.addConnection(ME, ws as never);
  connectionManager.pushReadyPayload(ME);
  connectionManager.removeConnection(ws as never);
  const raw = ws.send.mock.calls[0]?.[0];
  if (typeof raw !== 'string') throw new Error('no ready payload was sent');
  const message = JSON.parse(raw) as { type: string; dmChannels: DmChannel[] };
  expect(message.type).toBe('ready');
  return message.dmChannels;
}

async function listedDmChannels(app: FastifyInstance): Promise<DmChannel[]> {
  const res = await app.inject({ method: 'GET', url: '/api/dm' });
  expect(res.statusCode).toBe(200);
  return res.json() as DmChannel[];
}

describe('DmChannel wire shape: GET /api/dm, ready and dm_channel_created agree', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seed();
    app = Fastify({ logger: false });
    const { dmRoutes } = await import('./dm.js');
    await app.register(dmRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it.each([
    ['a federated 1-on-1', ONE_ON_ONE],
    ['a group', GROUP],
  ])('the list entry for %s has the same keys and values as the ready entry', async (_label, id) => {
    const readyEntry = (await readyDmChannels()).find(d => d.id === id);
    const listEntry = (await listedDmChannels(app)).find(d => d.id === id);
    expect(readyEntry).toBeDefined();
    expect(listEntry).toBeDefined();
    expect(Object.keys(listEntry!).sort()).toEqual(Object.keys(readyEntry!).sort());
    expect(listEntry).toEqual(readyEntry);
  });

  it('the list carries the conversation key and the group metadata', async () => {
    const list = await listedDmChannels(app);
    const one = list.find(d => d.id === ONE_ON_ONE)!;
    const group = list.find(d => d.id === GROUP)!;
    expect(one.federatedId).toBe('f'.repeat(32));
    expect(one.name).toBeNull();
    expect(group).toMatchObject({
      federatedId: '0e0e0e0e-0000-4000-8000-000000000000',
      ownerId: ME,
      ownerHomeUserId: ME,
      ownerHomeInstance: 'local.example',
      name: 'Weekend plans',
      icon: '/uploads/group-icon.png',
      metadataUpdatedAt: now + 5,
    });
  });

  it.each([
    ['a federated 1-on-1', ONE_ON_ONE],
    ['a group', GROUP],
  ])('the dm_channel_created payload for %s has the same keys as the ready entry', async (_label, id) => {
    const { buildDmChannelPayload } = await import('./federation/dmChannels.js');
    const readyEntry = (await readyDmChannels()).find(d => d.id === id);
    const payload = JSON.parse(JSON.stringify(buildDmChannelPayload(id, testDb as never))) as DmChannel;
    expect(Object.keys(payload).sort()).toEqual(Object.keys(readyEntry!).sort());
    // lastMessage is the full message there (the relay passes the one it just stored); the channel fields are equal.
    expect({ ...payload, lastMessage: null }).toEqual({ ...readyEntry!, lastMessage: null });
  });
});
