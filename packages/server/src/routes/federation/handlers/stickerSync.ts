import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../../../db/index.js';
import { authenticateS2SPeer } from './s2sAuth.js';

export function registerStickerFederationRoutes(app: FastifyInstance): void {
  /**
   * S2S: Returns the list of locally created and approved sticker packs eligible for federation.
   */
  app.post('/api/federation/stickers/packs/list', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const auth = authenticateS2SPeer(request, reply);
    if (!auth.ok) return;

    const db = getDb();
    const packs = db.select().from(schema.stickerPacks)
      .where(and(
        eq(schema.stickerPacks.originType, 'source'),
        eq(schema.stickerPacks.status, 'approved'),
      )).all();

    const result = packs.map(pack => {
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
        creatorName: pack.creatorName,
        coverAssetId: pack.coverAssetId,
        currentVersion: pack.currentVersion,
        itemCount: items.length,
        createdAt: pack.createdAt,
        updatedAt: pack.updatedAt,
      };
    });

    return reply.code(200).send({ packs: result });
  });

  /**
   * S2S: Returns the detailed metadata and sticker item list for a specific approved pack.
   */
  app.post<{ Body: { packId?: unknown } }>('/api/federation/stickers/packs/get', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const auth = authenticateS2SPeer(request, reply);
    if (!auth.ok) return;

    const packId = typeof request.body?.packId === 'string' ? request.body.packId.trim() : null;
    if (!packId) {
      return reply.code(400).send({ error: 'packId is required', statusCode: 400 });
    }

    const db = getDb();
    const pack = db.select().from(schema.stickerPacks)
      .where(and(
        eq(schema.stickerPacks.id, packId),
        eq(schema.stickerPacks.originType, 'source'),
        eq(schema.stickerPacks.status, 'approved'),
      )).get();

    if (!pack) {
      return reply.code(404).send({ error: 'Sticker pack not found', statusCode: 404 });
    }

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

    return reply.code(200).send({
      id: pack.id,
      name: pack.name,
      description: pack.description,
      creatorName: pack.creatorName,
      coverAssetId: pack.coverAssetId,
      currentVersion: pack.currentVersion,
      items: items.map(item => ({
        assetId: item.assetId,
        name: item.name,
        sortOrder: item.sortOrder,
      })),
    });
  });
}
