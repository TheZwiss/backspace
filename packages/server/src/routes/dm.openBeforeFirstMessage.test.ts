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
import type { DmChannel, DmMessageWithUser } from '@backspace/shared';

setWorkerId(1);

/**
 * #360: opening a 1-on-1 puts it in the opener's list only. The recipient's
 * membership is created closed and nothing is pushed to them; the first
 * message reopens it for them through the resurface path every message send
 * runs, so the conversation reaches them with something in it, as it does for
 * a recipient on another instance.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'alice';

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/auth.js')>('../utils/auth.js');
  return {
    ...actual,
    authenticate: async (req: { userId?: string; username?: string }) => {
      req.userId = currentUserId;
      req.username = currentUserId;
    },
  };
});

vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    isFederationRelayEnabled: () => false,
    queueDmCloseRelay: vi.fn(),
    queueDmRelay: vi.fn(),
    queueOutboxEvent: vi.fn(),
    queueReadStateRelay: vi.fn(),
    sendTypingRelay: vi.fn(),
    appendMutationLog: vi.fn(),
  };
});

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://local.test' };
});

vi.mock('../utils/embedResolver.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/embedResolver.js')>();
  return {
    ...actual,
    resolveEmbeds: vi.fn(async () => {}),
    reResolveEmbeds: vi.fn(async () => {}),
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

interface WsEvent { type: string; [key: string]: unknown }
interface FakeSocket { readyState: number; send: ReturnType<typeof vi.fn>; }

const sockets = new Map<string, FakeSocket>();

async function connect(userId: string): Promise<void> {
  const { connectionManager } = await import('../ws/handler.js');
  const ws: FakeSocket = { readyState: 1, send: vi.fn() };
  connectionManager.addConnection(userId, ws as never);
  sockets.set(userId, ws);
}

function eventsOf(userId: string): WsEvent[] {
  const ws = sockets.get(userId);
  if (!ws) return [];
  return ws.send.mock.calls
    .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) as WsEvent : null))
    .filter((e): e is WsEvent => e !== null);
}

function createdFor(userId: string): DmChannel[] {
  return eventsOf(userId).filter(e => e.type === 'dm_channel_created').map(e => e.dmChannel as DmChannel);
}

async function readyDmIds(userId: string): Promise<string[]> {
  const { buildReadyPayload } = await import('../ws/handler.js');
  const ready = JSON.parse(JSON.stringify(buildReadyPayload(userId))) as { dmChannels?: DmChannel[] };
  return (ready.dmChannels ?? []).map(d => d.id);
}

async function listedDmIds(app: FastifyInstance, userId: string): Promise<string[]> {
  currentUserId = userId;
  const res = await app.inject({ method: 'GET', url: '/api/dm' });
  expect(res.statusCode).toBe(200);
  return (res.json() as DmChannel[]).map(d => d.id);
}

async function open(app: FastifyInstance, as: string, target: string): Promise<{ status: number; dm: DmChannel }> {
  currentUserId = as;
  const res = await app.inject({ method: 'POST', url: '/api/dm', payload: { userId: target } });
  return { status: res.statusCode, dm: res.json() as DmChannel };
}

async function send(app: FastifyInstance, as: string, dmId: string, content: string): Promise<DmMessageWithUser> {
  currentUserId = as;
  const res = await app.inject({ method: 'POST', url: `/api/dm/${dmId}/messages`, payload: { content } });
  expect(res.statusCode).toBe(201);
  return res.json() as DmMessageWithUser;
}

function closedFlag(dmId: string, userId: string): number | null | undefined {
  return testDb.select().from(schema.dmMembers)
    .where(and(eq(schema.dmMembers.dmChannelId, dmId), eq(schema.dmMembers.userId, userId)))
    .get()?.closed;
}

describe('#360: a 1-on-1 reaches the recipient with its first message', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    const now = Date.now();
    testDb.insert(schema.users).values([
      { id: 'alice', username: 'alice', passwordHash: 'x', createdAt: now },
      { id: 'carol', username: 'carol', passwordHash: 'x', createdAt: now },
    ]).run();
    sockets.clear();
    await connect('alice');
    await connect('carol');
    app = Fastify({ logger: false });
    const { dmRoutes } = await import('./dm.js');
    await app.register(dmRoutes);
    await app.ready();
  });

  afterEach(async () => {
    const { connectionManager } = await import('../ws/handler.js');
    for (const ws of sockets.values()) connectionManager.removeConnection(ws as never);
    await app.close();
    vi.restoreAllMocks();
  });

  it('opening a new 1-on-1 lists it for the opener only and pushes nothing to the recipient', async () => {
    const opened = await open(app, 'alice', 'carol');
    expect(opened.status).toBe(201);
    expect(closedFlag(opened.dm.id, 'alice')).toBe(0);
    expect(closedFlag(opened.dm.id, 'carol')).toBe(1);
    expect(createdFor('carol')).toEqual([]);
    expect(await listedDmIds(app, 'alice')).toEqual([opened.dm.id]);
    expect(await listedDmIds(app, 'carol')).toEqual([]);
    expect(await readyDmIds('carol')).toEqual([]);
  });

  it('the first message brings the conversation to the recipient with that message', async () => {
    const opened = await open(app, 'alice', 'carol');
    const message = await send(app, 'alice', opened.dm.id, 'hello carol');

    const created = createdFor('carol');
    expect(created).toHaveLength(1);
    expect(created[0]!.id).toBe(opened.dm.id);
    expect(created[0]!.lastMessage?.id).toBe(message.id);
    const types = eventsOf('carol').map(e => e.type);
    expect(types.indexOf('dm_channel_created')).toBeLessThan(types.lastIndexOf('dm_message_created'));
    expect(closedFlag(opened.dm.id, 'carol')).toBe(0);
    expect(await listedDmIds(app, 'carol')).toEqual([opened.dm.id]);
  });

  it('opening a conversation the recipient had closed does not reopen it for them', async () => {
    const opened = await open(app, 'alice', 'carol');
    await send(app, 'alice', opened.dm.id, 'hello carol');
    testDb.update(schema.dmMembers).set({ closed: 1 })
      .where(and(eq(schema.dmMembers.dmChannelId, opened.dm.id), eq(schema.dmMembers.userId, 'carol'))).run();
    const createdBefore = createdFor('carol').length;

    const again = await open(app, 'alice', 'carol');
    expect(again.status).toBe(200);
    expect(again.dm.id).toBe(opened.dm.id);
    expect(closedFlag(opened.dm.id, 'carol')).toBe(1);
    expect(createdFor('carol')).toHaveLength(createdBefore);
  });

  it('ensureOneOnOneDmChannel (space invites) creates the recipient\'s membership closed and pushes nothing', async () => {
    const { ensureOneOnOneDmChannel } = await import('./dm.js');
    const carol = testDb.select().from(schema.users).where(eq(schema.users.id, 'carol')).get()!;
    const id = ensureOneOnOneDmChannel('alice', carol, testDb as never);
    expect(closedFlag(id, 'alice')).toBe(0);
    expect(closedFlag(id, 'carol')).toBe(1);
    expect(createdFor('carol')).toEqual([]);
  });

  it('a call started in a new, message-less 1-on-1 opens it for the recipient, then rings them', async () => {
    const opened = await open(app, 'alice', 'carol');
    const { handleClientEvent } = await import('../ws/events.js');
    const { connectionManager } = await import('../ws/handler.js');
    try {
      handleClientEvent({ type: 'dm_call_start', dmChannelId: opened.dm.id }, 'alice', 'alice', sockets.get('alice') as never, false);
      const types = eventsOf('carol').map(e => e.type);
      expect(types.filter(t => t === 'dm_call_incoming')).toHaveLength(1);
      // The conversation reaches carol's list first, so the call has a place to open in.
      expect(types.indexOf('dm_channel_created')).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('dm_channel_created')).toBeLessThan(types.indexOf('dm_call_incoming'));
      expect(createdFor('carol')[0]!.id).toBe(opened.dm.id);
      expect(closedFlag(opened.dm.id, 'carol')).toBe(0);
      expect(await listedDmIds(app, 'carol')).toEqual([opened.dm.id]);

      // A reconnect while it rings restores the call.
      const { buildReadyPayload } = await import('../ws/handler.js');
      const ready = JSON.parse(JSON.stringify(buildReadyPayload('carol'))) as { activeCalls?: Array<{ dmChannelId: string | null }> };
      expect(ready.activeCalls?.map(c => c.dmChannelId)).toEqual([opened.dm.id]);
    } finally {
      connectionManager.destroyRoom(opened.dm.id);
    }
  });
});

describe('opening a 1-on-1 that re-keys another row tells that row\'s members', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    const now = Date.now();
    testDb.insert(schema.users).values([
      { id: 'alice', username: 'alice', passwordHash: 'x', createdAt: now },
      { id: 'carol', username: 'carol', passwordHash: 'x', createdAt: now },
      { id: 'dave', username: 'dave', passwordHash: 'x', createdAt: now },
    ]).run();
    const { oneOnOneKey } = await import('../utils/dmConversation.js');
    const key = (a: string, b: string) => oneOnOneKey({ id: a, homeUserId: null }, { id: b, homeUserId: null });
    // 'drifted' carries the alice-dave key but holds alice and carol; 'aliceCarol'
    // holds the alice-carol key, so opening alice-dave merges 'drifted' into it.
    testDb.insert(schema.dmChannels).values([
      { id: 'drifted', federatedId: key('alice', 'dave'), createdAt: 1 },
      { id: 'aliceCarol', federatedId: key('alice', 'carol'), createdAt: 2 },
    ]).run();
    testDb.insert(schema.dmMembers).values([
      { dmChannelId: 'drifted', userId: 'alice', closed: 1 },
      { dmChannelId: 'drifted', userId: 'carol', closed: 1 },
      { dmChannelId: 'aliceCarol', userId: 'alice', closed: 1 },
      { dmChannelId: 'aliceCarol', userId: 'carol', closed: 0 },
    ]).run();
    sockets.clear();
    await connect('alice');
    await connect('carol');
    app = Fastify({ logger: false });
    const { dmRoutes } = await import('./dm.js');
    await app.register(dmRoutes);
    await app.ready();
  });

  afterEach(async () => {
    const { connectionManager } = await import('../ws/handler.js');
    for (const ws of sockets.values()) connectionManager.removeConnection(ws as never);
    await app.close();
    vi.restoreAllMocks();
  });

  it('closes the merged-away row for its members and sends the survivor only where it is open', async () => {
    const opened = await open(app, 'alice', 'dave');
    expect(opened.status).toBe(201);
    const closedIds = (userId: string) => eventsOf(userId).filter(e => e.type === 'dm_channel_closed').map(e => e.dmChannelId);
    expect(closedIds('carol')).toEqual(['drifted']);
    expect(createdFor('carol').map(d => d.id)).toEqual(['aliceCarol']);
    expect(closedIds('alice')).toEqual(['drifted']);
    // alice closed alice-carol; it stays out of her list.
    expect(createdFor('alice').map(d => d.id)).not.toContain('aliceCarol');
  });
});
