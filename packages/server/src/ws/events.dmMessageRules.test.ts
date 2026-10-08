import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { MAX_MESSAGE_LENGTH } from '@backspace/shared';
import * as schema from '../db/schema.js';
import { setWorkerId, generateSnowflake } from '../utils/snowflake.js';

// #420: the WebSocket create, edit and delete paths for DM messages follow
// the REST routes' rules, including the read-only rule for a 1-on-1 whose
// partner was deleted, and every refusal carries an error code.

setWorkerId(1);

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

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

const sendToUser = vi.fn();
vi.mock('./handler.js', () => ({
  connectionManager: {
    sendToUser: (...args: unknown[]) => sendToUser(...args),
    sendToDmMembers: vi.fn(),
    sendToRoom: vi.fn(),
    sendToAdmins: vi.fn(),
    getUserRoom: () => undefined,
    getRoom: () => undefined,
    getAllRooms: () => new Map(),
    getAllOnlineUserIds: () => [],
  },
  getVoiceRoomElapsedSeconds: () => 0,
}));

const queueDmRelay = vi.fn();
const queueDmMessageDeleteRelay = vi.fn();
vi.mock('../utils/federationOutbox.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/federationOutbox.js')>('../utils/federationOutbox.js');
  return {
    ...actual,
    isFederationRelayEnabled: () => false,
    queueDmCloseRelay: vi.fn(),
    queueDmRelay: (...args: unknown[]) => queueDmRelay(...args),
    queueDmMessageDeleteRelay: (...args: unknown[]) => queueDmMessageDeleteRelay(...args),
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

interface SeedUserOpts {
  deleted?: boolean;
  homeUserId?: string;
  homeInstance?: string;
}

function seedUser(id: string, opts: SeedUserOpts = {}): void {
  testDb.insert(schema.users).values({
    id,
    username: opts.deleted ? `!deleted:${id}` : id,
    displayName: null,
    passwordHash: 'x',
    status: 'offline',
    isAdmin: 0,
    isDeleted: opts.deleted ? 1 : 0,
    discoverable: 1,
    homeInstance: opts.homeInstance ?? null,
    homeUserId: opts.homeUserId ?? null,
    createdAt: Date.now(),
  }).run();
}

function seedDm(id: string, memberIds: string[], ownerId: string | null = null): void {
  testDb.insert(schema.dmChannels).values({
    id,
    ownerId,
    federatedId: null,
    createdAt: Date.now(),
    metadataUpdatedAt: 0,
  }).run();
  for (const userId of memberIds) {
    testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId, closed: 0 }).run();
  }
}

function seedMessage(dmChannelId: string, userId: string, content: string, type: 'user' | 'system' = 'user'): string {
  const id = generateSnowflake();
  testDb.insert(schema.dmMessages).values({
    id,
    dmChannelId,
    userId,
    replyToId: null,
    content,
    type,
    createdAt: Date.now(),
  }).run();
  return id;
}

function seedAttachment(id: string, uploaderId: string): void {
  testDb.insert(schema.attachments).values({
    id,
    uploaderId,
    filename: `${id}.png`,
    originalName: 'a.png',
    mimetype: 'image/png',
    size: 1,
    createdAt: Date.now(),
  }).run();
}

function messagesIn(dmChannelId: string): (typeof schema.dmMessages.$inferSelect)[] {
  return testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.dmChannelId, dmChannelId)).all();
}

function messageRow(id: string): typeof schema.dmMessages.$inferSelect | undefined {
  return testDb.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, id)).get();
}

async function send(event: Record<string, unknown>, userId = 'alice'): Promise<void> {
  const { handleClientEvent } = await import('./events.js');
  handleClientEvent(event, userId, userId, {} as WebSocket, false);
}

/** Every event the server sent, as `[recipient, event]` pairs. */
function sent(): [string, Record<string, unknown>][] {
  return sendToUser.mock.calls.map((c) => [c[0] as string, c[1] as Record<string, unknown>]);
}

function expectOnlyRefusal(userId: string, code: string, details?: Record<string, unknown>): void {
  const calls = sent();
  expect(calls).toHaveLength(1);
  const [recipient, event] = calls[0]!;
  expect(recipient).toBe(userId);
  expect(event.type).toBe('error');
  expect(event.code).toBe(code);
  expect(typeof event.message).toBe('string');
  if (details) expect(event.details).toEqual(details);
  else expect(event.details).toBeUndefined();
}

// Dead 1-on-1s: alice with a deleted native user, alice with a deleted
// replicated user, and a federated account acting here with a deleted native
// user. Live conversations: a 1-on-1 and a group that still holds a deleted
// member's row.
const DEAD_LOCAL = 'dm-dead-local';
const DEAD_REMOTE = 'dm-dead-remote';
const DEAD_FOR_FEDERATED = 'dm-dead-federated';
const LIVE = 'dm-live';
const GROUP = 'dm-group';

beforeEach(() => {
  sqlite = new Database(':memory:');
  testDb = drizzle(sqlite, { schema });
  applyMigrations(sqlite);

  seedUser('alice');
  seedUser('bob');
  seedUser('gone', { deleted: true });
  seedUser('gone-remote', { deleted: true, homeUserId: 'r-gone-1', homeInstance: 'https://orbit.test' });
  seedUser('fed-carol', { homeUserId: 'r-carol-1', homeInstance: 'https://orbit.test' });

  seedDm(DEAD_LOCAL, ['alice', 'gone']);
  seedDm(DEAD_REMOTE, ['alice', 'gone-remote']);
  seedDm(DEAD_FOR_FEDERATED, ['fed-carol', 'gone']);
  seedDm(LIVE, ['alice', 'bob']);
  seedDm(GROUP, ['alice', 'bob', 'gone'], 'alice');

  currentUserId = 'alice';
  sendToUser.mockClear();
  queueDmRelay.mockClear();
  queueDmMessageDeleteRelay.mockClear();
});

describe('WS DM message writes in a 1-on-1 whose partner was deleted', () => {
  it.each([
    ['a deleted user of this instance', DEAD_LOCAL, 'alice'],
    ['a deleted replicated user', DEAD_REMOTE, 'alice'],
    ['a federated account acting here', DEAD_FOR_FEDERATED, 'fed-carol'],
  ])('refuses dm_message_create with %s, stores and sends nothing', async (_label, dmId, userId) => {
    await send({ type: 'dm_message_create', dmChannelId: dmId, content: 'hello?' }, userId);

    expectOnlyRefusal(userId, 'recipient_deleted');
    expect(messagesIn(dmId)).toHaveLength(0);
    expect(queueDmRelay).not.toHaveBeenCalled();
  });

  it('refuses an attachment-only create and leaves the attachment unlinked', async () => {
    seedAttachment('att-1', 'alice');

    await send({ type: 'dm_message_create', dmChannelId: DEAD_LOCAL, attachments: ['att-1'] });

    expectOnlyRefusal('alice', 'recipient_deleted');
    const att = testDb.select().from(schema.attachments).where(eq(schema.attachments.id, 'att-1')).get();
    expect(att?.dmMessageId).toBeNull();
  });

  it.each([
    ['a deleted user of this instance', DEAD_LOCAL, 'alice'],
    ['a deleted replicated user', DEAD_REMOTE, 'alice'],
    ['a federated account acting here', DEAD_FOR_FEDERATED, 'fed-carol'],
  ])('refuses dm_message_edit with %s and keeps the text', async (_label, dmId, userId) => {
    const id = seedMessage(dmId, userId, 'before');

    await send({ type: 'dm_message_edit', messageId: id, content: 'after' }, userId);

    expectOnlyRefusal(userId, 'recipient_deleted');
    expect(messageRow(id)?.content).toBe('before');
    expect(messageRow(id)?.editedAt).toBeNull();
    expect(queueDmRelay).not.toHaveBeenCalled();
  });

  it.each([
    ['a deleted user of this instance', DEAD_LOCAL, 'alice'],
    ['a deleted replicated user', DEAD_REMOTE, 'alice'],
    ['a federated account acting here', DEAD_FOR_FEDERATED, 'fed-carol'],
  ])('refuses dm_message_delete with %s and keeps the message', async (_label, dmId, userId) => {
    const id = seedMessage(dmId, userId, 'keep me');

    await send({ type: 'dm_message_delete', messageId: id }, userId);

    expectOnlyRefusal(userId, 'recipient_deleted');
    expect(messageRow(id)).toBeDefined();
    expect(queueDmMessageDeleteRelay).not.toHaveBeenCalled();
  });
});

describe('WS DM message writes where the rule does not apply', () => {
  it.each([
    ['a live 1-on-1', LIVE],
    ['a group that holds a deleted member', GROUP],
  ])('creates, edits and deletes in %s', async (_label, dmId) => {
    await send({ type: 'dm_message_create', dmChannelId: dmId, content: 'hi' });
    const [created] = messagesIn(dmId);
    expect(created?.content).toBe('hi');
    expect(sent().some(([, e]) => e.type === 'dm_message_created')).toBe(true);
    expect(sent().some(([, e]) => e.type === 'error')).toBe(false);

    sendToUser.mockClear();
    await send({ type: 'dm_message_edit', messageId: created!.id, content: 'hi again' });
    expect(messageRow(created!.id)?.content).toBe('hi again');
    expect(sent().some(([, e]) => e.type === 'dm_message_updated')).toBe(true);

    sendToUser.mockClear();
    await send({ type: 'dm_message_delete', messageId: created!.id });
    expect(messageRow(created!.id)).toBeUndefined();
    expect(sent().some(([, e]) => e.type === 'dm_message_deleted')).toBe(true);
    expect(sent().some(([, e]) => e.type === 'error')).toBe(false);
  });
});

describe('every other refusal on the WS DM message paths carries a code', () => {
  it.each<[string, Record<string, unknown>, string, Record<string, unknown>?]>([
    ['create without dmChannelId', { type: 'dm_message_create', content: 'x' }, 'validation_failed'],
    ['create in a DM the user is not in', { type: 'dm_message_create', dmChannelId: DEAD_FOR_FEDERATED, content: 'x' }, 'not_dm_member'],
    ['create with nothing in it', { type: 'dm_message_create', dmChannelId: LIVE, content: '   ' }, 'content_required'],
    ['create with text that is too long', { type: 'dm_message_create', dmChannelId: LIVE, content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }, 'content_too_long', { max: MAX_MESSAGE_LENGTH }],
    ['create with content that is not text', { type: 'dm_message_create', dmChannelId: LIVE, content: 42 }, 'validation_failed'],
    ['create with attachments that are not a list', { type: 'dm_message_create', dmChannelId: LIVE, content: 'x', attachments: 'att' }, 'validation_failed'],
    ['create replying to a message elsewhere', { type: 'dm_message_create', dmChannelId: LIVE, content: 'x', replyToId: 'no-such-message' }, 'reply_target_invalid'],
    ['create with an unknown attachment', { type: 'dm_message_create', dmChannelId: LIVE, attachments: ['no-such-att'] }, 'attachment_invalid'],
  ])('%s', async (_label, event, code, details) => {
    await send(event);
    expectOnlyRefusal('alice', code, details);
    expect(messagesIn(LIVE)).toHaveLength(0);
  });

  it('create with an attachment another user uploaded', async () => {
    seedAttachment('att-bob', 'bob');
    await send({ type: 'dm_message_create', dmChannelId: LIVE, attachments: ['att-bob'] });
    expectOnlyRefusal('alice', 'attachment_not_owned');
    expect(messagesIn(LIVE)).toHaveLength(0);
  });

  it.each<[string, (ids: { own: string; bobs: string; system: string }) => Record<string, unknown>, string, Record<string, unknown>?]>([
    ['edit without messageId', () => ({ type: 'dm_message_edit', content: 'x' }), 'validation_failed'],
    ['edit to empty text', ({ own }) => ({ type: 'dm_message_edit', messageId: own, content: ' ' }), 'content_required'],
    ['edit to text that is too long', ({ own }) => ({ type: 'dm_message_edit', messageId: own, content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }), 'content_too_long', { max: MAX_MESSAGE_LENGTH }],
    ['edit of an unknown message', () => ({ type: 'dm_message_edit', messageId: 'no-such-message', content: 'x' }), 'message_not_found'],
    ['edit of another user\'s message', ({ bobs }) => ({ type: 'dm_message_edit', messageId: bobs, content: 'x' }), 'not_message_author'],
    ['edit of a system message', ({ system }) => ({ type: 'dm_message_edit', messageId: system, content: 'x' }), 'system_message_immutable'],
    ['delete without messageId', () => ({ type: 'dm_message_delete' }), 'validation_failed'],
    ['delete of an unknown message', () => ({ type: 'dm_message_delete', messageId: 'no-such-message' }), 'message_not_found'],
    ['delete of another user\'s message', ({ bobs }) => ({ type: 'dm_message_delete', messageId: bobs }), 'not_message_author'],
  ])('%s', async (_label, build, code, details) => {
    const ids = {
      own: seedMessage(LIVE, 'alice', 'mine'),
      bobs: seedMessage(LIVE, 'bob', 'his'),
      system: seedMessage(LIVE, 'alice', '{"type":"member_added"}', 'system'),
    };

    await send(build(ids));

    expectOnlyRefusal('alice', code, details);
    expect(messagesIn(LIVE).map((m) => [m.id, m.content, m.editedAt])).toEqual(expect.arrayContaining([
      [ids.own, 'mine', null],
      [ids.bobs, 'his', null],
    ]));
    expect(messagesIn(LIVE)).toHaveLength(3);
    expect(queueDmRelay).not.toHaveBeenCalled();
    expect(queueDmMessageDeleteRelay).not.toHaveBeenCalled();
  });
});

describe('the REST routes answer from the same checks', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    const { dmRoutes } = await import('../routes/dm.js');
    await app.register(dmRoutes);
    await app.ready();
  });

  it('refuses create, edit and delete in a 1-on-1 whose partner was deleted', async () => {
    const id = seedMessage(DEAD_REMOTE, 'alice', 'before');

    const create = await app.inject({ method: 'POST', url: `/api/dm/${DEAD_REMOTE}/messages`, payload: { content: 'hi' } });
    const edit = await app.inject({ method: 'PATCH', url: `/api/dm/messages/${id}`, payload: { content: 'after' } });
    const del = await app.inject({ method: 'DELETE', url: `/api/dm/messages/${id}` });

    for (const res of [create, edit, del]) {
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('recipient_deleted');
    }
    expect(messagesIn(DEAD_REMOTE)).toHaveLength(1);
    expect(messageRow(id)?.content).toBe('before');
  });

  it('sends the length limit with content_too_long', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/dm/${LIVE}/messages`,
      payload: { content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { code: string; details?: Record<string, unknown> };
    expect(body.code).toBe('content_too_long');
    expect(body.details).toEqual({ max: MAX_MESSAGE_LENGTH });
  });

  it('creates in a live 1-on-1', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/dm/${LIVE}/messages`, payload: { content: ' hi ' } });
    expect(res.statusCode).toBe(201);
    expect(messagesIn(LIVE).map((m) => m.content)).toEqual(['hi']);
  });
});
