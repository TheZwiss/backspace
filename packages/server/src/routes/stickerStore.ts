import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  MAX_STICKER_PACK_DESC_LENGTH,
  MAX_STICKER_PACK_NAME_LENGTH,
  MAX_STICKERS_PER_PACK,
  STICKER_ID_PATTERN,
  type StickerPackDetail,
  type StickerPackStatus,
  type StickerPackSummary,
} from '@backspace/shared/src/stickers.js';
import { getDb, schema } from '../db/index.js';
import { authenticate } from '../utils/auth.js';
import { getOurOrigin } from '../utils/federationAuth.js';
import { sendError } from '../utils/httpErrors.js';
import { encodeSticker, getMaxStickerSizeBytes, saveStickerAsset, StickerImageError, StickerPixelLimitError, tokenFor } from './stickers.js';

import { stickerStoreAdminRoutes } from './stickerStoreAdmin.js';

export function formatCoverUrl(coverAssetId: string | null): string | null {
  if (!coverAssetId) return null;
  return `${getOurOrigin()}/api/stickers/assets/${coverAssetId}.webp`;
}

async function tryResolveUserId(request: FastifyRequest): Promise<string | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const { verifyJwtAndUser } = await import('../utils/auth.js');
    const identity = await verifyJwtAndUser(authHeader.slice(7));
    return identity.userId;
  } catch {
    return null;
  }
}

export async function stickerStoreRoutes(app: FastifyInstance): Promise<void> {
  await stickerStoreAdminRoutes(app);

  // ─── 1. Store Public Endpoints ──────────────────────────────────────────────

  /**
   * Browse available sticker packs in the store (approved local packs & active federated replicas).
   */
  app.get<{ Querystring: { q?: string } }>('/api/sticker-store/packs', async (request) => {
    const db = getDb();
    const userId = await tryResolveUserId(request);
    const search = request.query.q?.trim().toLowerCase();

    const allowedStatuses = ['approved', 'active'];
    const query = db.select().from(schema.stickerPacks)
      .where(inArray(schema.stickerPacks.status, allowedStatuses))
      .orderBy(desc(schema.stickerPacks.updatedAt));

    const rows = query.all();
    const filteredRows = search
      ? rows.filter(r => r.name.toLowerCase().includes(search) || (r.description && r.description.toLowerCase().includes(search)))
      : rows;

    // Fetch installed pack IDs for the user
    const installedSet = new Set<string>();
    if (userId) {
      const userPacks = db.select({ packId: schema.userInstalledPacks.packId })
        .from(schema.userInstalledPacks).where(eq(schema.userInstalledPacks.userId, userId)).all();
      for (const p of userPacks) installedSet.add(p.packId);
    }

    const summaries: StickerPackSummary[] = filteredRows.map(pack => {
      const version = db.select().from(schema.stickerPackVersions)
        .where(and(
          eq(schema.stickerPackVersions.packId, pack.id),
          eq(schema.stickerPackVersions.version, pack.currentVersion),
        )).get();

      const items = version ? db.select().from(schema.stickerPackItems)
        .where(and(
          eq(schema.stickerPackItems.versionId, version.id),
          eq(schema.stickerPackItems.status, 'active'),
        )).all() : [];

      return {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        creatorId: pack.creatorId,
        creatorName: pack.creatorName,
        coverAssetId: pack.coverAssetId,
        coverUrl: formatCoverUrl(pack.coverAssetId),
        originType: pack.originType as 'source' | 'replica',
        sourceInstance: pack.sourceInstance,
        sourcePackId: pack.sourcePackId,
        currentVersion: pack.currentVersion,
        status: pack.status as StickerPackStatus,
        itemCount: items.length,
        isInstalled: installedSet.has(pack.id),
        createdAt: pack.createdAt,
        updatedAt: pack.updatedAt,
      };
    });

    return summaries;
  });

  /**
   * Get detail of a sticker pack with all stickers in its current version.
   */
  app.get<{ Params: { id: string } }>('/api/sticker-store/packs/:id', async (request, reply) => {
    const db = getDb();
    const userId = await tryResolveUserId(request);
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack || pack.status === 'deleted') {
      return sendError(reply, 404, 'sticker_pack_not_found');
    }

    // Non-approved packs can only be viewed by their creator or an admin
    if (!['approved', 'active'].includes(pack.status)) {
      if (!userId) return sendError(reply, 404, 'sticker_pack_not_found');
      const caller = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      if (pack.creatorId !== userId && caller?.isAdmin !== 1) {
        return sendError(reply, 404, 'sticker_pack_not_found');
      }
    }

    let version = (pack.status === 'pending_review' || pack.status === 'rejected')
      ? db.select().from(schema.stickerPackVersions)
          .where(and(
            eq(schema.stickerPackVersions.packId, pack.id),
            or(eq(schema.stickerPackVersions.status, 'pending_review'), eq(schema.stickerPackVersions.status, 'rejected')),
          ))
          .orderBy(desc(schema.stickerPackVersions.version))
          .get()
      : null;

    if (!version) {
      version = db.select().from(schema.stickerPackVersions)
        .where(and(
          eq(schema.stickerPackVersions.packId, pack.id),
          eq(schema.stickerPackVersions.version, pack.currentVersion),
        )).get();
    }

    const items = version ? db.select().from(schema.stickerPackItems)
      .where(and(
        eq(schema.stickerPackItems.versionId, version.id),
        eq(schema.stickerPackItems.status, 'active'),
      )).orderBy(schema.stickerPackItems.sortOrder).all() : [];

    let isInstalled = false;
    if (userId) {
      const installed = db.select().from(schema.userInstalledPacks).where(and(
        eq(schema.userInstalledPacks.userId, userId),
        eq(schema.userInstalledPacks.packId, pack.id),
      )).get();
      isInstalled = !!installed;
    }

    const detail: StickerPackDetail = {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      creatorId: pack.creatorId,
      creatorName: pack.creatorName,
      coverAssetId: pack.coverAssetId,
      coverUrl: formatCoverUrl(pack.coverAssetId),
      originType: pack.originType as 'source' | 'replica',
      sourceInstance: pack.sourceInstance,
      sourcePackId: pack.sourcePackId,
      currentVersion: pack.currentVersion,
      status: pack.status as StickerPackStatus,
      itemCount: items.length,
      isInstalled,
      reviewNotes: pack.reviewNotes,
      reviewedBy: pack.reviewedBy,
      reviewedAt: pack.reviewedAt,
      items: items.map(item => ({
        id: item.id,
        packId: item.packId,
        versionId: item.versionId,
        assetId: item.assetId,
        name: item.name,
        token: tokenFor(item.assetId),
        sortOrder: item.sortOrder,
        status: item.status as 'active' | 'deleted',
        createdAt: item.createdAt,
      })),
      createdAt: pack.createdAt,
      updatedAt: pack.updatedAt,
    };

    return detail;
  });

  /**
   * Install a sticker pack to the current user's picker tabs.
   */
  app.post<{ Params: { id: string } }>('/api/sticker-store/packs/:id/install', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack || !['approved', 'active'].includes(pack.status)) {
      return sendError(reply, 404, 'sticker_pack_not_found');
    }

    db.insert(schema.userInstalledPacks).values({
      userId: request.userId,
      packId: pack.id,
      installedAt: Date.now(),
    }).onConflictDoNothing().run();

    return { success: true };
  });

  /**
   * Uninstall a sticker pack from the current user's picker tabs.
   */
  app.delete<{ Params: { id: string } }>('/api/sticker-store/packs/:id/install', {
    preHandler: authenticate,
  }, async (request) => {
    const db = getDb();
    db.delete(schema.userInstalledPacks).where(and(
      eq(schema.userInstalledPacks.userId, request.userId),
      eq(schema.userInstalledPacks.packId, request.params.id),
    )).run();

    return { success: true };
  });

  /**
   * Returns all sticker packs installed by the current user, each populated with active items.
   */
  app.get('/api/sticker-store/my-packs', { preHandler: authenticate }, async (request) => {
    const db = getDb();
    const userPacks = db.select({ packId: schema.userInstalledPacks.packId })
      .from(schema.userInstalledPacks).where(eq(schema.userInstalledPacks.userId, request.userId)).all();

    if (!userPacks.length) return [];

    const packIds = userPacks.map(p => p.packId);
    const packs = db.select().from(schema.stickerPacks)
      .where(and(
        inArray(schema.stickerPacks.id, packIds),
        inArray(schema.stickerPacks.status, ['approved', 'active']),
      )).all();

    const results: StickerPackDetail[] = [];
    for (const pack of packs) {
      const version = db.select().from(schema.stickerPackVersions)
        .where(and(
          eq(schema.stickerPackVersions.packId, pack.id),
          eq(schema.stickerPackVersions.version, pack.currentVersion),
        )).get();

      const items = version ? db.select().from(schema.stickerPackItems)
        .where(and(
          eq(schema.stickerPackItems.versionId, version.id),
          eq(schema.stickerPackItems.status, 'active'),
        )).orderBy(schema.stickerPackItems.sortOrder).all() : [];

      results.push({
        id: pack.id,
        name: pack.name,
        description: pack.description,
        creatorId: pack.creatorId,
        creatorName: pack.creatorName,
        coverAssetId: pack.coverAssetId,
        coverUrl: formatCoverUrl(pack.coverAssetId),
        originType: pack.originType as 'source' | 'replica',
        sourceInstance: pack.sourceInstance,
        sourcePackId: pack.sourcePackId,
        currentVersion: pack.currentVersion,
        status: pack.status as StickerPackStatus,
        itemCount: items.length,
        isInstalled: true,
        reviewNotes: pack.reviewNotes,
        reviewedBy: pack.reviewedBy,
        reviewedAt: pack.reviewedAt,
        items: items.map(item => ({
          id: item.id,
          packId: item.packId,
          versionId: item.versionId,
          assetId: item.assetId,
          name: item.name,
          token: tokenFor(item.assetId),
          sortOrder: item.sortOrder,
          status: item.status as 'active' | 'deleted',
          createdAt: item.createdAt,
        })),
        createdAt: pack.createdAt,
        updatedAt: pack.updatedAt,
      });
    }

    return results;
  });

  // ─── 2. Creator Sticker Pack Management ────────────────────────────────────

  /**
   * Create a new sticker pack in draft state.
   */
  app.post<{ Body: { name: string; description?: string; coverAssetId?: string } }>('/api/sticker-packs', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: MAX_STICKER_PACK_NAME_LENGTH },
          description: { type: 'string', maxLength: MAX_STICKER_PACK_DESC_LENGTH },
          coverAssetId: { type: 'string', pattern: STICKER_ID_PATTERN.source },
        },
      },
    },
  }, async (request, reply) => {
    const trimmedName = request.body.name.trim();
    if (!trimmedName) return sendError(reply, 400, 'validation_failed');

    const packId = randomUUID();
    const versionId = randomUUID();
    const now = Date.now();
    const db = getDb();

    db.insert(schema.stickerPacks).values({
      id: packId,
      name: trimmedName,
      description: request.body.description?.trim() || null,
      creatorId: request.userId,
      creatorName: request.username,
      coverAssetId: request.body.coverAssetId || null,
      originType: 'source',
      sourceInstance: null,
      sourcePackId: null,
      currentVersion: 1,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(schema.stickerPackVersions).values({
      id: versionId,
      packId,
      version: 1,
      name: trimmedName,
      description: request.body.description?.trim() || null,
      coverAssetId: request.body.coverAssetId || null,
      status: 'draft',
      createdAt: now,
    }).run();

    return { id: packId, name: trimmedName, status: 'draft', currentVersion: 1 };
  });

  /**
   * List sticker packs created by the authenticated user.
   */
  app.get('/api/sticker-packs/created', { preHandler: authenticate }, async (request) => {
    const db = getDb();
    const packs = db.select().from(schema.stickerPacks)
      .where(and(
        eq(schema.stickerPacks.creatorId, request.userId),
        eq(schema.stickerPacks.originType, 'source'),
      ))
      .orderBy(desc(schema.stickerPacks.updatedAt))
      .all();

    return packs.filter(p => p.status !== 'deleted').map(pack => {
      const version = db.select().from(schema.stickerPackVersions)
        .where(and(
          eq(schema.stickerPackVersions.packId, pack.id),
          eq(schema.stickerPackVersions.version, pack.currentVersion),
        )).get();

      const items = version ? db.select().from(schema.stickerPackItems)
        .where(and(
          eq(schema.stickerPackItems.versionId, version.id),
          eq(schema.stickerPackItems.status, 'active'),
        )).all() : [];

      return {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        creatorId: pack.creatorId,
        creatorName: pack.creatorName,
        coverAssetId: pack.coverAssetId,
        coverUrl: formatCoverUrl(pack.coverAssetId),
        originType: pack.originType as 'source' | 'replica',
        sourceInstance: pack.sourceInstance,
        sourcePackId: pack.sourcePackId,
        currentVersion: pack.currentVersion,
        status: pack.status as StickerPackStatus,
        itemCount: items.length,
        reviewNotes: pack.reviewNotes,
        reviewedBy: pack.reviewedBy,
        reviewedAt: pack.reviewedAt,
        createdAt: pack.createdAt,
        updatedAt: pack.updatedAt,
      };
    });
  });

  /**
   * Get draft or editing details of a created pack.
   */
  app.get<{ Params: { id: string } }>('/api/sticker-packs/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack || pack.status === 'deleted') {
      return sendError(reply, 404, 'sticker_pack_not_found');
    }

    const caller = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (pack.creatorId !== request.userId && caller?.isAdmin !== 1) {
      return sendError(reply, 403, 'forbidden');
    }

    // Find the latest editing version: draft/pending_review if exists, else currentVersion
    const editingVersion = db.select().from(schema.stickerPackVersions)
      .where(and(
        eq(schema.stickerPackVersions.packId, pack.id),
        or(
          eq(schema.stickerPackVersions.status, 'draft'),
          eq(schema.stickerPackVersions.status, 'pending_review'),
          eq(schema.stickerPackVersions.status, 'rejected'),
        ),
      ))
      .orderBy(desc(schema.stickerPackVersions.version))
      .get() ?? db.select().from(schema.stickerPackVersions)
        .where(and(
          eq(schema.stickerPackVersions.packId, pack.id),
          eq(schema.stickerPackVersions.version, pack.currentVersion),
        )).get();

    const items = editingVersion ? db.select().from(schema.stickerPackItems)
      .where(and(
        eq(schema.stickerPackItems.versionId, editingVersion.id),
        eq(schema.stickerPackItems.status, 'active'),
      )).orderBy(schema.stickerPackItems.sortOrder).all() : [];

    return {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      creatorId: pack.creatorId,
      creatorName: pack.creatorName,
      coverAssetId: pack.coverAssetId,
      coverUrl: formatCoverUrl(pack.coverAssetId),
      originType: pack.originType,
      currentVersion: pack.currentVersion,
      editingVersion: editingVersion?.version ?? pack.currentVersion,
      editingStatus: editingVersion?.status ?? pack.status,
      status: pack.status,
      reviewNotes: pack.reviewNotes,
      items: items.map(i => ({
        id: i.id,
        packId: i.packId,
        versionId: i.versionId,
        assetId: i.assetId,
        name: i.name,
        token: tokenFor(i.assetId),
        sortOrder: i.sortOrder,
        status: i.status,
        createdAt: i.createdAt,
      })),
      createdAt: pack.createdAt,
      updatedAt: pack.updatedAt,
    };
  });

  /**
   * Upload and add a sticker item to a pack's draft version.
   */
  app.post<{ Params: { id: string }; Body: { name: string; image: string } }>('/api/sticker-packs/:id/items', {
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
    schema: {
      body: {
        type: 'object',
        required: ['name', 'image'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          image: { type: 'string', minLength: 4 },
        },
      },
    },
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack || pack.status === 'deleted') {
      return sendError(reply, 404, 'sticker_pack_not_found');
    }
    if (pack.creatorId !== request.userId) {
      return sendError(reply, 403, 'forbidden');
    }

    // Find the draft or rejected version
    const draftVersion = db.select().from(schema.stickerPackVersions)
      .where(and(
        eq(schema.stickerPackVersions.packId, pack.id),
        or(eq(schema.stickerPackVersions.status, 'draft'), eq(schema.stickerPackVersions.status, 'rejected')),
      ))
      .orderBy(desc(schema.stickerPackVersions.version))
      .get();

    if (!draftVersion) {
      return sendError(reply, 400, 'sticker_pack_invalid_state');
    }

    // Check item limit
    const existingItems = db.select().from(schema.stickerPackItems)
      .where(and(
        eq(schema.stickerPackItems.versionId, draftVersion.id),
        eq(schema.stickerPackItems.status, 'active'),
      )).all();

    if (existingItems.length >= MAX_STICKERS_PER_PACK) {
      return sendError(reply, 400, 'sticker_pack_limit_exceeded');
    }

    const trimmedName = request.body.name.trim();
    if (!trimmedName) return sendError(reply, 400, 'validation_failed');

    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(request.body.image)) return sendError(reply, 400, 'validation_failed');
    const bytes = Buffer.from(request.body.image, 'base64');
    if (bytes.toString('base64') !== request.body.image) return sendError(reply, 400, 'validation_failed');

    const maxBytes = getMaxStickerSizeBytes();
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    if (bytes.length > maxBytes) {
      return reply.code(413).send({ statusCode: 413, error: 'Payload Too Large', message: 'Request body is too large' });
    }

    let encoded: Buffer;
    try {
      encoded = await encodeSticker(bytes, maxBytes);
    } catch (error) {
      if (error instanceof StickerPixelLimitError) {
        return sendError(reply, 400, 'sticker_pixel_limit_exceeded');
      }
      if (error instanceof StickerImageError) {
        return sendError(reply, 400, 'sticker_invalid_image', { max: maxMb });
      }
      throw error;
    }

    const assetId = await saveStickerAsset(encoded);
    const itemId = randomUUID();
    const now = Date.now();

    db.insert(schema.stickerPackItems).values({
      id: itemId,
      packId: pack.id,
      versionId: draftVersion.id,
      assetId,
      name: trimmedName,
      sortOrder: existingItems.length,
      status: 'active',
      createdAt: now,
    }).run();

    // If pack has no cover yet, default to first sticker
    if (!pack.coverAssetId) {
      db.update(schema.stickerPacks).set({ coverAssetId: assetId, updatedAt: now })
        .where(eq(schema.stickerPacks.id, pack.id)).run();
      db.update(schema.stickerPackVersions).set({ coverAssetId: assetId })
        .where(eq(schema.stickerPackVersions.id, draftVersion.id)).run();
    }

    return {
      id: itemId,
      packId: pack.id,
      versionId: draftVersion.id,
      assetId,
      name: trimmedName,
      token: tokenFor(assetId),
      sortOrder: existingItems.length,
      status: 'active',
      createdAt: now,
    };
  });

  /**
   * Delete a sticker item from a pack's draft version.
   */
  app.delete<{ Params: { id: string; itemId: string } }>('/api/sticker-packs/:id/items/:itemId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();
    if (!pack || pack.creatorId !== request.userId) return sendError(reply, 403, 'forbidden');

    const item = db.select().from(schema.stickerPackItems).where(eq(schema.stickerPackItems.id, request.params.itemId)).get();
    if (!item || item.packId !== pack.id) return sendError(reply, 404, 'sticker_not_found');

    // Only allow editing draft/rejected versions
    const version = db.select().from(schema.stickerPackVersions).where(eq(schema.stickerPackVersions.id, item.versionId)).get();
    if (!version || !['draft', 'rejected'].includes(version.status)) {
      return sendError(reply, 400, 'sticker_pack_invalid_state');
    }

    db.delete(schema.stickerPackItems).where(eq(schema.stickerPackItems.id, item.id)).run();
    return { success: true };
  });

  /**
   * Reorder items in a draft pack version.
   */
  app.put<{ Params: { id: string }; Body: { itemIds: string[] } }>('/api/sticker-packs/:id/items/order', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();
    if (!pack || pack.creatorId !== request.userId) return sendError(reply, 403, 'forbidden');

    const { itemIds } = request.body;
    if (!Array.isArray(itemIds)) return sendError(reply, 400, 'validation_failed');

    itemIds.forEach((id, index) => {
      db.update(schema.stickerPackItems).set({ sortOrder: index })
        .where(and(eq(schema.stickerPackItems.id, id), eq(schema.stickerPackItems.packId, pack.id))).run();
    });

    return { success: true };
  });

  /**
   * Submit a sticker pack for admin review.
   */
  app.post<{ Params: { id: string } }>('/api/sticker-packs/:id/submit', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack || pack.creatorId !== request.userId) {
      return sendError(reply, 403, 'forbidden');
    }

    const draftVersion = db.select().from(schema.stickerPackVersions)
      .where(and(
        eq(schema.stickerPackVersions.packId, pack.id),
        or(eq(schema.stickerPackVersions.status, 'draft'), eq(schema.stickerPackVersions.status, 'rejected')),
      ))
      .orderBy(desc(schema.stickerPackVersions.version))
      .get();

    if (!draftVersion) {
      return sendError(reply, 400, 'sticker_pack_invalid_state');
    }

    const items = db.select().from(schema.stickerPackItems)
      .where(and(
        eq(schema.stickerPackItems.versionId, draftVersion.id),
        eq(schema.stickerPackItems.status, 'active'),
      )).all();

    if (items.length === 0) {
      return sendError(reply, 400, 'validation_failed');
    }

    const now = Date.now();
    db.update(schema.stickerPackVersions).set({ status: 'pending_review' })
      .where(eq(schema.stickerPackVersions.id, draftVersion.id)).run();

    db.update(schema.stickerPacks).set({
      status: 'pending_review',
      reviewNotes: null,
      updatedAt: now,
    }).where(eq(schema.stickerPacks.id, pack.id)).run();

    return { success: true, status: 'pending_review' };
  });

  /**
   * Create a new draft version for an approved pack to make updates non-destructively.
   */
  app.post<{ Params: { id: string } }>('/api/sticker-packs/:id/new-version', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack || pack.creatorId !== request.userId) {
      return sendError(reply, 403, 'forbidden');
    }
    if (pack.status !== 'approved') {
      return sendError(reply, 400, 'sticker_pack_invalid_state');
    }

    // Check if an unapproved draft or pending version already exists
    const existingDraft = db.select().from(schema.stickerPackVersions)
      .where(and(
        eq(schema.stickerPackVersions.packId, pack.id),
        or(eq(schema.stickerPackVersions.status, 'draft'), eq(schema.stickerPackVersions.status, 'pending_review')),
      )).get();

    if (existingDraft) {
      return sendError(reply, 409, 'sticker_pack_invalid_state');
    }

    // Copy items from current approved version into a new version
    const currentVersion = db.select().from(schema.stickerPackVersions)
      .where(and(
        eq(schema.stickerPackVersions.packId, pack.id),
        eq(schema.stickerPackVersions.version, pack.currentVersion),
      )).get();

    if (!currentVersion) return sendError(reply, 404, 'sticker_pack_not_found');

    const nextVersionNumber = pack.currentVersion + 1;
    const newVersionId = randomUUID();
    const now = Date.now();

    db.insert(schema.stickerPackVersions).values({
      id: newVersionId,
      packId: pack.id,
      version: nextVersionNumber,
      name: currentVersion.name,
      description: currentVersion.description,
      coverAssetId: currentVersion.coverAssetId,
      status: 'draft',
      createdAt: now,
    }).run();

    const currentItems = db.select().from(schema.stickerPackItems)
      .where(and(
        eq(schema.stickerPackItems.versionId, currentVersion.id),
        eq(schema.stickerPackItems.status, 'active'),
      )).all();

    for (const item of currentItems) {
      db.insert(schema.stickerPackItems).values({
        id: randomUUID(),
        packId: pack.id,
        versionId: newVersionId,
        assetId: item.assetId,
        name: item.name,
        sortOrder: item.sortOrder,
        status: 'active',
        createdAt: now,
      }).run();
    }

    return {
      id: pack.id,
      newVersion: nextVersionNumber,
      versionId: newVersionId,
      status: 'draft',
    };
  });

  /**
   * Soft delete a sticker pack.
   */
  app.delete<{ Params: { id: string } }>('/api/sticker-packs/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack || pack.status === 'deleted') {
      return sendError(reply, 404, 'sticker_pack_not_found');
    }

    const caller = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (pack.creatorId !== request.userId && caller?.isAdmin !== 1) {
      return sendError(reply, 403, 'forbidden');
    }

    const now = Date.now();
    db.update(schema.stickerPacks).set({ status: 'deleted', updatedAt: now })
      .where(eq(schema.stickerPacks.id, pack.id)).run();

    return { success: true };
  });

}
