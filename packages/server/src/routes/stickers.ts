import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { MAX_STICKER_BYTES, STICKER_ID_PATTERN, STICKER_PREFIX } from '@backspace/shared/src/stickers.js';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { getOurOrigin } from '../utils/federationAuth.js';
import { config } from '../config.js';

// Separate from attachment cleanup: favorites and historical messages share immutable assets.
const assetPath = (id: string) => path.join(config.uploadDir, 'stickers', `${id}.webp`);
const tokenFor = (id: string) => `${STICKER_PREFIX}${getOurOrigin()}/api/stickers/assets/${id}.webp`;
const invalidImage = { error: 'Upload a valid PNG, JPEG, WebP or GIF image, at most 5 MB.' };

function collectSticker(input: { userId: string; id: string; name: string }) {
  const db = getDb();
  db.insert(schema.personalStickers).values({
    userId: input.userId, stickerId: input.id, name: input.name, createdAt: Date.now(),
  }).onConflictDoNothing().run();
  const row = db.select().from(schema.personalStickers).where(and(
    eq(schema.personalStickers.userId, input.userId), eq(schema.personalStickers.stickerId, input.id),
  )).get()!;
  return { id: input.id, name: row.name, token: tokenFor(input.id) };
}

/** Re-encode instead of trusting MIME/extension; decode all frames to preserve animations safely. */
export async function encodeSticker(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_STICKER_BYTES) throw new Error(invalidImage.error);
  // Bound decoded pixels across animation frames, not only the compressed upload size.
  const MAX_DECODED_PIXELS = 16_777_216;
  const image = sharp(bytes, { animated: true, limitInputPixels: MAX_DECODED_PIXELS });
  const metadata = await image.metadata();
  if (!metadata.format || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) {
    throw new Error(invalidImage.error);
  }
  return image.rotate().webp().toBuffer();
}

export async function stickerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stickers', { preHandler: authenticate }, async (request) => {
    const rows = getDb().select().from(schema.personalStickers)
      .where(eq(schema.personalStickers.userId, request.userId))
      .orderBy(desc(schema.personalStickers.createdAt)).all();
    return rows.map(row => ({ id: row.stickerId, name: row.name, token: tokenFor(row.stickerId) }));
  });

  // JSON uses the existing authenticated API client; the body limit accounts for base64 expansion.
  app.post<{ Body: { name: string; image: string } }>('/api/stickers', {
    preHandler: authenticate,
    bodyLimit: Math.ceil(MAX_STICKER_BYTES / 3) * 4 + 4096,
    schema: { body: { type: 'object', required: ['name', 'image'], additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, image: { type: 'string', minLength: 4 } } } },
  }, async (request, reply) => {
    const { name, image } = request.body;
    if (!name.trim()) return reply.code(400).send({ error: 'Sticker name must not be blank' });
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image)) {
      return reply.code(400).send({ error: 'Image must be base64 encoded' });
    }
    const bytes = Buffer.from(image, 'base64');
    if (bytes.toString('base64') !== image) return reply.code(400).send(invalidImage);
    // Only decode failures become validation errors; filesystem/database failures stay server errors.
    let encoded: Buffer;
    try { encoded = await encodeSticker(bytes); }
    catch (error) {
      return reply.code(400).send({ error: `Image rejected: ${(error as Error).message}` });
    }
    const id = createHash('sha256').update(encoded).digest('hex');
    await mkdir(path.dirname(assetPath(id)), { recursive: true });
    // Publish atomically: concurrent duplicate uploads must never expose a truncated image.
    const temporaryPath = `${assetPath(id)}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, encoded);
    await rename(temporaryPath, assetPath(id));
    getDb().insert(schema.stickerAssets).values({ id, createdAt: Date.now() }).onConflictDoNothing().run();
    return collectSticker({ userId: request.userId, id, name: name.trim() });
  });

  app.post<{ Params: { id: string }; Body: { token: string } }>('/api/stickers/:id/collect', {
    preHandler: authenticate,
    schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 2048 } } },
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: STICKER_ID_PATTERN.source } } } },
  }, async (request, reply) => {
    if (request.body.token !== tokenFor(request.params.id)) {
      return reply.code(400).send({ error: 'Only stickers from this instance can be collected.' });
    }
    const asset = getDb().select().from(schema.stickerAssets).where(eq(schema.stickerAssets.id, request.params.id)).get();
    if (!asset) return reply.code(404).send({ error: 'Sticker not found' });
    return collectSticker({ userId: request.userId, id: asset.id, name: 'Sticker' });
  });

  app.delete<{ Params: { id: string } }>('/api/stickers/:id', { preHandler: authenticate }, async (request) => {
    getDb().delete(schema.personalStickers).where(and(
      eq(schema.personalStickers.userId, request.userId), eq(schema.personalStickers.stickerId, request.params.id),
    )).run();
    return { success: true };
  });

  // Same public-link access policy as existing uploads. Never accept a filesystem path or remote URL.
  app.get<{ Params: { filename: string } }>('/api/stickers/assets/:filename', async (request, reply) => {
    const id = request.params.filename.replace(/\.webp$/, '');
    if (!STICKER_ID_PATTERN.test(id) || request.params.filename !== `${id}.webp`) {
      return reply.code(404).send({ error: 'Sticker not found' });
    }
    const asset = getDb().select().from(schema.stickerAssets).where(eq(schema.stickerAssets.id, id)).get();
    // Resolve from the canonical stored key, never from the request path parameter.
    if (!asset || !STICKER_ID_PATTERN.test(asset.id)) return reply.code(404).send({ error: 'Sticker not found' });
    return reply.type('image/webp').header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=31536000, immutable').send(await readFile(assetPath(asset.id)));
  });
}
