import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FederationRelayEvent, FederationRelayParticipant } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { oneOnOneKey } from '../utils/dmConversation.js';

setWorkerId(1);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * #255: every relay event must be safe to apply twice, and to apply after the
 * receiver's state moved on. A periodic pull replays the peer's mutation log,
 * so each event the live relay already delivered arrives again, usually after
 * local actions that reacted to it; and the outbox may send a delete for a
 * create whose delivery it could not confirm.
 *
 * One receiver, ORBIT, holds a 1-on-1 between its native bob and alice, a
 * replicated user homed on HOME. Events are fed to the real `processRelayEvents`
 * as HOME, the way `/relay` and the pull both do.
 */

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const HOME_ORIGIN = 'https://home.test';
const ORBIT_ORIGIN = 'https://orbit.test';
// The conversation key a relayed 1-on-1 create finds the conversation by.
const FED_ID = oneOnOneKey({ id: 'bob', homeUserId: null }, { id: 'alice-on-orbit', homeUserId: 'alice' });
const CHANNEL = 'ch-orbit';

let sqlite: Database.Database;
let db: TestDb;

vi.mock('../db/index.js', () => ({
  getDb: () => db,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => ORBIT_ORIGIN };
});

function applyMigrations(target: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) target.exec(clean);
    }
  }
}

function seedUser(row: Partial<typeof schema.users.$inferInsert> & { id: string; username: string }): void {
  db.insert(schema.users).values({
    passwordHash: '!federation-replicated',
    createdAt: 1,
    ...row,
  } as typeof schema.users.$inferInsert).run();
}

const alice: FederationRelayParticipant = {
  homeUserId: 'alice',
  homeInstance: HOME_ORIGIN,
  profile: { username: 'alice' },
};
const bob: FederationRelayParticipant = {
  homeUserId: 'bob',
  homeInstance: ORBIT_ORIGIN,
  profile: { username: 'bob' },
};

function createEvent(messageId: string, createdAt: number, content = `message ${messageId}`): FederationRelayEvent {
  return {
    eventType: 'create',
    dmChannelId: 'ch-home',
    messageId,
    encryptionVersion: 0,
    timestamp: createdAt,
    participants: [alice, bob],
    message: {
      userId: 'alice',
      homeUserId: 'alice',
      homeInstance: HOME_ORIGIN,
      content,
      replyToId: null,
      editedAt: null,
      createdAt,
    },
  };
}

function updateEvent(messageId: string, content: string, editedAt: number | null): FederationRelayEvent {
  return {
    eventType: 'update',
    dmChannelId: 'ch-home',
    messageId,
    encryptionVersion: 0,
    timestamp: editedAt ?? 5_000,
    message: {
      userId: 'alice',
      homeUserId: 'alice',
      homeInstance: HOME_ORIGIN,
      content,
      replyToId: null,
      editedAt,
      createdAt: 1_000,
    },
  };
}

function closeReopenEvent(eventType: 'dm_close' | 'dm_reopen', timestamp: number): FederationRelayEvent {
  return {
    eventType,
    dmChannelId: 'ch-home',
    messageId: `${eventType}:${FED_ID}:alice`,
    federatedId: FED_ID,
    encryptionVersion: 0,
    timestamp,
    dmCloseReopen: { homeUserId: 'alice', homeInstance: HOME_ORIGIN },
  };
}

async function apply(event: FederationRelayEvent, delivery: 'live' | 'catch_up' = 'live') {
  const { processRelayEvents } = await import('./federation/events/dispatch.js');
  return processRelayEvents([event], HOME_ORIGIN, HOME_ORIGIN, db, { delivery });
}

function memberRow(userId: string): { closed: number | null; closedChangedAt: number } {
  const row = db.select({ closed: schema.dmMembers.closed, closedChangedAt: schema.dmMembers.closedChangedAt })
    .from(schema.dmMembers)
    .where(and(eq(schema.dmMembers.dmChannelId, CHANNEL), eq(schema.dmMembers.userId, userId)))
    .get();
  if (!row) throw new Error(`no member row for ${userId}`);
  return row;
}

function messageBySource(sourceMessageId: string) {
  return db.select().from(schema.dmMessages)
    .where(and(eq(schema.dmMessages.sourceInstance, HOME_ORIGIN), eq(schema.dmMessages.sourceMessageId, sourceMessageId)))
    .get();
}

type Sent = { userId: string; type: string };
let sentToUser: Sent[];
let sentToDmMembers: Array<{ channelId: string; type: string }>;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  db = drizzle(sqlite, { schema });
  applyMigrations(sqlite);
  db.insert(schema.federationPeers).values({
    id: 'peer-home', origin: HOME_ORIGIN, hmacSecret: 'b'.repeat(64), status: 'active', createdAt: 1,
  }).run();
  seedUser({ id: 'bob', username: 'bob', passwordHash: 'real-hash', homeInstance: null });
  seedUser({ id: 'alice-on-orbit', username: 'alice@home.test', homeInstance: 'home.test', homeUserId: 'alice' });
  db.insert(schema.dmChannels).values({ id: CHANNEL, federatedId: FED_ID, createdAt: 1 }).run();
  db.insert(schema.dmMembers).values({ dmChannelId: CHANNEL, userId: 'bob', closed: 0, closedChangedAt: 1 }).run();
  db.insert(schema.dmMembers).values({ dmChannelId: CHANNEL, userId: 'alice-on-orbit', closed: 0, closedChangedAt: 1 }).run();

  const { connectionManager } = await import('../ws/handler.js');
  sentToUser = [];
  sentToDmMembers = [];
  vi.spyOn(connectionManager, 'sendToUser').mockImplementation((userId: string, event: { type: string }) => {
    sentToUser.push({ userId, type: event.type });
  });
  vi.spyOn(connectionManager, 'sendToDmMembers').mockImplementation((channelId: string, event: { type: string }) => {
    sentToDmMembers.push({ channelId, type: event.type });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dm_close / dm_reopen are last-writer-wins on the member row', () => {
  it('a replayed dm_close does not close a conversation a later message reopened', async () => {
    expect((await apply(closeReopenEvent('dm_close', 2_000))).accepted).toHaveLength(1);
    expect(memberRow('alice-on-orbit').closed).toBe(1);

    // A later message from alice reopens it for her.
    expect((await apply(createEvent('m-after-close', 3_000))).accepted).toEqual(['m-after-close']);
    expect(memberRow('alice-on-orbit').closed).toBe(0);

    sentToUser = [];
    const replay = await apply(closeReopenEvent('dm_close', 2_000));
    expect(replay.accepted).toHaveLength(1);
    expect(memberRow('alice-on-orbit').closed).toBe(0);
    expect(sentToUser.filter(s => s.type === 'dm_channel_closed')).toEqual([]);
  });

  it('a replayed dm_reopen does not undo a later close made here', async () => {
    const { setDmMemberClosed } = await import('../utils/dmMemberClosed.js');
    setDmMemberClosed(sqlite, CHANNEL, 'alice-on-orbit', true, 1_500);
    await apply(closeReopenEvent('dm_reopen', 2_000));
    expect(memberRow('alice-on-orbit').closed).toBe(0);

    // alice closes it again through this instance, later.
    setDmMemberClosed(sqlite, CHANNEL, 'alice-on-orbit', true, 9_000);

    sentToUser = [];
    await apply(closeReopenEvent('dm_reopen', 2_000));
    expect(memberRow('alice-on-orbit').closed).toBe(1);
    expect(sentToUser.filter(s => s.type === 'dm_channel_created')).toEqual([]);
  });

  it('the same dm_close applied twice tells the member once', async () => {
    await apply(closeReopenEvent('dm_close', 2_000));
    await apply(closeReopenEvent('dm_close', 2_001));
    expect(sentToUser.filter(s => s.type === 'dm_channel_closed')).toHaveLength(1);
    expect(memberRow('alice-on-orbit')).toEqual({ closed: 1, closedChangedAt: 2_001 });
  });
});

describe('a relayed message reopens only a conversation closed before it was written', () => {
  it('a late old message leaves a later close in place; a newer one reopens', async () => {
    const { setDmMemberClosed } = await import('../utils/dmMemberClosed.js');
    setDmMemberClosed(sqlite, CHANNEL, 'bob', true, 5_000);

    await apply(createEvent('m-old', 4_000), 'catch_up');
    expect(messageBySource('m-old')).toBeDefined();
    expect(memberRow('bob').closed).toBe(1);

    await apply(createEvent('m-new', 6_000));
    expect(memberRow('bob').closed).toBe(0);
  });
});

describe('a create that arrives through a pull raises nothing live', () => {
  it('stores the message and sends no dm_message_created', async () => {
    const result = await apply(createEvent('m-pulled', 4_000), 'catch_up');
    expect(result.accepted).toEqual(['m-pulled']);
    expect(messageBySource('m-pulled')).toBeDefined();
    expect(sentToUser.filter(s => s.type === 'dm_message_created')).toEqual([]);
  });

  it('a live create still does', async () => {
    await apply(createEvent('m-live', 4_000));
    expect(sentToUser.filter(s => s.type === 'dm_message_created').map(s => s.userId).sort())
      .toEqual(['alice-on-orbit', 'bob']);
  });
});

describe('update is last-writer-wins on editedAt', () => {
  it('a replayed edit changes nothing and sends nothing', async () => {
    await apply(createEvent('m1', 1_000, 'v1'));
    expect((await apply(updateEvent('m1', 'v2', 3_000))).accepted).toEqual(['m1']);
    expect(sentToDmMembers.filter(s => s.type === 'dm_message_updated')).toHaveLength(1);

    const replay = await apply(updateEvent('m1', 'v2', 3_000));
    expect(replay.accepted).toEqual(['m1']);
    expect(sentToDmMembers.filter(s => s.type === 'dm_message_updated')).toHaveLength(1);
    expect(messageBySource('m1')).toMatchObject({ content: 'v2', editedAt: 3_000 });
  });

  it('an older edit arriving after a newer one is ignored', async () => {
    await apply(createEvent('m1', 1_000, 'v1'));
    await apply(updateEvent('m1', 'v3', 4_000));
    const older = await apply(updateEvent('m1', 'v2', 3_000));
    expect(older.accepted).toEqual(['m1']);
    expect(messageBySource('m1')).toMatchObject({ content: 'v3', editedAt: 4_000 });
    expect(sentToDmMembers.filter(s => s.type === 'dm_message_updated')).toHaveLength(1);
  });

  it('an edit arriving after a duplicate create applies', async () => {
    await apply(createEvent('m1', 1_000, 'v1'));
    expect((await apply(createEvent('m1', 1_000, 'v1'))).rejected).toEqual([{ messageId: 'm1', reason: 'duplicate' }]);
    await apply(updateEvent('m1', 'v2', 3_000));
    expect(messageBySource('m1')).toMatchObject({ content: 'v2', editedAt: 3_000 });
  });
});

describe('a delete for a message not held here', () => {
  function deleteEvent(messageId: string, target?: FederationRelayEvent['target']): FederationRelayEvent {
    return {
      eventType: 'delete',
      dmChannelId: 'ch-home',
      messageId,
      encryptionVersion: 0,
      timestamp: 5_000,
      ...(target ? { target } : {}),
    };
  }

  it('is accepted, and a create for that message arriving later is a duplicate', async () => {
    const del = await apply(deleteEvent('m-late'));
    expect(del).toMatchObject({ accepted: ['m-late'], rejected: [] });

    const create = await apply(createEvent('m-late', 1_000));
    expect(create.rejected).toEqual([{ messageId: 'm-late', reason: 'duplicate' }]);
    expect(messageBySource('m-late')).toBeUndefined();
    expect(sentToUser.filter(s => s.type === 'dm_message_created')).toEqual([]);
  });

  it('with a target on the signing peer, also stands for the create', async () => {
    const del = await apply(deleteEvent('m-late-2', {
      federatedId: FED_ID,
      message: { messageId: 'm-late-2', messageHomeInstance: HOME_ORIGIN },
      actor: { homeUserId: 'alice', homeInstance: HOME_ORIGIN },
    }));
    expect(del.accepted).toEqual(['m-late-2']);
    expect((await apply(createEvent('m-late-2', 1_000))).rejected)
      .toEqual([{ messageId: 'm-late-2', reason: 'duplicate' }]);
  });

  it('naming a message homed elsewhere is accepted but blocks nothing', async () => {
    const del = await apply(deleteEvent('m-third', {
      federatedId: FED_ID,
      message: { messageId: 'm-third', messageHomeInstance: 'https://third.test' },
      actor: { homeUserId: 'alice', homeInstance: HOME_ORIGIN },
    }));
    expect(del.accepted).toEqual(['m-third']);
    const tombstones = db.select().from(schema.federationAppliedEvents).all();
    expect(tombstones).toEqual([]);
  });

  it('a delete of a held message still deletes it, and a replay of it is accepted', async () => {
    await apply(createEvent('m-held', 1_000));
    expect((await apply(deleteEvent('m-held'))).accepted).toEqual(['m-held']);
    expect(messageBySource('m-held')).toBeUndefined();
    expect((await apply(deleteEvent('m-held'))).accepted).toEqual(['m-held']);
    expect((await apply(createEvent('m-held', 1_000))).rejected)
      .toEqual([{ messageId: 'm-held', reason: 'duplicate' }]);
  });
});

describe('file_rejected', () => {
  beforeEach(() => {
    seedUser({ id: 'carol-home', username: 'carol@home.test', homeInstance: 'home.test', homeUserId: 'carol' });
    seedUser({ id: 'carol-other', username: 'carol@other.test', homeInstance: 'other.test', homeUserId: 'carol' });
    seedUser({ id: 'dave-home', username: 'dave@home.test', homeInstance: 'home.test', homeUserId: 'dave' });
    db.insert(schema.dmMessages).values({
      id: 'own-1', dmChannelId: CHANNEL, userId: 'bob', content: 'big file', createdAt: 1_000,
    }).run();
    db.insert(schema.attachments).values({
      id: 'att-1', dmMessageId: 'own-1', uploaderId: 'bob', filename: 'f.png', originalName: 'f.png',
      mimetype: 'image/png', size: 10, createdAt: 1_000,
    }).run();
  });

  function fileRejected(extra: Partial<FederationRelayEvent>): FederationRelayEvent {
    return {
      eventType: 'file_rejected',
      messageId: 'own-1',
      encryptionVersion: 0,
      timestamp: 5_000,
      attachmentId: 'remote-att',
      sourceFilename: 'f.png',
      rejectionReason: 'size_limit_exceeded',
      rejectionLimit: 5,
      ...extra,
    };
  }

  function meta(): Array<{ userId: string }> {
    const row = db.select({ meta: schema.attachments.federationMeta }).from(schema.attachments)
      .where(eq(schema.attachments.id, 'att-1')).get();
    return row?.meta ? JSON.parse(row.meta) as Array<{ userId: string }> : [];
  }

  it('matches each affected user by the whole identity when the sender names it', async () => {
    const result = await apply(fileRejected({
      affectedUserIds: ['carol'],
      affectedUsers: [{ homeUserId: 'carol', homeInstance: HOME_ORIGIN }],
    }));
    expect(result.accepted).toEqual(['own-1']);
    expect(meta().map(u => u.userId)).toEqual(['carol-home']);
  });

  it('from an older sender, matches a bare id only when exactly one user carries it', async () => {
    await apply(fileRejected({ affectedUserIds: ['carol', 'dave'] }));
    expect(meta().map(u => u.userId)).toEqual(['dave-home']);
  });

  it('a replay tells nobody again', async () => {
    const event = fileRejected({ affectedUsers: [{ homeUserId: 'dave', homeInstance: HOME_ORIGIN }] });
    await apply(event);
    expect(sentToUser.filter(s => s.type === 'federation_file_rejected')).toHaveLength(1);
    expect(sentToDmMembers.filter(s => s.type === 'dm_message_updated')).toHaveLength(1);

    expect((await apply(event)).accepted).toEqual(['own-1']);
    expect(sentToUser.filter(s => s.type === 'federation_file_rejected')).toHaveLength(1);
    expect(sentToDmMembers.filter(s => s.type === 'dm_message_updated')).toHaveLength(1);
  });
});
