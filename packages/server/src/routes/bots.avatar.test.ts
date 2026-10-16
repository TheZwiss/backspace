import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { setWorkerId } from '../utils/snowflake.js';
import { signJwt } from '../utils/auth.js';

/**
 * PATCH /api/bots/:id { avatar }: the file must be the owner's own upload that
 * no message holds. Any other file on disk belongs to someone else, and a later
 * change of avatar deletes the previous one.
 */

const UPLOAD_DIR = await vi.hoisted(async () => {
  const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([import('node:fs'), import('node:os'), import('node:path')]);
  const dir = mkdtempSync(join(tmpdir(), 'bs-bot-avatar-'));
  process.env.UPLOAD_DIR = dir;
  return dir;
});

setWorkerId(29);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TestDb = ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let testDb: TestDb;
let app: FastifyInstance;

vi.mock('../db/index.js', () => ({ getDb: () => testDb, getRawDb: () => sqlite, schema }));
vi.mock('../ws/handler.js', () => ({
  connectionManager: {
    sendToUser: vi.fn(),
    sendToSpace: vi.fn(),
    sendToDmMembers: vi.fn(),
    forceDisconnectUser: vi.fn(),
    removeUserSpace: vi.fn(),
    addUserSpace: vi.fn(),
  },
}));
// Only the resize is replaced (the files are not images); the rest of the module is used as is.
vi.mock('../utils/thumbnail.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/thumbnail.js')>()),
  resizeProfileImage: vi.fn(async () => undefined),
}));
vi.mock('../utils/profileRelay.js', () => ({ queueProfileUpdateRelay: vi.fn() }));

function applyMigrations(db: Database.Database): void {
  const dir = path.resolve(__dirname, '../../drizzle');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(dir, f), 'utf8').split(/-->\s*statement-breakpoint/)) {
      if (stmt.trim()) db.exec(stmt.trim());
    }
  }
}

const owner = () => ({ Authorization: `Bearer ${signJwt({ userId: 'owner', username: 'owner' })}` });

/** A file on disk with its upload record, as the tus upload leaves it. */
function upload(filename: string, uploaderId: string, holder: { messageId?: string; dmMessageId?: string } = {}): void {
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), 'img');
  testDb.insert(schema.attachments).values({
    id: `att-${filename}`,
    uploaderId,
    messageId: holder.messageId ?? null,
    dmMessageId: holder.dmMessageId ?? null,
    filename,
    originalName: 'a.webp',
    mimetype: 'image/webp',
    size: 3,
    createdAt: 1,
  }).run();
}

const setAvatar = (avatar: string | null) => app.inject({
  method: 'PATCH', url: '/api/bots/bot-1', headers: owner(), payload: { avatar },
});
const botAvatar = () => testDb.select().from(schema.users).where(eq(schema.users.id, 'bot-1')).get()?.avatar ?? null;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  // Foreign keys explicitly off: a held upload only needs a message id, not the message.
  sqlite.pragma('foreign_keys = OFF');
  testDb = drizzle(sqlite, { schema });
  testDb.insert(schema.users).values([
    { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
    { id: 'stranger', username: 'stranger', passwordHash: 'x', createdAt: 1 },
    { id: 'bot-1', username: 'radio_bot', passwordHash: '!bot', isBot: 1, botOwnerId: 'owner', createdAt: 1 },
  ]).run();
  const { botRoutes } = await import('./bots.js');
  app = Fastify({ logger: false });
  await app.register(botRoutes);
  await app.ready();
});

describe('the avatar of a bot', () => {
  it("takes the owner's own loose upload and drops its upload record", async () => {
    upload('mine.webp', 'owner');
    const res = await setAvatar('mine.webp');
    expect(res.statusCode).toBe(200);
    expect(botAvatar()).toBe('mine.webp');
    expect(testDb.select().from(schema.attachments).where(eq(schema.attachments.filename, 'mine.webp')).get()).toBeUndefined();
  });

  it("refuses someone else's upload and leaves the bot as it was", async () => {
    upload('theirs.webp', 'stranger');
    const res = await setAvatar('theirs.webp');
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('avatar_url_invalid');
    expect(botAvatar()).toBeNull();
  });

  it('refuses an upload a message already holds, even the owner\'s', async () => {
    upload('in-channel.webp', 'owner', { messageId: 'm1' });
    upload('in-dm.webp', 'owner', { dmMessageId: 'd1' });
    expect((await setAvatar('in-channel.webp')).statusCode).toBe(400);
    expect((await setAvatar('in-dm.webp')).statusCode).toBe(400);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'in-channel.webp'))).toBe(true);
  });

  it('refuses a file on disk that has no upload record', async () => {
    fs.writeFileSync(path.join(UPLOAD_DIR, 'stray.webp'), 'img');
    expect((await setAvatar('stray.webp')).statusCode).toBe(400);
  });

  it('refuses a path instead of a bare filename', async () => {
    upload('mine3.webp', 'owner');
    for (const avatar of ['../mine3.webp', './mine3.webp', 'x/../mine3.webp', '/api/uploads/../mine3.webp', '/etc/passwd', '..', '.hidden']) {
      const res = await setAvatar(avatar);
      expect([res.statusCode, (res.json() as { code: string }).code], avatar).toEqual([400, 'avatar_url_invalid']);
    }
    expect(botAvatar()).toBeNull();
    expect((await setAvatar('/api/uploads/mine3.webp')).statusCode).toBe(200);
    expect(botAvatar()).toBe('mine3.webp');
  });

  it('keeps its current avatar when the same file is sent again, and can drop it', async () => {
    upload('mine2.webp', 'owner');
    expect((await setAvatar('mine2.webp')).statusCode).toBe(200);
    expect((await setAvatar('mine2.webp')).statusCode).toBe(200);
    expect(botAvatar()).toBe('mine2.webp');
    expect((await setAvatar(null)).statusCode).toBe(200);
    expect(botAvatar()).toBeNull();
  });
});
