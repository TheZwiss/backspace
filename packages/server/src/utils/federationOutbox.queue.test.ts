import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setWorkerId } from './snowflake.js';
import { queueOutboxEvent } from './federationOutbox.js';
import { markOutboxOfferedForPeer, outboxQueueKey } from './federationOutboxQueue.js';

/**
 * How `queueOutboxEvent` files a newer event into the queue of its entity
 * (#372), and which peers an untargeted broadcast reaches (#321).
 *
 * The rules under test are the table in federationOutboxQueue.ts: an event
 * may only fold into a queued one when the fold is right whatever the peer
 * already holds, and it may only absorb or cancel a row that no path has
 * offered to the peer yet.
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

vi.mock('./federationAuth.js', () => ({
  getOurOrigin: () => 'https://test.example',
  buildFederationHeaders: () => ({ 'Content-Type': 'application/json' }),
  generateHmacSecret: () => 'secret',
  normalizeOriginForCompare: (o: string) => o,
  ROTATION_GRACE_PERIOD_MS: 15 * 60 * 1000,
}));

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

const ACTIVE = 'https://active.example';

function seedPeer(id: string, origin: string, status: string): void {
  testDb.insert(schema.federationPeers).values({
    id, origin, hmacSecret: 'secret', status, createdAt: Date.now(),
  }).run();
}

interface Row {
  id: string;
  entityId: string;
  queueKey: string | null;
  eventType: string;
  payload: string;
  offeredAt: number | null;
  createdAt: number;
}

function rows(peerId = 'peer-active'): Row[] {
  return testDb.select({
    id: schema.federationOutbox.id,
    entityId: schema.federationOutbox.entityId,
    queueKey: schema.federationOutbox.queueKey,
    eventType: schema.federationOutbox.eventType,
    payload: schema.federationOutbox.payload,
    offeredAt: schema.federationOutbox.offeredAt,
    createdAt: schema.federationOutbox.createdAt,
  }).from(schema.federationOutbox)
    .where(eq(schema.federationOutbox.peerId, peerId))
    .orderBy(asc(schema.federationOutbox.createdAt), asc(schema.federationOutbox.id))
    .all();
}

/** Mark every queued row as offered, as a POST or a `/sync` pull would. */
function offerAll(): void {
  testDb.update(schema.federationOutbox).set({ offeredAt: Date.now() }).run();
}

function queueDm(messageId: string, eventType: 'create' | 'update' | 'delete', content = ''): void {
  const payload = eventType === 'delete'
    ? { deleted: true }
    : { message: { userId: 'u', homeUserId: 'u', homeInstance: 'test.example', content, replyToId: null, editedAt: null, createdAt: 1 } };
  queueOutboxEvent(messageId, 'dm-1', eventType, JSON.stringify(payload), [ACTIVE]);
}

function queuePresence(user: string, status: string, targets?: string[]): void {
  queueOutboxEvent(user, user, 'presence_update', JSON.stringify({
    presenceUpdate: { homeUserId: user, homeInstance: 'https://test.example', status, ts: Date.now(), activities: [] },
  }), targets, 'profile');
}

function queueProfile(user: string, displayName: string, targets?: string[]): void {
  queueOutboxEvent(user, user, 'profile_update', JSON.stringify({
    profileUpdate: { homeUserId: user, homeInstance: 'https://test.example', displayName },
  }), targets, 'profile');
}

/** The wire ids the live relay uses: `reactionId` for an add, `msg:user:emoji` for a remove. */
function queueReaction(eventType: 'reaction_add' | 'reaction_remove', entityId: string): void {
  queueOutboxEvent(entityId, 'dm-1', eventType, JSON.stringify({
    reaction: { messageId: 'm1', messageHomeInstance: 'https://test.example', userId: 'u', homeUserId: 'u', homeInstance: 'https://test.example', emoji: 'x' },
  }), [ACTIVE]);
}

function queueDmOpenState(eventType: 'dm_close' | 'dm_reopen'): void {
  queueOutboxEvent(`${eventType}:fed-1:u`, 'dm-1', eventType, JSON.stringify({
    eventType, dmChannelId: 'dm-1', messageId: `${eventType}:fed-1:u:1`, federatedId: 'fed-1',
    encryptionVersion: 0, timestamp: 1, dmCloseReopen: { homeUserId: 'u', homeInstance: 'https://test.example' },
  }), [ACTIVE]);
}

function queueFriend(eventType: 'friend_request_create' | 'friend_request_cancel', at: number): void {
  queueOutboxEvent(`friend_req:a:b:${at}`, 'friend:a:b', eventType, JSON.stringify({
    friendship: { from: { homeUserId: 'a', homeInstance: 'https://test.example' }, to: { homeUserId: 'b', homeInstance: ACTIVE } },
  }), [ACTIVE], 'friend');
}

function queueFileRejected(sourceMessageId: string, attachmentId: string): void {
  queueOutboxEvent(sourceMessageId, 'dm-1', 'file_rejected', JSON.stringify({
    eventType: 'file_rejected', messageId: sourceMessageId, attachmentId, rejectionReason: 'size_limit_exceeded',
  }), [ACTIVE]);
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  setWorkerId(1);
  testDb.insert(schema.instanceSettings).values({
    id: 1,
    instanceId: 'queue-test-epoch',
    federationRelayEnabled: 1,
    federationRelayTtlDays: 30,
    updatedAt: Date.now(),
  } as typeof schema.instanceSettings.$inferInsert).run();
  seedPeer('peer-active', ACTIVE, 'active');
});

describe('outbox queue keys: one queue per entity (#372)', () => {
  it('keeps a presence change and a profile change for one user as two events', () => {
    queueProfile('dana', 'Dana');
    queuePresence('dana', 'dnd');
    expect(rows().map(r => r.eventType).sort()).toEqual(['presence_update', 'profile_update']);
    // Both keep the user id as the id the peer sees.
    expect(rows().map(r => r.entityId)).toEqual(['dana', 'dana']);
  });

  it('keeps the size rejections of two attachments of one message as two events', () => {
    queueFileRejected('src-m1', 'a1');
    queueFileRejected('src-m1', 'a2');
    expect(rows().map(r => JSON.parse(r.payload).attachmentId)).toEqual(['a1', 'a2']);
  });

  it('files a reaction add and remove of one user and emoji in one queue, whatever their wire ids', () => {
    const add = outboxQueueKey('reaction_add', 'react-1', 'dm-1', JSON.stringify({ reaction: { messageId: 'm1', messageHomeInstance: 'https://h', userId: 'u', emoji: 'x' } }));
    const remove = outboxQueueKey('reaction_remove', 'm1:u:x', 'dm-1', JSON.stringify({ reaction: { messageId: 'm1', messageHomeInstance: 'https://h', userId: 'u', emoji: 'x' } }));
    expect(add).toBe(remove);
  });

  it('files every event of one friendship in one queue, in the order queued', () => {
    queueFriend('friend_request_create', 1);
    queueFriend('friend_request_cancel', 2);
    const queued = rows();
    expect(queued.map(r => r.eventType)).toEqual(['friend_request_create', 'friend_request_cancel']);
    expect(new Set(queued.map(r => r.queueKey)).size).toBe(1);
  });
});

describe('outbox queue: state events replace what is queued for the entity', () => {
  it('replaces a queued status change with the newer one, as a new row stamped later', () => {
    queuePresence('dana', 'dnd');
    const first = rows()[0]!;
    offerAll();
    queuePresence('dana', 'idle');
    const queued = rows();
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0]!.payload).presenceUpdate.status).toBe('idle');
    // A replacement is a new row, so settling the offered one by id cannot touch it.
    expect(queued[0]!.id).not.toBe(first.id);
    expect(queued[0]!.offeredAt).toBeNull();
    expect(queued[0]!.createdAt).toBeGreaterThan(first.createdAt);
  });

  it('ends remove, add, remove of one reaction as the last remove', () => {
    queueReaction('reaction_remove', 'm1:u:x');
    queueReaction('reaction_add', 'react-2');
    queueReaction('reaction_remove', 'm1:u:x');
    expect(rows().map(r => r.eventType)).toEqual(['reaction_remove']);
  });

  it('does not cancel an add that was never offered against a remove: the peer may hold the reaction from before', () => {
    queueReaction('reaction_add', 'react-1');
    queueReaction('reaction_remove', 'm1:u:x');
    expect(rows().map(r => r.eventType)).toEqual(['reaction_remove']);
  });

  it('ends close, reopen, close of one conversation as the last close', () => {
    queueDmOpenState('dm_close');
    queueDmOpenState('dm_reopen');
    queueDmOpenState('dm_close');
    expect(rows().map(r => r.eventType)).toEqual(['dm_close']);
  });
});

describe('outbox queue: message events', () => {
  it('puts an edit into a create no path has offered, keeping its place', () => {
    queueDm('m1', 'create', 'hello');
    const create = rows()[0]!;
    queueDm('m1', 'update', 'hello, edited');
    const queued = rows();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.eventType).toBe('create');
    expect(JSON.parse(queued[0]!.payload).message.content).toBe('hello, edited');
    expect(queued[0]!.createdAt).toBe(create.createdAt);
  });

  it('drops a create no path has offered together with its delete', () => {
    queueDm('m1', 'create', 'hello');
    queueDm('m1', 'delete');
    expect(rows()).toHaveLength(0);
  });

  it('queues an edit behind a create that may have reached the peer', () => {
    queueDm('m1', 'create', 'hello');
    offerAll();
    queueDm('m1', 'update', 'hello, edited');
    expect(rows().map(r => [r.eventType, JSON.parse(r.payload).message.content])).toEqual([['create', 'hello'], ['update', 'hello, edited']]);
  });

  it('keeps only the newest edit behind an offered create', () => {
    queueDm('m1', 'create', 'hello');
    offerAll();
    queueDm('m1', 'update', 'one');
    queueDm('m1', 'update', 'two');
    const queued = rows();
    expect(queued.map(r => r.eventType)).toEqual(['create', 'update']);
    expect(JSON.parse(queued[1]!.payload).message.content).toBe('two');
  });

  it('replaces an offered create and the edit behind it with the delete', () => {
    queueDm('m1', 'create', 'hello');
    offerAll();
    queueDm('m1', 'update', 'edited');
    queueDm('m1', 'delete');
    expect(rows().map(r => r.eventType)).toEqual(['delete']);
  });

  it('replaces a queued edit with the delete when the create was delivered earlier', () => {
    queueDm('m1', 'update', 'edited');
    queueDm('m1', 'delete');
    expect(rows().map(r => r.eventType)).toEqual(['delete']);
  });
});

describe('outbox queue: which peers an event reaches (#321)', () => {
  beforeEach(() => {
    seedPeer('peer-pending', 'https://pending.example', 'pending');
    seedPeer('peer-unreachable', 'https://unreachable.example', 'unreachable');
  });

  it('broadcasts to active and unreachable peers, not to pending ones', () => {
    queueProfile('dana', 'Dana');
    queuePresence('dana', 'online');
    expect(rows('peer-active')).toHaveLength(2);
    expect(rows('peer-unreachable')).toHaveLength(2);
    expect(rows('peer-pending')).toHaveLength(0);
  });

  it('still queues a targeted event onto a pending peer', () => {
    queueProfile('dana', 'Dana', ['https://pending.example']);
    expect(rows('peer-pending').map(r => r.eventType)).toEqual(['profile_update']);
  });
});

describe('markOutboxOfferedForPeer: a /sync pull may have delivered what is queued', () => {
  it('marks the pulling peer\'s rows of that context as offered, so a later delete is still sent', () => {
    seedPeer('peer-other', 'https://other.example', 'active');
    queueDm('m1', 'create', 'hello');
    queueOutboxEvent('m9', 'dm-9', 'create', JSON.stringify({ message: { content: 'x' } }), ['https://other.example']);
    queueProfile('dana', 'Dana');

    markOutboxOfferedForPeer('peer-active', Date.now(), 'dm');

    expect(rows('peer-active').find(r => r.eventType === 'create')!.offeredAt).not.toBeNull();
    expect(rows('peer-active').find(r => r.eventType === 'profile_update')!.offeredAt).toBeNull();
    expect(rows('peer-other')[0]!.offeredAt).toBeNull();

    queueDm('m1', 'delete');
    expect(rows('peer-active').filter(r => r.entityId === 'm1').map(r => r.eventType)).toEqual(['delete']);
  });
});
