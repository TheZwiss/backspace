import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import type { FederationRelayRequest } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { __resetInstanceIdCacheForTest } from './federationEpoch.js';
import { setWorkerId } from './snowflake.js';
import { queueOutboxEvent } from './federationOutbox.js';
import { processOutboxTick } from './federationWorker.js';

/**
 * #367: an event queued for an entity while the worker is delivering the
 * previous event for that entity.
 *
 * The outbox holds one row per (peer, entity) and merges newer events into it.
 * The worker reads a batch, POSTs it and settles the rows when the answer
 * arrives; a merge can land in between. These tests run the REAL
 * `queueOutboxEvent` from inside the mocked POST, which is exactly that window.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let testDb: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
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
    instanceId: 'inflight-test-epoch',
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
function queueDm(messageId: string, eventType: 'create' | 'update' | 'delete', content: string): void {
  const payload = eventType === 'delete'
    ? { deleted: true }
    : { message: { userId: 'u', homeUserId: 'u', homeInstance: 'test.example', content, replyToId: null, editedAt: null, createdAt: 1 } };
  queueOutboxEvent(messageId, 'dm-1', eventType, JSON.stringify(payload), [PEER_1]);
}

interface Row { eventType: string; payload: string; attempts: number | null; nextRetryAt: number }

function rowFor(peerId: string, entityId: string): Row | undefined {
  return testDb.select({
    eventType: schema.federationOutbox.eventType,
    payload: schema.federationOutbox.payload,
    attempts: schema.federationOutbox.attempts,
    nextRetryAt: schema.federationOutbox.nextRetryAt,
  }).from(schema.federationOutbox)
    .where(and(
      eq(schema.federationOutbox.peerId, peerId),
      eq(schema.federationOutbox.entityId, entityId),
    ))
    .get();
}

/** Every relay POST the worker made, parsed, with the origin it went to. */
interface Sent { origin: string; body: FederationRelayRequest }

/**
 * Mock the relay POST. `respond` decides the answer per request; `during` runs
 * while the request is "on the wire", before the answer is returned.
 */
function mockRelay(
  respond: (sent: Sent) => Response,
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
    during(entry, sent.length - 1);
    return respond(entry);
  });
  return sent;
}

const acceptAll = (sent: Sent): Response => new Response(JSON.stringify({
  accepted: sent.body.events.map(e => e.messageId),
  rejected: [],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

const serverError = (): Response => new Response('boom', { status: 500 });

describe('outbox worker — an event queued while the previous one is in flight (#367)', () => {
  beforeEach(() => {
    const sqlite = new Database(':memory:');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a status change queued while the previous one is being accepted, and sends it next', async () => {
    queuePresence('dana', 'dnd');
    const sent = mockRelay(acceptAll, (s, i) => {
      if (i === 0 && s.origin === PEER_1) queuePresence('dana', 'idle');
    });

    await processOutboxTick();
    const kept = rowFor('peer-1', 'dana');
    expect(kept).toBeDefined();
    expect(JSON.parse(kept!.payload).presenceUpdate.status).toBe('idle');
    // Not pushed onto the backoff schedule: it has never been sent.
    expect(kept!.attempts).toBe(0);
    expect(kept!.nextRetryAt).toBeLessThanOrEqual(Date.now());

    await processOutboxTick();
    const toPeer1 = sent.filter(s => s.origin === PEER_1).flatMap(s => s.body.events);
    expect(toPeer1.map(e => e.presenceUpdate?.status)).toEqual(['dnd', 'idle']);
    expect(rowFor('peer-1', 'dana')).toBeUndefined();
  });

  it('sends a later peer of the same tick what is queued when its turn comes, not what the tick first read', async () => {
    // Both peers' rows are due at the start of the tick; peer 2's POST waits
    // for peer 1's answer, and dana changes her status meanwhile.
    queuePresence('dana', 'dnd');
    const sent = mockRelay(acceptAll, (s) => {
      if (s.origin === PEER_1) queuePresence('dana', 'idle');
    });

    await processOutboxTick();
    const toPeer2 = sent.filter(s => s.origin === PEER_2).flatMap(s => s.body.events);
    expect(toPeer2.map(e => e.presenceUpdate?.status)).toEqual(['idle']);
    expect(rowFor('peer-2', 'dana')).toBeUndefined();
  });

  it('sends a delete queued while the create is in flight, once the create is accepted', async () => {
    queueDm('m1', 'create', 'hello');
    const sent = mockRelay(acceptAll, (_s, i) => {
      if (i === 0) queueDm('m1', 'delete', '');
    });

    await processOutboxTick();
    expect(rowFor('peer-1', 'm1')?.eventType).toBe('delete');

    await processOutboxTick();
    expect(sent.flatMap(s => s.body.events).map(e => e.eventType)).toEqual(['create', 'delete']);
    expect(rowFor('peer-1', 'm1')).toBeUndefined();
  });

  it('sends an edit queued while the create is in flight as an update, once the create is accepted', async () => {
    queueDm('m1', 'create', 'hello');
    const sent = mockRelay(acceptAll, (_s, i) => {
      if (i === 0) queueDm('m1', 'update', 'hello, edited');
    });

    await processOutboxTick();
    await processOutboxTick();
    const events = sent.flatMap(s => s.body.events);
    expect(events.map(e => e.eventType)).toEqual(['create', 'update']);
    expect(events[1]!.message?.content).toBe('hello, edited');
    expect(rowFor('peer-1', 'm1')).toBeUndefined();
  });

  it('drops create and delete together when the in-flight create was not delivered', async () => {
    queueDm('m1', 'create', 'hello');
    mockRelay(serverError, (_s, i) => {
      if (i === 0) queueDm('m1', 'delete', '');
    });

    await processOutboxTick();
    // The peer never had the message, so there is nothing to delete there:
    // the same outcome as a delete queued before the create was ever sent.
    expect(rowFor('peer-1', 'm1')).toBeUndefined();
  });

  it('turns an edit queued while an undelivered create was in flight back into a create, due now', async () => {
    queueDm('m1', 'create', 'hello');
    mockRelay(serverError, (_s, i) => {
      if (i === 0) queueDm('m1', 'update', 'hello, edited');
    });

    await processOutboxTick();
    const row = rowFor('peer-1', 'm1');
    expect(row?.eventType).toBe('create');
    expect(JSON.parse(row!.payload).message.content).toBe('hello, edited');
    expect(row!.attempts).toBe(0);
    expect(row!.nextRetryAt).toBeLessThanOrEqual(Date.now());
  });

  it('still backs off a row nobody touched while its delivery failed', async () => {
    queueDm('m1', 'create', 'hello');
    mockRelay(serverError);

    const before = Date.now();
    await processOutboxTick();
    const row = rowFor('peer-1', 'm1');
    expect(row?.eventType).toBe('create');
    expect(row!.attempts).toBe(1);
    expect(row!.nextRetryAt).toBeGreaterThan(before);
  });

  it('deletes an accepted row nobody touched, and merges a later event as a fresh one', async () => {
    queueDm('m1', 'create', 'hello');
    mockRelay(acceptAll);

    await processOutboxTick();
    expect(rowFor('peer-1', 'm1')).toBeUndefined();

    // Nothing is in flight any more: a create and delete queued together now
    // cancel out before either is sent, as they always have.
    queueDm('m2', 'create', 'again');
    queueDm('m2', 'delete', '');
    expect(rowFor('peer-1', 'm2')).toBeUndefined();
  });
});
