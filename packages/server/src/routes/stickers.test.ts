import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import * as schema from '../db/schema.js';
import { stickerUrl, MAX_STICKER_BYTES } from '@backspace/shared/src/stickers.js';

const settings = vi.hoisted(() => ({ uploadDir: '' }));
let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;
let app: FastifyInstance;
vi.mock('../db/index.js', () => ({ getDb: () => db, schema }));
vi.mock('../config.js', () => ({ config: settings }));
vi.mock('../utils/federationAuth.js', () => ({ getOurOrigin: () => 'https://chat.test' }));
vi.mock('../utils/auth.js', () => ({
  authenticate: async (request: { userId: string; headers: Record<string, string> }, reply: { code: (code: number) => { send: () => void } }) => {
    if (!request.headers.authorization) return reply.code(401).send();
    request.userId = request.headers.authorization;
  },
}));
import { stickerRoutes, encodeSticker } from './stickers.js';

beforeEach(async () => {
  settings.uploadDir = await mkdtemp(path.join(tmpdir(), 'backspace-stickers-'));
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve('drizzle') });
  for (const id of ['alice', 'bob']) {
    db.insert(schema.users).values({ id, username: id, passwordHash: 'test', createdAt: 1 }).run();
  }
  app = Fastify();
  await app.register(stickerRoutes);
});
afterEach(async () => {
  await app.close();
  sqlite.close();
  await rm(settings.uploadDir, { recursive: true, force: true });
});

async function upload() {
  const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: 'red' } }).png().toBuffer();
  return app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' },
    payload: { name: 'Happy', image: image.toString('base64') } });
}

describe('personal stickers', () => {
  it('requires authentication on collection reads and writes', async () => {
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const url = method === 'DELETE' ? '/api/stickers/id' : '/api/stickers';
      const response = await app.inject({ method, url, ...(method === 'POST' ? { payload: { name: 'x', image: 'eA==' } } : {}) });
      expect(response.statusCode).toBe(401);
    }
  });

  it('uploads, deduplicates, isolates collections, and keeps assets after removal', async () => {
    const response = await upload();
    expect(response.statusCode).toBe(200);
    const sticker = response.json();
    expect(stickerUrl(sticker.token)).not.toBeNull();
    expect((await upload()).json().id).toBe(sticker.id);
    const list = (user: string) => app.inject({ url: '/api/stickers', headers: { authorization: user } });
    expect((await list('alice')).json()).toHaveLength(1);
    expect((await list('bob')).json()).toEqual([]);
    const collect = () => app.inject({ method: 'POST', url: `/api/stickers/${sticker.id}/collect`, headers: { authorization: 'bob' }, payload: { token: sticker.token } });
    expect((await collect()).statusCode).toBe(200);
    await collect();
    expect((await list('bob')).json()).toHaveLength(1);
    await app.inject({ method: 'DELETE', url: `/api/stickers/${sticker.id}`, headers: { authorization: 'alice' } });
    expect((await list('alice')).json()).toEqual([]);
    expect((await list('bob')).json()).toHaveLength(1);
    const asset = await app.inject({ url: new URL(stickerUrl(sticker.token)!).pathname });
    expect(asset.headers['content-type']).toBe('image/webp');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect((await sharp(asset.rawPayload).metadata()).format).toBe('webp');
  });

  it('rejects invalid images, SVG, noncanonical base64 and oversize uploads', async () => {
    const payloads = ['not an image', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'];
    for (const value of payloads) {
      const response = await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' },
        payload: { name: 'bad', image: Buffer.from(value).toString('base64') } });
      expect(response.statusCode).toBe(400);
    }
    const invalid = await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' }, payload: { name: 'bad', image: '!!!!' } });
    expect(invalid.statusCode).toBe(400);
    await expect(encodeSticker(Buffer.alloc(MAX_STICKER_BYTES + 1))).rejects.toThrow();
    const tooLarge = await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' },
      payload: { name: 'large', image: Buffer.alloc(MAX_STICKER_BYTES + 4096).toString('base64') } });
    expect(tooLarge.statusCode).toBe(413);
  });

  it('does not accept remote sources or unknown asset IDs', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/stickers/${'0'.repeat(64)}/collect`, headers: { authorization: 'alice' }, payload: { token: `sticker:https://chat.test/api/stickers/assets/${'0'.repeat(64)}.webp` } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/stickers/assets/not-a-hash.webp' })).statusCode).toBe(404);
    const local = (await upload()).json();
    expect((await app.inject({ method: 'POST', url: `/api/stickers/${local.id}/collect`, headers: { authorization: 'bob' }, payload: { token: local.token.replace('chat.test', 'remote.test') } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' }, payload: { name: 'remote', url: 'https://example.com/x.png' } })).statusCode).toBe(400);
  });

  it('preserves animation frames', async () => {
    const frames = Buffer.alloc(8 * 16 * 4, 255);
    frames.fill(0, 8 * 8 * 4);
    const gif = await sharp(frames, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).gif({ delay: [100, 200], loop: 0 }).toBuffer();
    const result = await encodeSticker(gif);
    const metadata = await sharp(result, { animated: true }).metadata();
    expect(metadata.pages).toBe(2);
    expect(metadata.delay).toEqual([100, 200]);
  });
});
