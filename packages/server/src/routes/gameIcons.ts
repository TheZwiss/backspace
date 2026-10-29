import type { FastifyInstance } from 'fastify';
import { and, count, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import {
  GAME_ICON_DIMENSION, GAME_ICON_ID_PATTERN, GAME_ICON_UPLOADS_PER_MINUTE,
  MAX_GAME_ICON_BYTES, MAX_GAME_ICONS_PER_USER, type GameIconUpload,
} from '@backspace/shared/src/gameIcons.js';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { getOurOrigin } from '../utils/federationAuth.js';
import { gameIconAssetDir, gameIconAssetPath } from '../utils/gameIconAssets.js';
import { sendError } from '../utils/httpErrors.js';
import { createFixedWindowLimit } from '../utils/fixedWindowLimit.js';

/**
 * Game icon uploads. The desktop client extracts an icon for a detected game
 * from the player's own machine (Steam's library cache, Flatpak exports, GOG
 * and AppImage directories, .desktop entries) and uploads it here, so the
 * activity can carry an icon URL the user's own instance hosts. No external
 * art service is involved; the shape deliberately mirrors the personal
 * sticker routes.
 */

const urlFor = (id: string) => `${getOurOrigin()}/api/game-icons/assets/${id}.webp`;
const MAX_GAME_ICON_MB = MAX_GAME_ICON_BYTES / (1024 * 1024);
/** Bound decoded pixels; icons are small images, never panoramas. */
const MAX_DECODED_PIXELS = 16_777_216;

const uploadLimit = createFixedWindowLimit({ max: GAME_ICON_UPLOADS_PER_MINUTE, windowMs: 60_000 });

/** Tests only: forget every account's upload window. */
export function _resetGameIconUploadLimit(): void {
  uploadLimit.reset();
}

/** Thrown by `encodeGameIcon` for bytes that are not an accepted image. */
export class GameIconImageError extends Error {
  constructor() {
    super('Not an accepted game icon image');
    this.name = 'GameIconImageError';
  }
}

function iconCount(userId: string): number {
  return getDb().select({ count: count() }).from(schema.gameIcons)
    .where(eq(schema.gameIcons.userId, userId)).get()?.count ?? 0;
}

/**
 * Record the upload for the account, or return the entry that is already
 * there. Null when the account is at its quota. Synchronous from the size
 * check to the insert, so two requests from one account cannot both take the
 * last place.
 */
function collectGameIcon(userId: string, id: string): GameIconUpload | null {
  const db = getDb();
  const existing = () => db.select().from(schema.gameIcons).where(and(
    eq(schema.gameIcons.userId, userId), eq(schema.gameIcons.iconId, id),
  )).get();
  if (existing()) {
    // An upload of the same bytes renews the claim: `created_at` is "last uploaded" (retention, utils/gameIconAssets.ts)
    db.update(schema.gameIcons).set({ createdAt: Date.now() }).where(and(
      eq(schema.gameIcons.userId, userId), eq(schema.gameIcons.iconId, id),
    )).run();
    return { id, url: urlFor(id) };
  }
  if (iconCount(userId) >= MAX_GAME_ICONS_PER_USER) return null;
  db.insert(schema.gameIcons).values({ userId, iconId: id, createdAt: Date.now() })
    .onConflictDoNothing().run();
  return { id, url: urlFor(id) };
}

/**
 * Re-encode instead of trusting MIME/extension: the stored icon is always a
 * WebP that fits GAME_ICON_DIMENSION, so a stored asset is never bigger than
 * the bytes the account sent.
 */
export async function encodeGameIcon(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_GAME_ICON_BYTES) throw new GameIconImageError();
  let encoded: Buffer;
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_DECODED_PIXELS });
    const metadata = await image.metadata();
    // GIF is refused on purpose: an activity icon is a still image.
    if (!metadata.format || !['png', 'jpeg', 'webp'].includes(metadata.format)) {
      throw new GameIconImageError();
    }
    encoded = await image.rotate()
      .resize(GAME_ICON_DIMENSION, GAME_ICON_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .webp().toBuffer();
  } catch (error) {
    // Sharp's own messages name decoder internals; the caller only needs to know the image was refused.
    if (error instanceof GameIconImageError) throw error;
    throw new GameIconImageError();
  }
  if (encoded.length > MAX_GAME_ICON_BYTES) throw new GameIconImageError();
  return encoded;
}

export async function gameIconRoutes(app: FastifyInstance): Promise<void> {
  // JSON like the sticker upload; the body limit accounts for base64 expansion.
  app.post<{ Body: { image: string } }>('/api/game-icons', {
    preHandler: authenticate,
    bodyLimit: Math.ceil(MAX_GAME_ICON_BYTES / 3) * 4 + 4096,
    schema: { body: { type: 'object', required: ['image'], additionalProperties: false,
      properties: { image: { type: 'string', minLength: 4 } } } },
  }, async (request, reply) => {
    const { image } = request.body;
    if (!uploadLimit.consume(request.userId)) return sendError(reply, 429, 'rate_limited');
    // Refused before the decode; collectGameIcon checks again where the row is written.
    if (iconCount(request.userId) >= MAX_GAME_ICONS_PER_USER) {
      return sendError(reply, 409, 'game_icon_collection_full', { max: MAX_GAME_ICONS_PER_USER });
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image)) return sendError(reply, 400, 'validation_failed');
    const bytes = Buffer.from(image, 'base64');
    if (bytes.toString('base64') !== image) return sendError(reply, 400, 'validation_failed');
    let encoded: Buffer;
    try { encoded = await encodeGameIcon(bytes); }
    catch (error) {
      if (error instanceof GameIconImageError) return sendError(reply, 400, 'game_icon_invalid_image', { max: MAX_GAME_ICON_MB });
      throw error;
    }
    const id = createHash('sha256').update(encoded).digest('hex');
    // Row first, file second: an asset row always exists by the time its file does.
    const now = Date.now();
    getDb().insert(schema.gameIconAssets).values({ id, createdAt: now })
      .onConflictDoUpdate({ target: schema.gameIconAssets.id, set: { createdAt: now } }).run();
    await mkdir(gameIconAssetDir(), { recursive: true });
    // Publish atomically: concurrent duplicate uploads must never expose a truncated image.
    const temporaryPath = `${gameIconAssetPath(id)}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, encoded);
    await rename(temporaryPath, gameIconAssetPath(id));
    const icon = collectGameIcon(request.userId, id);
    if (!icon) return sendError(reply, 409, 'game_icon_collection_full', { max: MAX_GAME_ICONS_PER_USER });
    return icon;
  });

  // Same public-link access policy as sticker assets. Never accept a filesystem path or remote URL.
  app.get<{ Params: { filename: string } }>('/api/game-icons/assets/:filename', async (request, reply) => {
    const id = request.params.filename.replace(/\.webp$/, '');
    if (!GAME_ICON_ID_PATTERN.test(id) || request.params.filename !== `${id}.webp`) {
      return sendError(reply, 404, 'game_icon_not_found');
    }
    const asset = getDb().select().from(schema.gameIconAssets).where(eq(schema.gameIconAssets.id, id)).get();
    // Resolve from the canonical stored key, never from the request path parameter.
    if (!asset || !GAME_ICON_ID_PATTERN.test(asset.id)) return sendError(reply, 404, 'game_icon_not_found');
    let bytes: Buffer;
    try {
      bytes = await readFile(gameIconAssetPath(asset.id));
    } catch (error) {
      // A row whose file is gone is a missing icon, not a server fault.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sendError(reply, 404, 'game_icon_not_found');
      throw error;
    }
    return reply.type('image/webp')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'")
      .header('X-Frame-Options', 'DENY')
      .send(bytes);
  });
}
