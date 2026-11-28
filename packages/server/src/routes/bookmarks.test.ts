import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EVERYONE_PERMISSIONS, permissionsToString } from '@backspace/shared/src/permissions.js';
import type { Bookmark, BookmarkPage } from '@backspace/shared/src/bookmarks.js';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';

setWorkerId(1);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let currentUserId = 'alice';

const hoisted = vi.hoisted(() => ({ uploadDir: '', deleted: [] as string[], sent: [] as Array<{ userId: string; event: unknown }> }));

vi.mock('../db/index.js', () => ({
  getDb: () => testDb,
  getRawDb: () => sqlite,
  schema,
}));

vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: (userId: string, event: unknown) => { hoisted.sent.push({ userId, event }); },
  },
}));

vi.mock('../utils/auth.js', () => ({
  authenticate: async (req: { userId?: string }) => {
    req.userId = currentUserId;
  },
}));

vi.mock('../utils/federationAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/federationAuth.js')>();
  return { ...actual, getOurOrigin: () => 'https://local.test' };
});

vi.mock('../config.js', async (importActual) => {
  const actual = await importActual<typeof import('../config.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, key) => (key === 'uploadDir' ? hoisted.uploadDir : Reflect.get(target, key)),
    }),
  };
});

vi.mock('../utils/fileCleanup.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fileCleanup.js')>('../utils/fileCleanup.js');
  return { ...actual, deleteUploadFile: vi.fn((filename: string) => { hoisted.deleted.push(filename); }) };
});

const NOW = 1_800_000_000_000;

function applyMigrations(db: Database.Database): void {
  const migrationsDir = path.resolve(__dirname, '../../drizzle');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    for (const stmt of sqlText.split(/-->\s*statement-breakpoint/)) {
      const clean = stmt.trim();
      if (clean) db.exec(clean);
    }
  }
}

function addUser(id: string, displayName: string | null = null, username: string = id): void {
  testDb.insert(schema.users).values({
    id, username, displayName, passwordHash: 'x', homeUserId: id, homeInstance: 'https://local.test', createdAt: NOW,
  }).run();
}

/** A space `sp-1` owned by bob with a text channel `ch-1`; alice is a member, carol is not. */
function seedSpace(): void {
  testDb.insert(schema.spaces).values({ id: 'sp-1', name: 'Garden', ownerId: 'bob', createdAt: NOW }).run();
  testDb.insert(schema.roles).values({
    id: 'sp-1', spaceId: 'sp-1', name: '@everyone', position: 0,
    permissions: permissionsToString(DEFAULT_EVERYONE_PERMISSIONS), createdAt: NOW,
  }).run();
  testDb.insert(schema.channels).values({ id: 'ch-1', spaceId: 'sp-1', name: 'general', type: 'text', createdAt: NOW }).run();
  for (const userId of ['alice', 'bob']) {
    testDb.insert(schema.spaceMembers).values({ spaceId: 'sp-1', userId, joinedAt: NOW }).run();
  }
}

function addMessage(id: string, content: string | null, opts: { userId?: string; type?: 'user' | 'system' } = {}): void {
  testDb.insert(schema.messages).values({
    id, channelId: 'ch-1', userId: opts.userId ?? 'bob', content, type: opts.type ?? 'user', createdAt: NOW,
  }).run();
}

function addDm(id: string, members: string[], name: string | null = null, ownerId: string | null = null): void {
  testDb.insert(schema.dmChannels).values({ id, ownerId, name, createdAt: NOW }).run();
  for (const userId of members) testDb.insert(schema.dmMembers).values({ dmChannelId: id, userId }).run();
}

function addDmMessage(id: string, dmChannelId: string, content: string, userId: string = 'bob'): void {
  testDb.insert(schema.dmMessages).values({ id, dmChannelId, userId, content, createdAt: NOW }).run();
}

function addUpload(filename: string): void {
  fs.writeFileSync(path.join(hoisted.uploadDir, filename), 'data');
}

function addAttachment(id: string, owner: { messageId?: string; dmMessageId?: string }, filename: string): void {
  testDb.insert(schema.attachments).values({
    id, ...owner, filename, originalName: `${id}.png`, mimetype: 'image/png', size: 4,
    thumbnailFilename: null, width: 10, height: 20, createdAt: NOW,
  }).run();
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { bookmarkRoutes } = await import('./bookmarks.js');
  await app.register(bookmarkRoutes);
  await app.ready();
  return app;
}

async function put(app: FastifyInstance, kind: string, messageId: string) {
  return app.inject({ method: 'PUT', url: `/api/bookmarks/${kind}/${messageId}` });
}

async function list(app: FastifyInstance, query = ''): Promise<{ status: number; body: BookmarkPage }> {
  const res = await app.inject({ method: 'GET', url: `/api/bookmarks${query}` });
  return { status: res.statusCode, body: res.json() as BookmarkPage };
}

describe('bookmarks', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    hoisted.uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-test-'));
    hoisted.deleted.length = 0;
    hoisted.sent.length = 0;
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    testDb = drizzle(sqlite, { schema });
    applyMigrations(sqlite);
    addUser('alice', 'Alice');
    addUser('bob', 'Bob');
    addUser('carol', 'Carol');
    seedSpace();
    currentUserId = 'alice';
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(hoisted.uploadDir, { recursive: true, force: true });
  });

  describe('PUT /api/bookmarks/:kind/:messageId', () => {
    it('saves a copy of a channel message with where it was written', async () => {
      addMessage('m-1', 'hello garden');
      const res = await put(app, 'channel', 'm-1');
      expect(res.statusCode).toBe(201);
      const body = res.json() as Bookmark;
      expect(body).toMatchObject({
        kind: 'channel', messageId: 'm-1', channelId: 'ch-1', spaceId: 'sp-1',
        content: 'hello garden', authorId: 'bob', authorName: 'Bob',
        spaceName: 'Garden', channelName: 'general', instanceOrigin: 'https://local.test',
        messageCreatedAt: NOW, status: 'ok', attachments: [],
      });
    });

    it('is idempotent: a second save returns the same bookmark with 200', async () => {
      addMessage('m-1', 'hello');
      const first = (await put(app, 'channel', 'm-1')).json() as Bookmark;
      const again = await put(app, 'channel', 'm-1');
      expect(again.statusCode).toBe(200);
      expect((again.json() as Bookmark).id).toBe(first.id);
      expect(testDb.select().from(schema.messageBookmarks).all()).toHaveLength(1);
    });

    it('keeps the saved text when the original is edited later', async () => {
      addMessage('m-1', 'first draft');
      await put(app, 'channel', 'm-1');
      testDb.update(schema.messages).set({ content: 'rewritten' }).where(eq(schema.messages.id, 'm-1')).run();
      const { body } = await list(app);
      expect(body.items[0]).toMatchObject({ content: 'first draft', status: 'edited' });
    });

    it('names a 1-on-1 DM by the other member and a group DM by its name', async () => {
      addDm('dm-1', ['alice', 'bob']);
      addDmMessage('d-1', 'dm-1', 'psst');
      addDm('dm-2', ['alice', 'bob', 'carol'], 'Weekend plans', 'bob');
      addDmMessage('d-2', 'dm-2', 'saturday?');
      const one = (await put(app, 'dm', 'd-1')).json() as Bookmark;
      const group = (await put(app, 'dm', 'd-2')).json() as Bookmark;
      expect(one).toMatchObject({ kind: 'dm', spaceId: null, spaceName: null, channelName: 'Bob', authorName: 'Bob' });
      expect(group.channelName).toBe('Weekend plans');
    });

    it('answers 404 for a message the caller cannot read, like one that does not exist', async () => {
      addMessage('m-1', 'members only');
      currentUserId = 'carol';
      const hidden = await put(app, 'channel', 'm-1');
      const missing = await put(app, 'channel', 'no-such');
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toMatchObject({ code: 'message_not_found' });
      expect(missing.statusCode).toBe(404);
      expect(testDb.select().from(schema.messageBookmarks).all()).toHaveLength(0);
    });

    it('refuses a DM the caller is not in', async () => {
      addDm('dm-1', ['bob', 'carol']);
      addDmMessage('d-1', 'dm-1', 'private');
      const res = await put(app, 'dm', 'd-1');
      expect(res.statusCode).toBe(404);
    });

    it('refuses a system message and an unknown kind', async () => {
      addMessage('m-sys', 'Bob joined', { type: 'system' });
      expect((await put(app, 'channel', 'm-sys')).statusCode).toBe(400);
      expect((await put(app, 'thread', 'm-sys')).statusCode).toBe(400);
    });

    it('keeps the metadata and the original file name of every attachment', async () => {
      addMessage('m-1', null);
      addAttachment('a-1', { messageId: 'm-1' }, 'file-1.png');
      addUpload('file-1.png');
      const body = (await put(app, 'channel', 'm-1')).json() as Bookmark;
      expect(body.content).toBeNull();
      expect(body.attachments).toEqual([expect.objectContaining({
        originalName: 'a-1.png', mimetype: 'image/png', size: 4, width: 10, height: 20,
        state: 'available', filename: 'file-1.png',
      })]);
      const stored = testDb.select().from(schema.bookmarkAttachments).all();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ sourceFilename: 'file-1.png', filename: null, copyStatus: 'reference' });
    });
  });

  describe('status of the original', () => {
    it('is deleted, with the copy and file metadata intact, once the original is gone', async () => {
      addMessage('m-1', 'will vanish');
      addAttachment('a-1', { messageId: 'm-1' }, 'file-1.png');
      addUpload('file-1.png');
      await put(app, 'channel', 'm-1');
      // The message and, with it, its attachment row and file.
      testDb.delete(schema.messages).where(eq(schema.messages.id, 'm-1')).run();
      fs.rmSync(path.join(hoisted.uploadDir, 'file-1.png'));
      const { body } = await list(app);
      expect(body.items[0]).toMatchObject({ status: 'deleted', content: 'will vanish' });
      expect(body.items[0]?.attachments[0]).toMatchObject({ state: 'gone', filename: null, originalName: 'a-1.png', size: 4 });
    });

    it('is deleted when the whole channel was removed', async () => {
      addMessage('m-1', 'bye');
      await put(app, 'channel', 'm-1');
      testDb.delete(schema.channels).where(eq(schema.channels.id, 'ch-1')).run();
      const { body } = await list(app);
      expect(body.items[0]?.status).toBe('deleted');
    });

    it('is unavailable once the caller can no longer read the conversation', async () => {
      addMessage('m-1', 'secret');
      addDm('dm-1', ['alice', 'bob']);
      addDmMessage('d-1', 'dm-1', 'dm secret');
      await put(app, 'channel', 'm-1');
      await put(app, 'dm', 'd-1');
      testDb.delete(schema.spaceMembers).where(eq(schema.spaceMembers.userId, 'alice')).run();
      testDb.delete(schema.dmMembers).where(eq(schema.dmMembers.userId, 'alice')).run();
      const { body } = await list(app);
      expect(body.items.map((b) => b.status)).toEqual(['unavailable', 'unavailable']);
      // The saved copy is the reader's own and stays readable.
      expect(body.items.map((b) => b.content).sort()).toEqual(['dm secret', 'secret']);
    });
  });

  describe('GET /api/bookmarks', () => {
    function insertBookmark(id: string, createdAt: number, userId = 'alice'): void {
      testDb.insert(schema.messageBookmarks).values({
        id, userId, kind: 'channel', messageId: `msg-${id}`, channelId: 'ch-1', spaceId: 'sp-1',
        content: id, authorId: 'bob', authorName: 'Bob', spaceName: 'Garden', channelName: 'general',
        instanceOrigin: 'https://local.test', messageCreatedAt: NOW, createdAt,
      }).run();
    }

    it('pages newest first and resumes exactly after the last row, ties included', async () => {
      insertBookmark('b-1', 1000);
      insertBookmark('b-2', 2000);
      insertBookmark('b-3', 2000);
      insertBookmark('b-4', 3000);
      const first = await list(app, '?limit=2');
      expect(first.body.items.map((b) => b.id)).toEqual(['b-4', 'b-3']);
      expect(first.body.nextCursor).not.toBeNull();
      const second = await list(app, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`);
      expect(second.body.items.map((b) => b.id)).toEqual(['b-2', 'b-1']);
      expect(second.body.nextCursor).toBeNull();
    });

    it('rejects a cursor this server did not issue and a limit over the maximum', async () => {
      expect((await list(app, '?cursor=garbage')).status).toBe(400);
      expect((await list(app, '?limit=101')).status).toBe(400);
    });

    it('shows only the caller their own bookmarks', async () => {
      insertBookmark('b-mine', 1000, 'alice');
      insertBookmark('b-theirs', 2000, 'carol');
      expect((await list(app)).body.items.map((b) => b.id)).toEqual(['b-mine']);
      currentUserId = 'carol';
      expect((await list(app)).body.items.map((b) => b.id)).toEqual(['b-theirs']);
    });
  });

  describe('GET /api/bookmarks/keys', () => {
    it('lists the bookmarked message ids of one conversation only', async () => {
      testDb.insert(schema.channels).values({ id: 'ch-2', spaceId: 'sp-1', name: 'other', type: 'text', createdAt: NOW }).run();
      addMessage('m-1', 'one');
      addMessage('m-2', 'two');
      testDb.insert(schema.messages).values({ id: 'm-3', channelId: 'ch-2', userId: 'bob', content: 'three', createdAt: NOW }).run();
      await put(app, 'channel', 'm-1');
      await put(app, 'channel', 'm-3');
      const res = await app.inject({ method: 'GET', url: '/api/bookmarks/keys?kind=channel&channelId=ch-1' });
      expect(res.json()).toEqual(['m-1']);
      const missing = await app.inject({ method: 'GET', url: '/api/bookmarks/keys?kind=channel' });
      expect(missing.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/bookmarks/:kind/:messageId', () => {
    it('removes the bookmark and its attachment rows, and is idempotent', async () => {
      addMessage('m-1', 'bye');
      addAttachment('a-1', { messageId: 'm-1' }, 'file-1.png');
      await put(app, 'channel', 'm-1');
      const first = await app.inject({ method: 'DELETE', url: '/api/bookmarks/channel/m-1' });
      const again = await app.inject({ method: 'DELETE', url: '/api/bookmarks/channel/m-1' });
      expect(first.json()).toEqual({ success: true });
      expect(again.statusCode).toBe(200);
      expect(testDb.select().from(schema.messageBookmarks).all()).toHaveLength(0);
      expect(testDb.select().from(schema.bookmarkAttachments).all()).toHaveLength(0);
    });

    it('never deletes the original message or the original file', async () => {
      addMessage('m-1', 'keep me');
      addAttachment('a-1', { messageId: 'm-1' }, 'file-1.png');
      addUpload('file-1.png');
      await put(app, 'channel', 'm-1');
      await app.inject({ method: 'DELETE', url: '/api/bookmarks/channel/m-1' });
      expect(hoisted.deleted).toEqual([]);
      expect(fs.existsSync(path.join(hoisted.uploadDir, 'file-1.png'))).toBe(true);
      expect(testDb.select().from(schema.messages).all()).toHaveLength(1);
      expect(testDb.select().from(schema.attachments).all()).toHaveLength(1);
    });

    it('deletes the files a bookmark owns, and only those', async () => {
      addMessage('m-1', 'copied');
      addAttachment('a-1', { messageId: 'm-1' }, 'orig.png');
      const created = (await put(app, 'channel', 'm-1')).json() as Bookmark;
      testDb.update(schema.bookmarkAttachments)
        .set({ filename: 'copy.png', thumbnailFilename: 'copy-thumb.png', copyStatus: 'copied' })
        .where(eq(schema.bookmarkAttachments.bookmarkId, created.id)).run();
      await app.inject({ method: 'DELETE', url: '/api/bookmarks/channel/m-1' });
      expect(hoisted.deleted).toEqual(['copy.png']);
    });

    it('does not touch another user\'s bookmark of the same message', async () => {
      addMessage('m-1', 'shared');
      await put(app, 'channel', 'm-1');
      currentUserId = 'bob';
      await put(app, 'channel', 'm-1');
      await app.inject({ method: 'DELETE', url: '/api/bookmarks/channel/m-1' });
      const left = testDb.select().from(schema.messageBookmarks).all();
      expect(left).toHaveLength(1);
      expect(left[0]?.userId).toBe('alice');
    });
  });

  describe('WebSocket events', () => {
    it('tells only the caller, once, when a bookmark is created', async () => {
      addMessage('m-1', 'hello');
      const created = (await put(app, 'channel', 'm-1')).json() as Bookmark;
      await put(app, 'channel', 'm-1');
      expect(hoisted.sent).toEqual([{ userId: 'alice', event: { type: 'bookmark_added', bookmark: created } }]);
    });

    it('sends nothing for a refused create', async () => {
      await put(app, 'channel', 'missing');
      expect(hoisted.sent).toEqual([]);
    });

    it('tells the caller which conversation a removed bookmark was in, and nothing for a no-op removal', async () => {
      addMessage('m-1', 'bye');
      await put(app, 'channel', 'm-1');
      hoisted.sent.length = 0;
      await app.inject({ method: 'DELETE', url: '/api/bookmarks/channel/m-1' });
      await app.inject({ method: 'DELETE', url: '/api/bookmarks/channel/m-1' });
      expect(hoisted.sent).toEqual([
        { userId: 'alice', event: { type: 'bookmark_removed', kind: 'channel', channelId: 'ch-1', messageId: 'm-1' } },
      ]);
    });
  });

  describe('lifecycle', () => {
    it('purgeUserBookmarks removes every bookmark of the user and returns the files they owned', async () => {
      const { purgeUserBookmarks } = await import('../utils/bookmarks.js');
      addMessage('m-1', 'one');
      addMessage('m-2', 'two');
      addAttachment('a-1', { messageId: 'm-1' }, 'orig-1.png');
      const first = (await put(app, 'channel', 'm-1')).json() as Bookmark;
      await put(app, 'channel', 'm-2');
      testDb.update(schema.bookmarkAttachments)
        .set({ filename: 'copy-1.png', copyStatus: 'copied' })
        .where(eq(schema.bookmarkAttachments.bookmarkId, first.id)).run();
      currentUserId = 'bob';
      await put(app, 'channel', 'm-1');

      const files = testDb.transaction((tx) => purgeUserBookmarks(tx, 'alice'));
      expect(files).toEqual(['copy-1.png']);
      const left = testDb.select().from(schema.messageBookmarks).all();
      expect(left.map((row) => row.userId)).toEqual(['bob']);
      // Only the attachment row of the other user's bookmark is left.
      const attachmentsLeft = testDb.select().from(schema.bookmarkAttachments).all();
      expect(attachmentsLeft.map((row) => row.bookmarkId)).toEqual([left[0]?.id]);
      expect(attachmentsLeft[0]?.filename).toBeNull();
    });

    it('purgeUserBookmarks handles more bookmarks than SQLite binds in one statement', async () => {
      const { purgeUserBookmarks } = await import('../utils/bookmarks.js');
      const insert = sqlite.prepare(`INSERT INTO message_bookmarks
        (id, user_id, kind, message_id, channel_id, content, author_id, author_name, instance_origin, message_created_at, created_at)
        VALUES (?, 'alice', 'channel', ?, 'ch-1', 'x', 'bob', 'Bob', 'https://local.test', 1, 1)`);
      sqlite.transaction(() => {
        for (let i = 0; i < 40_000; i += 1) insert.run(`b-${i}`, `m-${i}`);
      })();
      testDb.transaction((tx) => purgeUserBookmarks(tx, 'alice'));
      expect(testDb.select().from(schema.messageBookmarks).all()).toHaveLength(0);
    });

    it('a file a bookmark owns is not an orphan to the storage janitor', async () => {
      const { getStorageStats } = await import('../utils/storageJanitor.js');
      addMessage('m-1', 'copied');
      addAttachment('a-1', { messageId: 'm-1' }, 'orig.png');
      const created = (await put(app, 'channel', 'm-1')).json() as Bookmark;
      addUpload('copy.png');
      expect(getStorageStats().orphanedFiles).toBe(1);
      testDb.update(schema.bookmarkAttachments)
        .set({ filename: 'copy.png', copyStatus: 'copied' })
        .where(eq(schema.bookmarkAttachments.bookmarkId, created.id)).run();
      expect(getStorageStats().orphanedFiles).toBe(0);
    });
  });
});
