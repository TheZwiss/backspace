import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  MAX_PRIVATE_STICKERS_PER_PACK,
  MAX_STICKER_NAME_LENGTH,
  MAX_STICKERS_PER_PACK,
  MAX_SPACE_STICKERS,
  normalizeStickerName,
  type StickerCrop,
  type StickerPackScope,
} from '@backspace/shared/src/stickers.js';
import { PermissionBits } from '@backspace/shared/src/permissions.js';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { getMaxStickerSizeBytes } from '../utils/stickerAssets.js';
import { hasPermission } from '../utils/permissions.js';
import { encodeSticker, saveStickerAsset, StickerImageError, StickerPixelLimitError, tokenFor } from './stickers.js';

const PRIVATE_UPLOAD_RATE_MS = 1_000;
const recentUploads = new Map<string, number>();

/** Tests only: clear the per-account upload guard. */
export function _resetStickerLibraryRateLimit(): void {
  recentUploads.clear();
}

function canManagePack(
  pack: typeof schema.stickerPacks.$inferSelect,
  userId: string,
): boolean {
  if (pack.scopeType === 'user') return pack.creatorId === userId;
  if (pack.scopeType === 'space' && pack.spaceId) {
    return hasPermission(userId, pack.spaceId, PermissionBits.MANAGE_STICKERS);
  }
  return pack.creatorId === userId;
}

function canAddToPack(
  pack: typeof schema.stickerPacks.$inferSelect,
  userId: string,
): boolean {
  if (pack.scopeType === 'space' && pack.spaceId) {
    return hasPermission(userId, pack.spaceId, PermissionBits.CREATE_STICKERS);
  }
  return pack.creatorId === userId;
}

function itemLimit(scopeType: StickerPackScope): number {
  if (scopeType === 'user') return MAX_PRIVATE_STICKERS_PER_PACK;
  if (scopeType === 'space') return MAX_SPACE_STICKERS;
  return MAX_STICKERS_PER_PACK;
}

function packItems(packId: string) {
  const db = getDb();
  const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, packId)).get();
  if (!pack) return [];
  const version = db.select().from(schema.stickerPackVersions).where(and(
    eq(schema.stickerPackVersions.packId, packId),
    eq(schema.stickerPackVersions.version, pack.currentVersion),
  )).get();
  return version ? db.select().from(schema.stickerPackItems).where(and(
    eq(schema.stickerPackItems.versionId, version.id),
    eq(schema.stickerPackItems.status, 'active'),
  )).orderBy(schema.stickerPackItems.sortOrder).all() : [];
}

function packView(pack: typeof schema.stickerPacks.$inferSelect, userId: string) {
  const items = packItems(pack.id);
  const shares = getDb().select().from(schema.stickerPackShares)
    .where(eq(schema.stickerPackShares.packId, pack.id)).all();
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    scopeType: pack.scopeType as StickerPackScope,
    spaceId: pack.spaceId,
    creatorId: pack.creatorId,
    creatorName: pack.creatorName,
    currentVersion: pack.currentVersion,
    status: pack.status,
    canManage: canManagePack(pack, userId),
    canAdd: canAddToPack(pack, userId),
    itemCount: items.length,
    itemLimit: itemLimit(pack.scopeType as StickerPackScope),
    items: items.map((item) => ({
      id: item.id,
      packId: item.packId,
      versionId: item.versionId,
      assetId: item.assetId,
      name: item.name,
      token: tokenFor(item.assetId),
      sortOrder: item.sortOrder,
      status: item.status,
      createdAt: item.createdAt,
    })),
    shares,
  };
}

function createPackRecord(input: {
  name: string;
  description?: string;
  scopeType: StickerPackScope;
  creatorId: string;
  creatorName: string;
  spaceId?: string | null;
}) {
  const db = getDb();
  const packId = randomUUID();
  const versionId = randomUUID();
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(schema.stickerPacks).values({
      id: packId,
      name: input.name,
      description: input.description?.trim() || null,
      scopeType: input.scopeType,
      spaceId: input.spaceId ?? null,
      creatorId: input.creatorId,
      creatorName: input.creatorName,
      originType: 'source',
      currentVersion: 1,
      status: input.scopeType === 'instance' ? 'draft' : 'active',
      createdAt: now,
      updatedAt: now,
    }).run();
    tx.insert(schema.stickerPackVersions).values({
      id: versionId,
      packId,
      version: 1,
      name: input.name,
      description: input.description?.trim() || null,
      status: input.scopeType === 'instance' ? 'draft' : 'approved',
      createdAt: now,
    }).run();
  });
  return packId;
}

function decodeCrop(value: unknown): StickerCrop | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const crop = value as Record<string, unknown>;
  if (typeof crop.x !== 'number' || typeof crop.y !== 'number'
    || typeof crop.width !== 'number' || typeof crop.height !== 'number') return undefined;
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
}

function decodeStickerBody(body: { name: string; image: string; crop?: unknown }) {
  const name = normalizeStickerName(body.name);
  if (!name || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.image)) return null;
  const bytes = Buffer.from(body.image, 'base64');
  if (bytes.toString('base64') !== body.image) return null;
  return { name, bytes, crop: decodeCrop(body.crop) };
}

async function addImageItem(input: {
  packId: string;
  name: string;
  bytes: Buffer;
  crop?: StickerCrop;
}) {
  const encoded = await encodeSticker(input.bytes, getMaxStickerSizeBytes(), input.crop);
  const assetId = await saveStickerAsset(encoded);
  return addAssetItem(input.packId, assetId, input.name);
}

function addAssetItem(packId: string, assetId: string, name: string) {
  const db = getDb();
  const result = db.transaction((tx) => {
    const pack = tx.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, packId)).get();
    if (!pack) return { error: 'sticker_pack_not_found' as const };
    const version = tx.select().from(schema.stickerPackVersions).where(and(
      eq(schema.stickerPackVersions.packId, packId),
      eq(schema.stickerPackVersions.version, pack.currentVersion),
    )).get();
    if (!version) return { error: 'sticker_pack_not_found' as const };
    const used = tx.select({ n: count() }).from(schema.stickerPackItems).where(and(
      eq(schema.stickerPackItems.versionId, version.id),
      eq(schema.stickerPackItems.status, 'active'),
    )).get()?.n ?? 0;
    if (used >= itemLimit(pack.scopeType as StickerPackScope)) return { error: 'sticker_pack_limit_exceeded' as const };
    const id = randomUUID();
    const now = Date.now();
    tx.insert(schema.stickerPackItems).values({
      id,
      packId,
      versionId: version.id,
      assetId,
      name,
      sortOrder: used,
      status: 'active',
      createdAt: now,
    }).run();
    if (!pack.coverAssetId) {
      tx.update(schema.stickerPacks).set({ coverAssetId: assetId, updatedAt: now })
        .where(eq(schema.stickerPacks.id, packId)).run();
      tx.update(schema.stickerPackVersions).set({ coverAssetId: assetId })
        .where(eq(schema.stickerPackVersions.id, version.id)).run();
    }
    return { id, assetId, now };
  });
  return result;
}

export async function stickerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sticker-library', { preHandler: authenticate }, async (request) => {
    const userId = request.userId!;
    const db = getDb();
    const privatePacks = db.select().from(schema.stickerPacks).where(and(
      eq(schema.stickerPacks.scopeType, 'user'),
      eq(schema.stickerPacks.creatorId, userId),
      eq(schema.stickerPacks.status, 'active'),
    )).orderBy(desc(schema.stickerPacks.updatedAt)).all();
    const spaces = db.select({
      id: schema.spaces.id,
      name: schema.spaces.name,
      icon: schema.spaces.icon,
      avatarColor: schema.spaces.avatarColor,
    })
      .from(schema.spaces)
      .innerJoin(schema.spaceMembers, and(
        eq(schema.spaceMembers.spaceId, schema.spaces.id),
        eq(schema.spaceMembers.userId, userId),
      )).all();
    return {
      privatePacks: privatePacks.map((pack) => packView(pack, userId)),
      spaces: spaces.map((space) => {
        const pack = db.select().from(schema.stickerPacks).where(and(
          eq(schema.stickerPacks.scopeType, 'space'),
          eq(schema.stickerPacks.spaceId, space.id),
        )).get();
        return {
          spaceId: space.id,
          name: space.name,
          icon: space.icon,
          avatarColor: space.avatarColor,
          canCreate: hasPermission(userId, space.id, PermissionBits.CREATE_STICKERS),
          canManage: hasPermission(userId, space.id, PermissionBits.MANAGE_STICKERS),
          pack: pack ? packView(pack, userId) : null,
        };
      }),
      favorites: db.select().from(schema.stickerFavorites)
        .where(eq(schema.stickerFavorites.userId, userId))
        .orderBy(desc(schema.stickerFavorites.createdAt)).all()
        .map((favorite) => ({ id: favorite.assetId, name: favorite.name, token: tokenFor(favorite.assetId), createdAt: favorite.createdAt })),
    };
  });

  app.post<{ Body: { name: string; description?: string } }>('/api/private-sticker-packs', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const name = normalizeStickerName(request.body.name);
    if (!name) return sendError(reply, 400, 'sticker_name_invalid', { max: MAX_STICKER_NAME_LENGTH });
    const id = createPackRecord({
      name,
      description: request.body.description,
      scopeType: 'user',
      creatorId: request.userId!,
      creatorName: request.username ?? 'user',
    });
    const pack = getDb().select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, id)).get()!;
    return reply.code(201).send(packView(pack, request.userId!));
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>('/api/private-sticker-packs/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();
    if (!pack || pack.scopeType !== 'user' || pack.status === 'deleted') return sendError(reply, 404, 'sticker_pack_not_found');
    if (pack.creatorId !== request.userId) return sendError(reply, 403, 'forbidden');
    const name = normalizeStickerName(request.body?.name);
    if (!name) return sendError(reply, 400, 'sticker_name_invalid', { max: MAX_STICKER_NAME_LENGTH });
    const now = Date.now();
    db.transaction((tx) => {
      tx.update(schema.stickerPacks).set({ name, updatedAt: now }).where(eq(schema.stickerPacks.id, pack.id)).run();
      tx.update(schema.stickerPackVersions).set({ name }).where(and(
        eq(schema.stickerPackVersions.packId, pack.id),
        eq(schema.stickerPackVersions.version, pack.currentVersion),
      )).run();
    });
    const updated = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, pack.id)).get()!;
    return packView(updated, request.userId!);
  });

  app.delete<{ Params: { id: string } }>('/api/private-sticker-packs/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();
    if (!pack || pack.scopeType !== 'user' || pack.status === 'deleted') return sendError(reply, 404, 'sticker_pack_not_found');
    if (pack.creatorId !== request.userId) return sendError(reply, 403, 'forbidden');
    const now = Date.now();
    db.transaction((tx) => {
      const versionIds = tx.select({ id: schema.stickerPackVersions.id })
        .from(schema.stickerPackVersions)
        .where(eq(schema.stickerPackVersions.packId, pack.id)).all().map((row) => row.id);
      if (versionIds.length > 0) {
        tx.update(schema.stickerPackItems).set({ status: 'deleted' })
          .where(inArray(schema.stickerPackItems.versionId, versionIds)).run();
      }
      tx.update(schema.stickerPackVersions)
        .set({ status: 'deleted', coverAssetId: null })
        .where(eq(schema.stickerPackVersions.packId, pack.id)).run();
      tx.update(schema.stickerPacks)
        .set({ status: 'deleted', coverAssetId: null, updatedAt: now })
        .where(eq(schema.stickerPacks.id, pack.id)).run();
      tx.delete(schema.stickerPackShares).where(eq(schema.stickerPackShares.packId, pack.id)).run();
    });
    return { success: true };
  });

  app.post<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/sticker-pack', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const userId = request.userId!;
    const { spaceId } = request.params;
    const space = getDb().select().from(schema.spaces).where(eq(schema.spaces.id, spaceId)).get();
    if (!space) return sendError(reply, 404, 'space_not_found');
    if (!hasPermission(userId, spaceId, PermissionBits.CREATE_STICKERS)
      && !hasPermission(userId, spaceId, PermissionBits.MANAGE_STICKERS)) {
      return sendError(reply, 403, 'forbidden');
    }
    const db = getDb();
    const existing = db.select().from(schema.stickerPacks).where(and(
      eq(schema.stickerPacks.scopeType, 'space'),
      eq(schema.stickerPacks.spaceId, spaceId),
    )).get();
    if (existing) return packView(existing, userId);
    const id = createPackRecord({
      name: space.name,
      description: `Stickers from ${space.name}`,
      scopeType: 'space',
      spaceId,
      creatorId: userId,
      creatorName: request.username ?? 'user',
    });
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, id)).get()!;
    return reply.code(201).send(packView(pack, userId));
  });

  app.post<{ Params: { id: string }; Body: { name: string; image: string; crop?: unknown } }>('/api/sticker-library/packs/:id/items', {
    preHandler: authenticate,
    bodyLimit: 500 * 1024 * 1024,
  }, async (request, reply) => {
    const userId = request.userId!;
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();
    if (!pack) return sendError(reply, 404, 'sticker_pack_not_found');
    if (!canAddToPack(pack, userId)) return sendError(reply, 403, 'forbidden');
    const now = Date.now();
    if (now - (recentUploads.get(userId) ?? 0) < PRIVATE_UPLOAD_RATE_MS) return sendError(reply, 429, 'rate_limited');
    recentUploads.set(userId, now);
    const decoded = decodeStickerBody(request.body);
    if (!decoded) return sendError(reply, 400, 'validation_failed');
    try {
      const added = await addImageItem({ packId: pack.id, ...decoded });
      if ('error' in added && added.error) {
        return sendError(reply, added.error === 'sticker_pack_limit_exceeded' ? 409 : 404, added.error);
      }
      return reply.code(201).send({
        id: added.id,
        packId: pack.id,
        assetId: added.assetId,
        name: decoded.name,
        token: tokenFor(added.assetId),
        createdAt: added.now,
      });
    } catch (error) {
      if (error instanceof StickerPixelLimitError) return sendError(reply, 400, 'sticker_pixel_limit_exceeded');
      if (error instanceof StickerImageError) return sendError(reply, 400, 'sticker_invalid_image', { max: Math.round(getMaxStickerSizeBytes() / 1024 / 1024) });
      throw error;
    }
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/api/sticker-library/packs/:id/items/:itemId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();
    if (!pack) return sendError(reply, 404, 'sticker_pack_not_found');
    if (!canManagePack(pack, request.userId!)) return sendError(reply, 403, 'forbidden');
    const item = db.select().from(schema.stickerPackItems).where(eq(schema.stickerPackItems.id, request.params.itemId)).get();
    if (!item || item.packId !== pack.id) return sendError(reply, 404, 'sticker_not_found');
    db.update(schema.stickerPackItems).set({ status: 'deleted' }).where(eq(schema.stickerPackItems.id, item.id)).run();
    return { success: true };
  });

  app.patch<{ Params: { id: string; itemId: string }; Body: { name: string } }>('/api/sticker-library/packs/:id/items/:itemId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();
    if (!pack || pack.status === 'deleted') return sendError(reply, 404, 'sticker_pack_not_found');
    if (!canManagePack(pack, request.userId!)) return sendError(reply, 403, 'forbidden');
    const item = db.select().from(schema.stickerPackItems).where(eq(schema.stickerPackItems.id, request.params.itemId)).get();
    if (!item || item.packId !== pack.id || item.status !== 'active') return sendError(reply, 404, 'sticker_not_found');
    const name = normalizeStickerName(request.body?.name);
    if (!name) return sendError(reply, 400, 'sticker_name_invalid', { max: MAX_STICKER_NAME_LENGTH });
    const now = Date.now();
    db.transaction((tx) => {
      tx.update(schema.stickerPackItems).set({ name }).where(eq(schema.stickerPackItems.id, item.id)).run();
      tx.update(schema.stickerPacks).set({ updatedAt: now }).where(eq(schema.stickerPacks.id, pack.id)).run();
    });
    return { ...item, name };
  });

  app.post<{ Body: { name: string; image: string; crop?: unknown } }>('/api/sticker-favorites', {
    preHandler: authenticate,
    bodyLimit: 500 * 1024 * 1024,
  }, async (request, reply) => {
    const userId = request.userId!;
    const db = getDb();
    const used = db.select({ n: count() }).from(schema.stickerFavorites).where(eq(schema.stickerFavorites.userId, userId)).get()?.n ?? 0;
    if (used >= MAX_STICKERS_PER_PACK) return sendError(reply, 409, 'sticker_collection_full', { max: MAX_STICKERS_PER_PACK });
    const decoded = decodeStickerBody(request.body);
    if (!decoded) return sendError(reply, 400, 'validation_failed');
    try {
      const encoded = await encodeSticker(decoded.bytes, getMaxStickerSizeBytes(), decoded.crop);
      const assetId = await saveStickerAsset(encoded);
      db.insert(schema.stickerFavorites).values({ userId, assetId, name: decoded.name, createdAt: Date.now() })
        .onConflictDoUpdate({
          target: [schema.stickerFavorites.userId, schema.stickerFavorites.assetId],
          set: { name: decoded.name },
        }).run();
      return reply.code(201).send({ id: assetId, name: decoded.name, token: tokenFor(assetId), createdAt: Date.now() });
    } catch (error) {
      if (error instanceof StickerPixelLimitError) return sendError(reply, 400, 'sticker_pixel_limit_exceeded');
      if (error instanceof StickerImageError) return sendError(reply, 400, 'sticker_invalid_image', { max: Math.round(getMaxStickerSizeBytes() / 1024 / 1024) });
      throw error;
    }
  });

  app.delete<{ Params: { assetId: string } }>('/api/sticker-favorites/:assetId', {
    preHandler: authenticate,
  }, async (request) => {
    getDb().delete(schema.stickerFavorites).where(and(
      eq(schema.stickerFavorites.userId, request.userId!),
      eq(schema.stickerFavorites.assetId, request.params.assetId),
    )).run();
    return { success: true };
  });

  app.post<{ Params: { id: string }; Body: { favoriteId: string; name?: string } }>('/api/private-sticker-packs/:id/items/from-favorite', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();
    if (!pack || pack.scopeType !== 'user' || pack.creatorId !== request.userId) return sendError(reply, 403, 'forbidden');
    const favorite = db.select().from(schema.stickerFavorites).where(and(
      eq(schema.stickerFavorites.userId, request.userId!),
      eq(schema.stickerFavorites.assetId, request.body.favoriteId),
    )).get();
    if (!favorite) return sendError(reply, 404, 'sticker_not_found');
    const name = normalizeStickerName(request.body.name ?? favorite.name);
    if (!name) return sendError(reply, 400, 'validation_failed');
    const result = addAssetItem(pack.id, favorite.assetId, name);
    if ('error' in result && result.error) return sendError(reply, 409, result.error);
    return reply.code(201).send({ id: result.id, packId: pack.id, assetId: favorite.assetId, name, token: tokenFor(favorite.assetId), createdAt: result.now });
  });

  app.post<{ Params: { id: string }; Body: { targetType: 'instance' | 'space'; targetId?: string | null } }>('/api/private-sticker-packs/:id/shares', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const userId = request.userId!;
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();
    if (!pack || pack.scopeType !== 'user' || pack.creatorId !== userId) return sendError(reply, 403, 'forbidden');
    if (packItems(pack.id).length === 0) return sendError(reply, 400, 'validation_failed');
    const targetType = request.body.targetType;
    const targetId = targetType === 'space' ? request.body.targetId?.trim() ?? '' : '';
    if (!['instance', 'space'].includes(targetType)) return sendError(reply, 400, 'validation_failed');
    if (targetType === 'space') {
      const member = db.select().from(schema.spaceMembers).where(and(
        eq(schema.spaceMembers.spaceId, targetId),
        eq(schema.spaceMembers.userId, userId),
      )).get();
      if (!member) return sendError(reply, 403, 'forbidden');
    }
    const conflict = db.select().from(schema.stickerPackShares).where(and(
      eq(schema.stickerPackShares.packId, pack.id),
      eq(schema.stickerPackShares.targetType, targetType),
      eq(schema.stickerPackShares.targetId, targetId),
    )).get();
    if (conflict?.status === 'approved') return { success: true, status: 'approved' };
    const id = conflict?.id ?? randomUUID();
    const now = Date.now();
    if (conflict) {
      db.update(schema.stickerPackShares).set({ status: 'pending', reviewNotes: null, reviewedAt: null }).where(eq(schema.stickerPackShares.id, id)).run();
    } else {
      db.insert(schema.stickerPackShares).values({
        id, packId: pack.id, targetType, targetId, requestedBy: userId, status: 'pending', createdAt: now,
      }).run();
    }
    return reply.code(201).send({ id, status: 'pending' });
  });

  app.get<{ Querystring: { targetType?: 'instance' | 'space'; targetId?: string } }>('/api/sticker-pack-shares', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const userId = request.userId!;
    const targetType = request.query.targetType === 'space' ? 'space' : 'instance';
    const targetId = targetType === 'space' ? request.query.targetId ?? '' : '';
    if (targetType === 'instance') {
      const caller = getDb().select().from(schema.users).where(eq(schema.users.id, userId)).get();
      if (caller?.isAdmin !== 1) return sendError(reply, 403, 'forbidden');
    } else if (!hasPermission(userId, targetId, PermissionBits.MANAGE_STICKERS)) {
      return sendError(reply, 403, 'forbidden');
    }
    const db = getDb();
    const shares = db.select().from(schema.stickerPackShares).where(and(
      eq(schema.stickerPackShares.targetType, targetType),
      eq(schema.stickerPackShares.targetId, targetId),
      eq(schema.stickerPackShares.status, 'pending'),
    )).all();
    return shares.map((share) => {
      const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, share.packId)).get();
      return { ...share, pack: pack ? packView(pack, userId) : null };
    });
  });

  app.post<{ Params: { id: string }; Body: { decision: 'approved' | 'rejected'; reviewNotes?: string } }>('/api/sticker-pack-shares/:id/decision', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const share = db.select().from(schema.stickerPackShares).where(eq(schema.stickerPackShares.id, request.params.id)).get();
    if (!share) return sendError(reply, 404, 'not_found');
    const userId = request.userId!;
    if (share.targetType === 'instance') {
      const caller = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      if (caller?.isAdmin !== 1) return sendError(reply, 403, 'forbidden');
    } else if (!share.targetId || !hasPermission(userId, share.targetId, PermissionBits.MANAGE_STICKERS)) {
      return sendError(reply, 403, 'forbidden');
    }
    if (!['approved', 'rejected'].includes(request.body.decision)) return sendError(reply, 400, 'validation_failed');
    db.update(schema.stickerPackShares).set({
      status: request.body.decision,
      reviewedBy: userId,
      reviewNotes: request.body.reviewNotes?.trim() || null,
      reviewedAt: Date.now(),
    }).where(eq(schema.stickerPackShares.id, share.id)).run();
    return { success: true, status: request.body.decision };
  });
}
