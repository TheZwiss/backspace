import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import * as schema from '../db/schema.js';
import { GAME_ICON_UPLOADS_PER_MINUTE, MAX_GAME_ICONS_PER_USER } from '@backspace/shared/src/gameIcons.js';

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
import { gameIconRoutes, encodeGameIcon, _resetGameIconUploadLimit } from './gameIcons.js';

beforeEach(async () => {
  _resetGameIconUploadLimit();
  settings.uploadDir = await mkdtemp(path.join(tmpdir(), 'backspace-game-icons-'));
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve('drizzle') });
  for (const id of ['alice', 'bob']) {
    db.insert(schema.users).values({ id, username: id, passwordHash: 'test', createdAt: 1 }).run();
  }
  app = Fastify();
  await app.register(gameIconRoutes);
});
afterEach(async () => {
  await app.close();
  sqlite.close();
  await rm(settings.uploadDir, { recursive: true, force: true });
});

async function pngBytes(color: string): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
}

async function upload(image: Buffer, authorization = 'alice') {
  return app.inject({ method: 'POST', url: '/api/game-icons', headers: { authorization },
    payload: { image: image.toString('base64') } });
}

describe('game icons', () => {
  it('requires authentication', async () => {
    const image = await pngBytes('red');
    const response = await app.inject({ method: 'POST', url: '/api/game-icons',
      payload: { image: image.toString('base64') } });
    expect(response.statusCode).toBe(401);
  });

  it('uploads an icon and returns an instance-hosted url', async () => {
    const image = await pngBytes('red');
    const response = await upload(image);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string; url: string };
    expect(body.id).toMatch(/^[a-f0-9]{64}$/);
    expect(body.url).toBe(`https://chat.test/api/game-icons/assets/${body.id}.webp`);
    // Stored re-encoded, not verbatim
    expect(body.id).not.toBe(createHash('sha256').update(image).digest('hex'));
  });

  it('re-uploading the same bytes is idempotent and counts once', async () => {
    const image = await pngBytes('blue');
    const first = (await upload(image)).json() as { id: string };
    const second = (await upload(image)).json() as { id: string };
    expect(second.id).toBe(first.id);
    const rows = db.select().from(schema.gameIcons).all();
    expect(rows).toHaveLength(1);
  });

  it('re-uploading renews the claim, which the retention janitor counts from', async () => {
    const image = await pngBytes('green');
    const { id } = (await upload(image)).json() as { id: string };
    sqlite.prepare('UPDATE game_icons SET created_at = 1 WHERE icon_id = ?').run(id);
    await upload(image);
    const row = db.select().from(schema.gameIcons).all()[0];
    expect(row?.createdAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it('rejects non-image payloads', async () => {
    const response = await upload(Buffer.from('definitely not an image'));
    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('game_icon_invalid_image');
  });

  it('rejects gif even though it decodes', async () => {
    const gif = await sharp({ create: { width: 8, height: 8, channels: 4, background: 'green' } }).gif().toBuffer();
    const response = await upload(gif);
    expect(response.statusCode).toBe(400);
  });

  it('rejects a broken base64 body', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/game-icons',
      headers: { authorization: 'alice' }, payload: { image: 'not*base64!' } });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('validation_failed');
  });

  it('enforces the per-minute upload budget', async () => {
    for (let i = 0; i < GAME_ICON_UPLOADS_PER_MINUTE; i++) {
      const image = await pngBytes(`#${(i + 1).toString(16).padStart(6, '0')}`);
      expect((await upload(image)).statusCode).toBe(200);
    }
    const extra = await pngBytes('#ffffff');
    const response = await upload(extra);
    expect(response.statusCode).toBe(429);
  });

  it('enforces the per-account quota of distinct icons', async () => {
    // Filler rows go straight into the database; the upload budget stays untouched
    const insertAsset = sqlite.prepare('INSERT INTO game_icon_assets (id, created_at) VALUES (?, 1)');
    const insertIcon = sqlite.prepare("INSERT INTO game_icons (user_id, icon_id, created_at) VALUES ('alice', ?, 1)");
    // One transaction: tens of thousands of filler rows stay fast
    sqlite.transaction(() => {
      for (let index = 0; index < MAX_GAME_ICONS_PER_USER; index += 1) {
        const id = index.toString(16).padStart(64, '0');
        insertAsset.run(id);
        insertIcon.run(id);
      }
    })();
    const over = await pngBytes('#abcdef');
    const response = await upload(over);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'game_icon_collection_full', details: { max: MAX_GAME_ICONS_PER_USER } });
    // Another account is unaffected
    expect((await upload(over, 'bob')).statusCode).toBe(200);
  });

  it('serves a stored icon publicly with sandbox headers', async () => {
    const image = await pngBytes('purple');
    const { id } = (await upload(image)).json() as { id: string };
    const response = await app.inject({ method: 'GET', url: `/api/game-icons/assets/${id}.webp` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src 'self'");
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    // The served bytes are a valid image
    expect((await sharp(response.rawPayload).metadata()).format).toBe('webp');
  });

  it('hides unknown ids and malformed filenames', async () => {
    for (const url of [
      '/api/game-icons/assets/0000000000000000000000000000000000000000000000000000000000000000.webp',
      '/api/game-icons/assets/../secrets.webp',
      '/api/game-icons/assets/nothex.webp',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
    }
  });

  it('encodeGameIcon shrinks an oversized image into the box', async () => {
    const big = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: 'orange' } }).png().toBuffer();
    const encoded = await encodeGameIcon(big);
    const meta = await sharp(encoded).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);
  });
});
