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
import { stickerUrl, MAX_STICKER_BYTES, MAX_PERSONAL_STICKERS, STICKER_UPLOADS_PER_MINUTE } from '@backspace/shared/src/stickers.js';

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
import { stickerRoutes, encodeSticker, _resetStickerUploadLimit, StickerPixelLimitError } from './stickers.js';

beforeEach(async () => {
  _resetStickerUploadLimit();
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
    const collect = () => app.inject({ method: 'POST', url: `/api/stickers/${sticker.id}/collect`, headers: { authorization: 'bob' }, payload: { token: sticker.token, name: 'Collected' } });
    expect((await collect()).statusCode).toBe(200);
    await collect();
    expect((await list('bob')).json()).toHaveLength(1);
    expect((await list('bob')).json()[0]).toMatchObject({ id: sticker.id, name: 'Collected' });
    await app.inject({ method: 'DELETE', url: `/api/stickers/${sticker.id}`, headers: { authorization: 'alice' } });
    expect((await list('alice')).json()).toEqual([]);
    expect((await list('bob')).json()).toHaveLength(1);
    const asset = await app.inject({ url: new URL(stickerUrl(sticker.token)!).pathname });
    expect(asset.headers['content-type']).toBe('image/webp');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect(asset.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src 'self'");
    expect(asset.headers['x-frame-options']).toBe('DENY');
    expect((await sharp(asset.rawPayload).metadata()).format).toBe('webp');
  });

  it('rejects invalid images, SVG, noncanonical base64 and oversize uploads', async () => {
    const payloads = ['not an image', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'];
    for (const value of payloads) {
      const response = await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' },
        payload: { name: 'bad', image: Buffer.from(value).toString('base64') } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'sticker_invalid_image', details: { max: 5 } });
    }
    const invalid = await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' }, payload: { name: 'bad', image: '!!!!' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'validation_failed' });
    const blank = await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' }, payload: { name: '   ', image: 'eA==' } });
    expect(blank.json()).toMatchObject({ code: 'validation_failed' });
    await expect(encodeSticker(Buffer.alloc(MAX_STICKER_BYTES + 1))).rejects.toThrow();
    const tooLarge = await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' },
      payload: { name: 'large', image: Buffer.alloc(MAX_STICKER_BYTES + 4096).toString('base64') } });
    expect(tooLarge.statusCode).toBe(413);
  });

  it('does not accept remote sources or unknown asset IDs', async () => {
    const unknown = await app.inject({ method: 'POST', url: `/api/stickers/${'0'.repeat(64)}/collect`, headers: { authorization: 'alice' }, payload: { token: `sticker:https://chat.test/api/stickers/assets/${'0'.repeat(64)}.webp`, name: 'Unknown' } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'sticker_not_found' });
    expect((await app.inject({ url: '/api/stickers/assets/not-a-hash.webp' })).json()).toMatchObject({ code: 'sticker_not_found' });
    const local = (await upload()).json();
    const remote = await app.inject({ method: 'POST', url: `/api/stickers/${local.id}/collect`, headers: { authorization: 'bob' }, payload: { token: local.token.replace('chat.test', 'remote.test'), name: 'Remote' } });
    expect(remote.statusCode).toBe(400);
    expect(remote.json()).toMatchObject({ code: 'sticker_not_local' });
    expect((await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'alice' }, payload: { name: 'remote', url: 'https://example.com/x.png' } })).statusCode).toBe(400);
  });

  it('caps a collection and still returns an entry that is already in it', async () => {
    const existing = (await upload()).json();
    const insert = sqlite.prepare('INSERT INTO sticker_assets (id, created_at) VALUES (?, 1)');
    const collectRow = sqlite.prepare("INSERT INTO personal_stickers (user_id, sticker_id, name, created_at) VALUES ('alice', ?, 'Filler', 1)");
    for (let index = 1; index < MAX_PERSONAL_STICKERS; index += 1) {
      const id = index.toString(16).padStart(64, '0');
      insert.run(id);
      collectRow.run(id);
    }
    const full = await upload();
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ code: 'sticker_collection_full', details: { max: MAX_PERSONAL_STICKERS } });
    const other = (await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'bob' },
      payload: { name: 'Other', image: (await sharp({ create: { width: 8, height: 8, channels: 4, background: 'blue' } }).png().toBuffer()).toString('base64') } })).json();
    const collectOther = await app.inject({ method: 'POST', url: `/api/stickers/${other.id}/collect`, headers: { authorization: 'alice' }, payload: { token: other.token, name: 'Other' } });
    expect(collectOther.statusCode).toBe(409);
    const again = await app.inject({ method: 'POST', url: `/api/stickers/${existing.id}/collect`, headers: { authorization: 'alice' }, payload: { token: existing.token, name: 'Again' } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: existing.id, name: 'Happy' });
  });

  it('makes an existing asset fresh again when its bytes are uploaded', async () => {
    const { id } = (await upload()).json();
    sqlite.prepare('UPDATE sticker_assets SET created_at = 1 WHERE id = ?').run(id);
    await upload();
    const row = sqlite.prepare('SELECT created_at AS createdAt FROM sticker_assets WHERE id = ?').get(id) as { createdAt: number };
    expect(row.createdAt).toBeGreaterThan(1);
  });

  it('limits uploads per account per minute', async () => {
    for (let index = 0; index < STICKER_UPLOADS_PER_MINUTE; index += 1) {
      expect((await upload()).statusCode).toBe(200);
    }
    const limited = await upload();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'rate_limited' });
    const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: 'red' } }).png().toBuffer();
    const otherAccount = await app.inject({ method: 'POST', url: '/api/stickers', headers: { authorization: 'bob' },
      payload: { name: 'Happy', image: image.toString('base64') } });
    expect(otherAccount.statusCode).toBe(200);
  });

  it('stores large images within the display box', async () => {
    const image = await sharp({ create: { width: 2048, height: 1024, channels: 4, background: 'green' } }).png().toBuffer();
    const metadata = await sharp(await encodeSticker(image)).metadata();
    expect([metadata.width, metadata.height]).toEqual([512, 256]);
    const small = await sharp({ create: { width: 40, height: 20, channels: 4, background: 'green' } }).png().toBuffer();
    const smallMetadata = await sharp(await encodeSticker(small)).metadata();
    expect([smallMetadata.width, smallMetadata.height]).toEqual([40, 20]);
  });

  it('answers 404 when an asset row has lost its file', async () => {
    const { id, token } = (await upload()).json();
    await rm(path.join(settings.uploadDir, 'stickers', `${id}.webp`));
    const response = await app.inject({ url: new URL(stickerUrl(token)!).pathname });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'sticker_not_found' });
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

  it('resizes every frame of a large animation', async () => {
    const frames = Buffer.alloc(800 * 1600 * 4, 255);
    frames.fill(0, 800 * 800 * 4);
    const gif = await sharp(frames, { raw: { width: 800, height: 1600, channels: 4, pageHeight: 800 } }).gif({ delay: [100, 200], loop: 0 }).toBuffer();
    const metadata = await sharp(await encodeSticker(gif), { animated: true }).metadata();
    expect(metadata.pages).toBe(2);
    expect([metadata.width, metadata.pageHeight]).toEqual([512, 512]);
  });

  it('renames a sticker in the user collection and rejects invalid names or unknown stickers', async () => {
    const uploaded = (await upload()).json();
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/stickers/${uploaded.id}`,
      headers: { authorization: 'alice' },
      payload: { name: 'Renamed Happy' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: uploaded.id, name: 'Renamed Happy', token: uploaded.token });

    // In the list, the new name is reflected
    const list = await app.inject({ url: '/api/stickers', headers: { authorization: 'alice' } });
    expect(list.json()).toEqual([expect.objectContaining({ id: uploaded.id, name: 'Renamed Happy' })]);

    // Bob cannot rename Alice's sticker
    const otherUser = await app.inject({
      method: 'PATCH',
      url: `/api/stickers/${uploaded.id}`,
      headers: { authorization: 'bob' },
      payload: { name: 'Bob Name' },
    });
    expect(otherUser.statusCode).toBe(404);

    // Rejects blank name
    const blank = await app.inject({
      method: 'PATCH',
      url: `/api/stickers/${uploaded.id}`,
      headers: { authorization: 'alice' },
      payload: { name: '   ' },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('respects instance_settings max_sticker_size_bytes limit', async () => {
    // Set custom sticker size limit to 10 MB in instance_settings
    db.insert(schema.instanceSettings).values({ id: 1, maxStickerSizeBytes: 10 * 1024 * 1024, updatedAt: Date.now() }).onConflictDoUpdate({
      target: schema.instanceSettings.id,
      set: { maxStickerSizeBytes: 10 * 1024 * 1024 },
    }).run();

    // Over 10MB fails
    await expect(encodeSticker(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow();

    const overLimit = await app.inject({
      method: 'POST',
      url: '/api/stickers',
      headers: { authorization: 'alice' },
      payload: { name: 'huge', image: Buffer.alloc(10 * 1024 * 1024 + 4096).toString('base64') },
    });
    expect(overLimit.statusCode).toBe(413);
  });

  it('rejects images that exceed decoded pixel limit with sticker_pixel_limit_exceeded', async () => {
    // 10000x10000 has 100M pixels > MAX_DECODED_PIXELS (67_108_864)
    const huge = await sharp({ create: { width: 10000, height: 10000, channels: 4, background: 'red' } }).png().toBuffer();
    await expect(encodeSticker(huge)).rejects.toThrow(StickerPixelLimitError);

    const response = await app.inject({
      method: 'POST',
      url: '/api/stickers',
      headers: { authorization: 'alice' },
      payload: { name: 'huge', image: huge.toString('base64') },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'sticker_pixel_limit_exceeded' });
  });

  it('accepts animations with over 100 frames under the updated pixel cap', async () => {
    const frameCount = 100;
    const width = 8;
    const height = 8;
    const frames = Buffer.alloc(width * height * 4 * frameCount, 0);
    for (let i = 0; i < frameCount; i++) {
      const offset = i * width * height * 4;
      frames[offset] = (i * 3 + 1) % 255;
      frames[offset + 1] = (i * 5 + 1) % 255;
      frames[offset + 2] = (i * 7 + 1) % 255;
      frames[offset + 3] = 255;
    }
    const gif = await sharp(frames, { raw: { width, height: height * frameCount, channels: 4, pageHeight: height } })
      .gif({ delay: new Array(frameCount).fill(50), loop: 0 }).toBuffer();
    const result = await encodeSticker(gif);
    const metadata = await sharp(result, { animated: true }).metadata();
    expect(metadata.pages).toBe(frameCount);
  });

  it('generates and serves compressed preview on request and on-demand', async () => {
    const uploadRes = await upload();
    expect(uploadRes.statusCode).toBe(200);
    const sticker = uploadRes.json();
    const pathname = new URL(stickerUrl(sticker.token)!).pathname;

    // 1. Fetch full original image
    const fullRes = await app.inject({ url: pathname });
    expect(fullRes.statusCode).toBe(200);
    expect(fullRes.headers['content-type']).toBe('image/webp');

    // 2. Fetch preview image
    const previewRes = await app.inject({ url: `${pathname}?preview=1` });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.headers['content-type']).toBe('image/webp');
    expect(previewRes.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const meta = await sharp(previewRes.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(128);
    expect(meta.height).toBeLessThanOrEqual(128);

    // 3. Delete preview file to test on-demand generation
    const previewFilePath = path.join(settings.uploadDir, 'stickers', `${sticker.id}_preview.webp`);
    await rm(previewFilePath, { force: true });

    // 4. Request preview again - should re-generate on-demand
    const onDemandRes = await app.inject({ url: `${pathname}?preview=1` });
    expect(onDemandRes.statusCode).toBe(200);
    const onDemandMeta = await sharp(onDemandRes.rawPayload).metadata();
    expect(onDemandMeta.format).toBe('webp');
    expect(onDemandMeta.width).toBeLessThanOrEqual(128);
  });
});
