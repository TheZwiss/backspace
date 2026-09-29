import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, eq } from 'drizzle-orm';
import type { FederationRelayRequest } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { __resetInstanceIdCacheForTest } from './federationEpoch.js';
import { setWorkerId } from './snowflake.js';
import { queueOutboxEvent } from './federationOutbox.js';
import { processOutboxTick, stopFederationWorkers } from './federationWorker.js';

/**
 * The outbox worker against the real queue (#367, #372).
 *
 * A send whose answer never arrives (timeout, abort, 5xx, a stopped process)
 * may have reached the peer. These tests check that such a row is treated as
 * possibly delivered from the moment it is put on the wire, that events queued
 * behind it wait for it, and that settling a batch is not undone by anything
 * that runs after it. Several run the real `queueOutboxEvent` from inside the
 * mocked POST, while the request is on the wire.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToAdmins: vi.fn(),
    getAllOnlineUserIds: () => [],
    sendToUser: vi.fn(),
    sendToDmMembers: vi.fn(),
    evictFederatedCallsForHost: vi.fn().mockReturnValue(0),
    getAllFederatedCalls: vi.fn(() => new Map()),
  },
}));

vi.mock('./federationAuth.js', () => ({
  getOurOrigin: () => 'https://test.example',
  buildFederationHeaders: () => ({ 'Content-Type': 'application/json' }),
  generateHmacSecret: () => 'secret',
  normalizeOriginForCompare: (o: string) => o,
  ROTATION_GRACE_PERIOD_MS: 15 * 60 * 1000,
}));

vi.mock('./federationPeerActivation.js', () => ({
  onPeerActivated: vi.fn(),
  onPeerDeactivated: vi.fn().mockResolvedValue(undefined),
  startupBootstrapSync: vi.fn(),
}));

vi.mock('./storageJanitor.js', () => ({
  runFederationJanitor: vi.fn(),
}));

vi.mock('./thumbnail.js', () => ({
  generateThumbnail: vi.fn(),
}));

vi.mock('../routes/dm.js', () => ({
  getDmMessageWithUser: vi.fn(),
}));

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sql.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

const PEER_1 = 'https://one.example';
const PEER_2 = 'https://two.example';

function seed(): void {
  setWorkerId(1);
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceId: 'delivery-test-epoch',
    federationRelayEnabled: 1,
    federationRelayTtlDays: 30,
    updatedAt: Date.now(),
  } as typeof schema.instanceSettings.$inferInsert).run();
  __resetInstanceIdCacheForTest();
  for (const [id, origin] of [['peer-1', PEER_1], ['peer-2', PEER_2]] as const) {
    testDb.insert(schema.federationPeers).values({
      id, origin, hmacSecret: 'secret', status: 'active', lastSyncedAt: Date.now(), createdAt: Date.now(),
    }).run();
  }
}

/** Queue a presence change for `user` to every active peer (the real path). */
function queuePresence(user: string, status: string): void {
  queueOutboxEvent(user, user, 'presence_update', JSON.stringify({
    presenceUpdate: { homeUserId: user, homeInstance: 'https://test.example', status, ts: Date.now(), activities: [] },
  }), undefined, 'profile');
}

/** Queue a DM message event for `messageId` to PEER_1 only. */
function queueDm(messageId: string, eventType: 'create' | 'update' | 'delete', content = ''): void {
  const payload = eventType === 'delete'
    ? { deleted: true }
    : { message: { userId: 'u', homeUserId: 'u', homeInstance: 'test.example', content, replyToId: null, editedAt: null, createdAt: 1 } };
  queueOutboxEvent(messageId, 'dm-1', eventType, JSON.stringify(payload), [PEER_1]);
}

interface Row {
  id: string;
  entityId: string;
  eventType: string;
  payload: string;
  attempts: number | null;
  nextRetryAt: number;
  offeredAt: number | null;
  createdAt: number;
}

function rows(peerId: string, entityId?: string): Row[] {
  return testDb.select({
    id: schema.federationOutbox.id,
    entityId: schema.federationOutbox.entityId,
    eventType: schema.federationOutbox.eventType,
    payload: schema.federationOutbox.payload,
    attempts: schema.federationOutbox.attempts,
    nextRetryAt: schema.federationOutbox.nextRetryAt,
    offeredAt: schema.federationOutbox.offeredAt,
    createdAt: schema.federationOutbox.createdAt,
  }).from(schema.federationOutbox)
    .where(eq(schema.federationOutbox.peerId, peerId))
    .orderBy(asc(schema.federationOutbox.createdAt), asc(schema.federationOutbox.id))
    .all()
    .filter(r => entityId === undefined || r.entityId === entityId);
}

/** Make every row due now, as if its backoff had run out. */
function makeAllDue(): void {
  testDb.update(schema.federationOutbox).set({ nextRetryAt: 0 }).run();
}

/** Every relay POST the worker made, parsed, with the origin it went to. */
interface Sent { origin: string; body: FederationRelayRequest }

/**
 * Mock the relay POST. `respond` decides the answer per request (and may
 * throw, as fetch does on a timeout); `during` runs while the request is on
 * the wire, before the answer is returned.
 */
function mockRelay(
  respond: (sent: Sent, index: number) => Response,
  during: (sent: Sent, index: number) => void = () => {},
): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const entry: Sent = {
      origin: new URL(url).origin,
      body: JSON.parse(String(init?.body)) as FederationRelayRequest,
    };
    sent.push(entry);
    const index = sent.length - 1;
    during(entry, index);
    return respond(entry, index);
  });
  return sent;
}

function answer(accepted: string[], rejected: Array<{ messageId: string; reason: string }> = []): Response {
  return new Response(JSON.stringify({ accepted, rejected }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const acceptAll = (sent: Sent): Response => answer(sent.body.events.map(e => e.messageId));

/** A peer that already applied every create it is sent again: creates are duplicates, the rest is accepted. */
const peerHoldsCreates = (sent: Sent): Response => answer(
  sent.body.events.filter(e => e.eventType !== 'create').map(e => e.messageId),
  sent.body.events.filter(e => e.eventType === 'create').map(e => ({ messageId: e.messageId, reason: 'duplicate' })),
);

const timeout = (): never => {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};

const sentEvents = (sent: Sent[], origin = PEER_1) => sent.filter(s => s.origin === origin).flatMap(s => s.body.events);

describe('outbox worker: a send with an unknown outcome may have reached the peer (#372)', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks rows as offered before the request leaves, so a process stop mid-send leaves them marked', async () => {
    queueDm('m1', 'create', 'hello');
    let offeredWhileOnTheWire: number | null = null;
    mockRelay(acceptAll, () => {
      offeredWhileOnTheWire = rows('peer-1', 'm1')[0]!.offeredAt;
    });

    await processOutboxTick();
    expect(offeredWhileOnTheWire).not.toBeNull();
  });

  it('still sends a delete queued after a create whose send timed out', async () => {
    queueDm('m1', 'create', 'hello');
    const sent = mockRelay((s, i) => (i === 0 ? timeout() : acceptAll(s)));

    await processOutboxTick();
    queueDm('m1', 'delete');
    makeAllDue();
    await processOutboxTick();

    expect(sentEvents(sent).map(e => e.eventType)).toEqual(['create', 'delete']);
    expect(rows('peer-1')).toHaveLength(0);
  });

  it('sends an edit queued after a create whose send timed out, after the create, when the peer had it', async () => {
    queueDm('m1', 'create', 'hello');
    const sent = mockRelay((s, i) => (i === 0 ? timeout() : peerHoldsCreates(s)));

    await processOutboxTick();
    queueDm('m1', 'update', 'hello, edited');
    makeAllDue();
    await processOutboxTick();
    await processOutboxTick();

    const events = sentEvents(sent);
    expect(events.map(e => e.eventType)).toEqual(['create', 'create', 'update']);
    expect(events[2]!.message?.content).toBe('hello, edited');
    expect(rows('peer-1')).toHaveLength(0);
  });

  it('keeps an edit queued while the create was on the wire when a proxy answers 504 after the peer applied it', async () => {
    queueDm('m1', 'create', 'hello');
    const sent = mockRelay(
      (s, i) => (i === 0 ? new Response('gateway timeout', { status: 504 }) : peerHoldsCreates(s)),
      (_s, i) => { if (i === 0) queueDm('m1', 'update', 'hello, edited'); },
    );

    await processOutboxTick();
    makeAllDue();
    await processOutboxTick();
    await processOutboxTick();

    const events = sentEvents(sent);
    expect(events.map(e => e.eventType)).toEqual(['create', 'create', 'update']);
    expect(events[2]!.message?.content).toBe('hello, edited');
  });

  it('leaves rows due and offered when the worker stops mid-send', async () => {
    queueDm('m1', 'create', 'hello');
    mockRelay(() => { throw new DOMException('stopped', 'AbortError'); });

    await processOutboxTick();
    const [row] = rows('peer-1', 'm1');
    expect(row!.offeredAt).not.toBeNull();
    expect(row!.attempts).toBe(0);
    expect(row!.nextRetryAt).toBeLessThanOrEqual(Date.now());
    stopFederationWorkers();
  });
});

describe('outbox worker: events for one entity go out one at a time, in order', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends an event queued while the previous one for the entity was accepted on the next tick', async () => {
    queuePresence('dana', 'dnd');
    const sent = mockRelay(acceptAll, (s, i) => {
      if (i === 0 && s.origin === PEER_1) queuePresence('dana', 'idle');
    });

    await processOutboxTick();
    const [kept] = rows('peer-1', 'dana');
    expect(JSON.parse(kept!.payload).presenceUpdate.status).toBe('idle');
    expect(kept!.attempts).toBe(0);

    await processOutboxTick();
    const events = sentEvents(sent);
    expect(events.map(e => e.presenceUpdate?.status)).toEqual(['dnd', 'idle']);
    // Last-writer-wins receivers must see the newer event as newer.
    expect(events[1]!.timestamp).toBeGreaterThan(events[0]!.timestamp);
    expect(rows('peer-1')).toHaveLength(0);
  });

  it('does not send a later peer of the same tick an event replaced while an earlier peer was served', async () => {
    queuePresence('dana', 'dnd');
    const sent = mockRelay(acceptAll, (s, i) => {
      if (i === 0 && s.origin === PEER_1) queuePresence('dana', 'idle');
    });

    await processOutboxTick();
    expect(sentEvents(sent, PEER_2)).toEqual([]);

    await processOutboxTick();
    expect(sentEvents(sent, PEER_2).map(e => e.presenceUpdate?.status)).toEqual(['idle']);
  });

  it('holds an edit behind its create while the create backs off', async () => {
    queueDm('m1', 'create', 'hello');
    const sent = mockRelay(() => new Response('boom', { status: 500 }));
    await processOutboxTick();

    queueDm('m1', 'update', 'hello, edited');
    await processOutboxTick();

    expect(sentEvents(sent).map(e => e.eventType)).toEqual(['create']);
    expect(rows('peer-1', 'm1').map(r => r.eventType)).toEqual(['create', 'update']);
  });

  it('puts one event per wire id in a batch, so the answer names each row once', async () => {
    for (const attachmentId of ['a1', 'a2']) {
      queueOutboxEvent('src-m1', 'dm-1', 'file_rejected', JSON.stringify({
        eventType: 'file_rejected', messageId: 'src-m1', attachmentId, rejectionReason: 'size_limit_exceeded',
      }), [PEER_1]);
    }
    const sent = mockRelay(acceptAll);

    await processOutboxTick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.events.map(e => e.attachmentId)).toEqual(['a1']);

    await processOutboxTick();
    expect(sentEvents(sent).map(e => e.attachmentId)).toEqual(['a1', 'a2']);
    expect(rows('peer-1')).toHaveLength(0);
  });

  it('drops what is queued behind a create the peer refused for good', async () => {
    queueDm('m1', 'create', 'hello');
    const sent = mockRelay(
      (s) => answer([], s.body.events.map(e => ({ messageId: e.messageId, reason: 'invalid_target' }))),
      (_s, i) => { if (i === 0) queueDm('m1', 'update', 'hello, edited'); },
    );

    await processOutboxTick();
    await processOutboxTick();
    expect(sentEvents(sent).map(e => e.eventType)).toEqual(['create']);
    expect(rows('peer-1')).toHaveLength(0);
  });

  it('counts a duplicate as taken and sends the edit queued behind it next', async () => {
    queueDm('m1', 'create', 'hello');
    const sent = mockRelay(peerHoldsCreates, (_s, i) => { if (i === 0) queueDm('m1', 'update', 'hello, edited'); });

    await processOutboxTick();
    await processOutboxTick();
    expect(sentEvents(sent).map(e => e.eventType)).toEqual(['create', 'update']);
    expect(rows('peer-1')).toHaveLength(0);
  });

  it('backs off a retryable refusal and keeps the row offered', async () => {
    queueDm('m1', 'create', 'hello');
    mockRelay((s) => answer([], s.body.events.map(e => ({ messageId: e.messageId, reason: 'channel_not_found' }))));

    const before = Date.now();
    await processOutboxTick();
    const [row] = rows('peer-1', 'm1');
    expect(row!.attempts).toBe(1);
    expect(row!.nextRetryAt).toBeGreaterThan(before);
    expect(row!.offeredAt).not.toBeNull();
  });
});

describe('outbox worker: a settled batch stays settled (#372)', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not back off an event queued behind an accepted one when a later step of the tick throws', async () => {
    queuePresence('dana', 'dnd');
    mockRelay(
      (s) => new Response(JSON.stringify({ accepted: s.body.events.map(e => e.messageId), rejected: [], maxUploadSize: 5 }), { status: 200 }),
      (s, i) => { if (i === 0 && s.origin === PEER_1) queuePresence('dana', 'idle'); },
    );
    // The peer bookkeeping after settlement fails.
    const realUpdate = testDb.update.bind(testDb);
    vi.spyOn(testDb, 'update').mockImplementation(((table: Parameters<typeof testDb.update>[0]) => {
      if (table === schema.federationPeers) throw new Error('post-settlement failure');
      return realUpdate(table);
    }) as typeof testDb.update);

    await processOutboxTick().catch(() => {});
    const [row] = rows('peer-1', 'dana');
    expect(JSON.parse(row!.payload).presenceUpdate.status).toBe('idle');
    expect(row!.attempts).toBe(0);
    expect(row!.nextRetryAt).toBeLessThanOrEqual(Date.now());
  });

  it('backs off every row of a batch whose answer cannot be read, as possibly delivered', async () => {
    queueDm('m1', 'create', 'hello');
    mockRelay(() => new Response('not json', { status: 200 }));

    await processOutboxTick();
    const [row] = rows('peer-1', 'm1');
    expect(row!.attempts).toBe(1);
    expect(row!.offeredAt).not.toBeNull();
  });
});
