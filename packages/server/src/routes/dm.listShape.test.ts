import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { and, eq } from 'drizzle-orm';
import type { DmChannel, DmMessageWithUser } from '@backspace/shared';

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
  const { buildReadyPayload } = await import('../ws/handler.js');
  // Through JSON, as the payload travels on the socket.
  const message = JSON.parse(JSON.stringify(buildReadyPayload(ME))) as { dmChannels: DmChannel[] };
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
    const { loadDmChannelWire } = await import('../utils/dmChannelWire.js');
    const readyEntry = (await readyDmChannels()).find(d => d.id === id);
    const payload = JSON.parse(JSON.stringify(loadDmChannelWire(testDb as never, id))) as DmChannel;
    // Without a message to deliver, the payload is the ready entry, last-message preview included.
    expect(payload).toEqual(readyEntry);
  });
});

/**
 * Every emitter puts a `DmChannel` on the wire through `loadDmChannelWire`
 * (ADR 0002, "One server wire serializer"): its payload has the same keys and
 * values as the serializer's for the same row. A payload built before the
 * emitter's own system messages are stored carries the last message as of that
 * moment, so those are compared with `lastMessage` left out.
 */
describe('every DmChannel emitter builds its payload with loadDmChannelWire', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seed();
    testDb.insert(schema.users).values([
      { id: 'user-dave', username: 'dave', passwordHash: 'x', homeUserId: null, homeInstance: null, createdAt: now },
      { id: 'user-erin', username: 'erin', passwordHash: 'x', homeUserId: null, homeInstance: null, createdAt: now },
    ]).run();
    testDb.insert(schema.friends).values([
      { userId: ME, friendId: 'user-carol', createdAt: now },
      { userId: ME, friendId: 'user-dave', createdAt: now },
      { userId: ME, friendId: 'user-erin', createdAt: now },
    ]).run();
    app = Fastify({ logger: false });
    const { dmRoutes } = await import('./dm.js');
    await app.register(dmRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  async function wireOf(id: string, lastMessage?: DmMessageWithUser): Promise<DmChannel> {
    const { loadDmChannelWire } = await import('../utils/dmChannelWire.js');
    const wire = loadDmChannelWire(testDb as never, id, lastMessage);
    expect(wire).not.toBeNull();
    return JSON.parse(JSON.stringify(wire)) as DmChannel;
  }

  function expectSameChannel(payload: DmChannel, wire: DmChannel): void {
    expect(Object.keys(payload).sort()).toEqual(Object.keys(wire).sort());
    expect({ ...payload, lastMessage: null }).toEqual({ ...wire, lastMessage: null });
  }

  async function createdSentTo(userId: string, run: () => Promise<unknown>): Promise<DmChannel[]> {
    const { connectionManager } = await import('../ws/handler.js');
    const send = vi.spyOn(connectionManager, 'sendToUser');
    await run();
    return send.mock.calls
      .filter(([to, event]) => to === userId && event.type === 'dm_channel_created')
      .map(([, event]) => JSON.parse(JSON.stringify((event as { dmChannel: DmChannel }).dmChannel)) as DmChannel);
  }

  it('POST /api/dm answering with an existing 1-on-1 (200)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dm', payload: { userId: 'user-bob' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(await wireOf(ONE_ON_ONE));
  });

  it('POST /api/dm answering with a new 1-on-1 (201)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/dm', payload: { userId: 'user-carol' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as DmChannel;
    expect(body).toEqual(await wireOf(body.id));
  });

  it('POST /api/dm/group: the response and the members\' dm_channel_created', async () => {
    let res: Awaited<ReturnType<FastifyInstance['inject']>> | undefined;
    const sent = await createdSentTo('user-carol', async () => {
      res = await app.inject({ method: 'POST', url: '/api/dm/group', payload: { users: [{ id: 'user-carol' }, { id: 'user-dave' }] } });
    });
    expect(res!.statusCode).toBe(201);
    const body = res!.json() as DmChannel;
    const wire = await wireOf(body.id);
    expectSameChannel(body, wire);
    expect(sent).toHaveLength(1);
    expectSameChannel(sent[0]!, wire);
  });

  it('POST /api/dm/:id/members: the dm_channel_created the added member gets', async () => {
    const sent = await createdSentTo('user-erin', async () => {
      const res = await app.inject({ method: 'POST', url: `/api/dm/${GROUP}/members`, payload: { userId: 'user-erin' } });
      expect(res.statusCode).toBeLessThan(300);
    });
    expect(sent).toHaveLength(1);
    expectSameChannel(sent[0]!, await wireOf(GROUP));
    expect(sent[0]!.name).toBe('Weekend plans');
  });

  it('broadcastDmMessage: the dm_channel_created that reopens a closed conversation', async () => {
    testDb.update(schema.dmMembers).set({ closed: 1 })
      .where(and(eq(schema.dmMembers.dmChannelId, GROUP), eq(schema.dmMembers.userId, 'user-carol'))).run();
    const { broadcastDmMessage, getDmMessageWithUser } = await import('./dm.js');
    const message = getDmMessageWithUser('msg-group')!;
    const sent = await createdSentTo('user-carol', async () => { broadcastDmMessage(GROUP, message); });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(await wireOf(GROUP, message));
  });
});

describe('the newest-message lookup on a long conversation', () => {
  it('reads the last message of a conversation with thousands of messages without scanning it per row', async () => {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seed();
    const count = 8_000;
    sqlite.transaction(() => {
      const message = sqlite.prepare(`INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES (?, ?, ?, 'x', ?)`);
      for (let i = 0; i < count; i++) message.run(`long-${i}`, ONE_ON_ONE, i % 2 === 0 ? ME : 'user-bob', now + 10 + i);
    })();
    const { loadDmChannelWire, loadOpenDmChannels } = await import('../utils/dmChannelWire.js');
    const started = performance.now();
    const wire = loadDmChannelWire(testDb as never, ONE_ON_ONE);
    const listed = loadOpenDmChannels(testDb as never, ME).find(d => d.id === ONE_ON_ONE);
    const elapsed = performance.now() - started;
    expect(wire?.lastMessage?.id).toBe(`long-${count - 1}`);
    expect(listed?.lastMessage?.id).toBe(`long-${count - 1}`);
    // A lookup that re-reads the conversation for every candidate row takes
    // seconds here (quadratic in its messages); one grouped pass takes ms.
    expect(elapsed).toBeLessThan(750);
  });
});

describe('loadOpenDmChannels with many conversations', () => {
  it('lists every open DM with its last message when a user has more than a thousand', async () => {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seed();
    const count = 1_200;
    sqlite.transaction(() => {
      const user = sqlite.prepare(`INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', ?)`);
      const channel = sqlite.prepare(`INSERT INTO dm_channels (id, created_at) VALUES (?, ?)`);
      const member = sqlite.prepare(`INSERT INTO dm_members (dm_channel_id, user_id, closed) VALUES (?, ?, 0)`);
      const message = sqlite.prepare(`INSERT INTO dm_messages (id, dm_channel_id, user_id, content, created_at) VALUES (?, ?, ?, 'hi', ?)`);
      for (let i = 0; i < count; i++) {
        user.run(`peer-${i}`, `peer${i}`, now);
        channel.run(`bulk-${i}`, now);
        member.run(`bulk-${i}`, ME);
        member.run(`bulk-${i}`, `peer-${i}`);
        message.run(`bulk-msg-${i}-a`, `bulk-${i}`, `peer-${i}`, now + i);
        message.run(`bulk-msg-${i}-b`, `bulk-${i}`, ME, now + i + 1);
      }
    })();
    const { loadOpenDmChannels } = await import('../utils/dmChannelWire.js');
    const bulk = loadOpenDmChannels(testDb as never, ME).filter(d => d.id.startsWith('bulk-'));
    expect(bulk).toHaveLength(count);
    expect(bulk.every(d => d.lastMessage?.id === `bulk-msg-${d.id.slice('bulk-'.length)}-b`)).toBe(true);
  });
});
