import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_PERSONAL_STICKERS, MAX_STICKER_BYTES, MAX_STICKER_NAME_LENGTH, STICKER_ID_PATTERN, STICKER_PREFIX,
  STICKER_UPLOADS_PER_MINUTE, type PersonalSticker,
} from '@backspace/shared/src/stickers.js';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { getOurOrigin } from '../utils/federationAuth.js';
import { stickerAssetPath as assetPath, stickerPreviewPath } from '../utils/stickerAssets.js';
import { sendError } from '../utils/httpErrors.js';
import { createFixedWindowLimit } from '../utils/fixedWindowLimit.js';

export const tokenFor = (id: string) => `${STICKER_PREFIX}${getOurOrigin()}/api/stickers/assets/${id}.webp`;

/**
 * Returns the effective sticker upload size limit in bytes, configured by the instance admin
 * in storage settings or falling back to MAX_STICKER_SIZE / default 5MB.
 */
export function getMaxStickerSizeBytes(): number {
  try {
    const row = getDb().select({ maxStickerSizeBytes: schema.instanceSettings.maxStickerSizeBytes })
      .from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    return row?.maxStickerSizeBytes ?? config.maxStickerSize ?? MAX_STICKER_BYTES;
  } catch {
    return config.maxStickerSize ?? MAX_STICKER_BYTES;
  }
}
/** Stored stickers fit this box; the largest place one is shown is a 240 px message row. */
const MAX_STICKER_DIMENSION = 512;
export const MAX_STICKER_PREVIEW_DIMENSION = 128;
/** Bound decoded pixels across animation frames, not only the compressed upload size. */
const MAX_DECODED_PIXELS = 67_108_864;

/**
 * Uploads per account (the row id on this instance, so each federated account
 * counts on its own). Every upload is a full decode and re-encode, so the
 * budget is per account and not only the per-address HTTP limit.
 */
const uploadLimit = createFixedWindowLimit({ max: STICKER_UPLOADS_PER_MINUTE, windowMs: 60_000 });

/** Tests only: forget every account's upload window. */
export function _resetStickerUploadLimit(): void {
  uploadLimit.reset();
}

/** Thrown by `encodeSticker` for bytes that are not an accepted image. */
export class StickerImageError extends Error {
  constructor() {
    super('Not an accepted sticker image');
    this.name = 'StickerImageError';
  }
}

/** Thrown by `encodeSticker` when the image exceeds maximum decoded pixels across all frames. */
export class StickerPixelLimitError extends Error {
  constructor() {
    super('Sticker exceeds maximum decoded pixel limit');
    this.name = 'StickerPixelLimitError';
  }
}

function collectionSize(userId: string): number {
  return getDb().select({ count: count() }).from(schema.personalStickers)
    .where(eq(schema.personalStickers.userId, userId)).get()?.count ?? 0;
}

/**
 * Add an asset to a collection, or return the entry that is already there.
 * Null when the collection is full. Synchronous from the size check to the
 * insert, so two requests from one account cannot both take the last place.
 */
function collectSticker(input: { userId: string; id: string; name: string }): PersonalSticker | null {
  const db = getDb();
  const existing = () => db.select().from(schema.personalStickers).where(and(
    eq(schema.personalStickers.userId, input.userId), eq(schema.personalStickers.stickerId, input.id),
  )).get();
  const found = existing();
  if (found) return { id: input.id, name: found.name, token: tokenFor(input.id) };
  if (collectionSize(input.userId) >= MAX_PERSONAL_STICKERS) return null;
  db.insert(schema.personalStickers).values({
    userId: input.userId, stickerId: input.id, name: input.name, createdAt: Date.now(),
  }).onConflictDoNothing().run();
  return { id: input.id, name: existing()!.name, token: tokenFor(input.id) };
}

/**
 * Compresses a sticker asset down to preview size (128px max) with WebP quality 65.
 * Decodes all frames for animations to maintain lightweight animated preview.
 */
export async function encodeStickerPreview(bytes: Buffer): Promise<Buffer> {
  const image = sharp(bytes, { animated: true, limitInputPixels: MAX_DECODED_PIXELS });
  return await image.rotate()
    .resize(MAX_STICKER_PREVIEW_DIMENSION, MAX_STICKER_PREVIEW_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 65 })
    .toBuffer();
}

/**
 * Persist an encoded sticker asset atomically and record it in sticker_assets.
 */
export async function saveStickerAsset(encoded: Buffer): Promise<string> {
  const id = createHash('sha256').update(encoded).digest('hex');
  const now = Date.now();
  getDb().insert(schema.stickerAssets).values({ id, createdAt: now })
    .onConflictDoUpdate({ target: schema.stickerAssets.id, set: { createdAt: now } }).run();
  await mkdir(path.dirname(assetPath(id)), { recursive: true });
  const temporaryPath = `${assetPath(id)}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, encoded);
  await rename(temporaryPath, assetPath(id));

  // Also pre-generate compressed preview file
  try {
    const previewEncoded = await encodeStickerPreview(encoded);
    const previewTemp = `${stickerPreviewPath(id)}.${randomUUID()}.tmp`;
    await writeFile(previewTemp, previewEncoded);
    await rename(previewTemp, stickerPreviewPath(id));
  } catch (err) {
    // Non-fatal if preview generation fails on save; on-demand will generate or fallback
    console.error('Failed to pre-generate sticker preview:', err);
  }

  return id;
}

/**

 * Re-encode instead of trusting MIME/extension; decode all frames to preserve
 * animations safely. The result fits MAX_STICKER_DIMENSION and is refused
 * when it is still larger than an upload may be, so a stored asset is never
 * bigger than the bytes the account sent.
 */
export async function encodeSticker(bytes: Buffer, maxBytes?: number): Promise<Buffer> {
  const limit = maxBytes ?? getMaxStickerSizeBytes();
  if (!bytes.length || bytes.length > limit) throw new StickerImageError();
  let encoded: Buffer;
  try {
    const image = sharp(bytes, { animated: true, limitInputPixels: MAX_DECODED_PIXELS });
    const metadata = await image.metadata();
    if (!metadata.format || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) {
      throw new StickerImageError();
    }
    encoded = await image.rotate()
      .resize(MAX_STICKER_DIMENSION, MAX_STICKER_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .webp().toBuffer();
  } catch (error) {
    if (error instanceof StickerImageError || error instanceof StickerPixelLimitError) throw error;
    if (error instanceof Error && error.message.toLowerCase().includes('pixel limit')) {
      throw new StickerPixelLimitError();
    }
    // Sharp's own messages name decoder internals; the caller only needs to know the image was refused.
    throw new StickerImageError();
  }
  if (encoded.length > limit) throw new StickerImageError();
  return encoded;
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
    bodyLimit: 500 * 1024 * 1024,
    preParsing: async (request, reply, payload) => {
      const maxBytes = getMaxStickerSizeBytes();
      const maxBodyLimit = Math.ceil(maxBytes / 3) * 4 + 4096;
      const contentLength = Number(request.headers['content-length']);
      if (contentLength && contentLength > maxBodyLimit) {
        return reply.code(413).send({ statusCode: 413, error: 'Payload Too Large', message: 'Request body is too large' });
      }
      return payload;
    },
    schema: { body: { type: 'object', required: ['name', 'image'], additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: MAX_STICKER_NAME_LENGTH }, image: { type: 'string', minLength: 4 } } } },
  }, async (request, reply) => {
    const { name, image } = request.body;
    if (!name.trim()) return sendError(reply, 400, 'validation_failed');
    if (!uploadLimit.consume(request.userId)) return sendError(reply, 429, 'rate_limited');
    // Refused before the decode; collectSticker checks again where the row is written.
    if (collectionSize(request.userId) >= MAX_PERSONAL_STICKERS) {
      return sendError(reply, 409, 'sticker_collection_full', { max: MAX_PERSONAL_STICKERS });
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image)) return sendError(reply, 400, 'validation_failed');
    const bytes = Buffer.from(image, 'base64');
    if (bytes.toString('base64') !== image) return sendError(reply, 400, 'validation_failed');

    const maxBytes = getMaxStickerSizeBytes();
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    if (bytes.length > maxBytes) {
      return reply.code(413).send({ statusCode: 413, error: 'Payload Too Large', message: 'Request body is too large' });
    }

    // Only decode failures become validation errors; filesystem/database failures stay server errors.
    let encoded: Buffer;
    try { encoded = await encodeSticker(bytes, maxBytes); }
    catch (error) {
      if (error instanceof StickerPixelLimitError) return sendError(reply, 400, 'sticker_pixel_limit_exceeded');
      if (error instanceof StickerImageError) return sendError(reply, 400, 'sticker_invalid_image', { max: maxMb });
      throw error;
    }
    const id = await saveStickerAsset(encoded);
    const sticker = collectSticker({ userId: request.userId, id, name: name.trim() });
    if (!sticker) return sendError(reply, 409, 'sticker_collection_full', { max: MAX_PERSONAL_STICKERS });
    return sticker;
  });


  app.post<{ Params: { id: string }; Body: { token: string; name: string } }>('/api/stickers/:id/collect', {
    preHandler: authenticate,
    schema: { body: { type: 'object', required: ['token', 'name'], additionalProperties: false, properties: {
      token: { type: 'string', maxLength: 2048 },
      // The collecting client names the entry in its own language; the server stores no wording of its own.
      name: { type: 'string', minLength: 1, maxLength: MAX_STICKER_NAME_LENGTH },
    } },
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: STICKER_ID_PATTERN.source } } } },
  }, async (request, reply) => {
    if (request.body.token !== tokenFor(request.params.id)) return sendError(reply, 400, 'sticker_not_local');
    const asset = getDb().select().from(schema.stickerAssets).where(eq(schema.stickerAssets.id, request.params.id)).get();
    if (!asset) return sendError(reply, 404, 'sticker_not_found');
    const name = request.body.name.trim();
    if (!name) return sendError(reply, 400, 'validation_failed');
    const sticker = collectSticker({ userId: request.userId, id: asset.id, name });
    if (!sticker) return sendError(reply, 409, 'sticker_collection_full', { max: MAX_PERSONAL_STICKERS });
    return sticker;
  });

  app.delete<{ Params: { id: string } }>('/api/stickers/:id', { preHandler: authenticate }, async (request) => {
    getDb().delete(schema.personalStickers).where(and(
      eq(schema.personalStickers.userId, request.userId), eq(schema.personalStickers.stickerId, request.params.id),
    )).run();
    return { success: true };
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>('/api/stickers/:id', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: MAX_STICKER_NAME_LENGTH } },
      },
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', pattern: STICKER_ID_PATTERN.source } },
      },
    },
  }, async (request, reply) => {
    const trimmed = request.body.name.trim();
    if (!trimmed) return sendError(reply, 400, 'validation_failed');
    const result = getDb().update(schema.personalStickers)
      .set({ name: trimmed })
      .where(and(
        eq(schema.personalStickers.userId, request.userId),
        eq(schema.personalStickers.stickerId, request.params.id),
      ))
      .run();
    if (!result.changes) return sendError(reply, 404, 'sticker_not_found');
    return { id: request.params.id, name: trimmed, token: tokenFor(request.params.id) };
  });

  // Same public-link access policy as existing uploads. Never accept a filesystem path or remote URL.
  app.get<{
    Params: { filename: string };
    Querystring: { preview?: string; thumb?: string };
  }>('/api/stickers/assets/:filename', async (request, reply) => {
    const id = request.params.filename.replace(/\.webp$/, '');
    if (!STICKER_ID_PATTERN.test(id) || request.params.filename !== `${id}.webp`) {
      return sendError(reply, 404, 'sticker_not_found');
    }
    const asset = getDb().select().from(schema.stickerAssets).where(eq(schema.stickerAssets.id, id)).get();
    // Resolve from the canonical stored key, never from the request path parameter.
    if (!asset || !STICKER_ID_PATTERN.test(asset.id)) return sendError(reply, 404, 'sticker_not_found');

    const wantsPreview = request.query.preview !== undefined || request.query.thumb !== undefined;
    let bytes: Buffer;

    if (wantsPreview) {
      const pPath = stickerPreviewPath(asset.id);
      try {
        bytes = await readFile(pPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Preview not yet created; generate from original on demand and cache to disk
          try {
            const originalBytes = await readFile(assetPath(asset.id));
            try {
              bytes = await encodeStickerPreview(originalBytes);
              const previewTemp = `${pPath}.${randomUUID()}.tmp`;
              writeFile(previewTemp, bytes)
                .then(() => rename(previewTemp, pPath))
                .catch((writeErr) => console.error('Failed to cache sticker preview:', writeErr));
            } catch {
              bytes = originalBytes;
            }
          } catch (origErr) {
            if ((origErr as NodeJS.ErrnoException).code === 'ENOENT') return sendError(reply, 404, 'sticker_not_found');
            throw origErr;
          }
        } else {
          throw err;
        }
      }
    } else {
      try {
        bytes = await readFile(assetPath(asset.id));
      } catch (error) {
        // A row whose file is gone (removed by hand, or lost with a restore) is a missing sticker, not a server fault.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sendError(reply, 404, 'sticker_not_found');
        throw error;
      }
    }

    // The same sandbox as a served upload (routes/uploads.ts): the bytes are
    // always a re-encoded WebP, but the response never runs as a document.
    return reply.type('image/webp')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'")
      .header('X-Frame-Options', 'DENY')
      .send(bytes);
  });
}
