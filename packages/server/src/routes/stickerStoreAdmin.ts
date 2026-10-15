import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { authenticate, requireAdmin } from '../utils/auth.js';
import { sendError } from '../utils/httpErrors.js';
import { buildFederationHeaders, getOurOrigin } from '../utils/federationAuth.js';
import { federationFetch } from '../utils/federationFetch.js';
import { syncRemotePack } from '../utils/stickerSync.js';
import type { StickerPackStatus } from '@backspace/shared/src/stickers.js';
import { formatCoverUrl } from './stickerStore.js';

export async function stickerStoreAdminRoutes(app: FastifyInstance): Promise<void> {
  // ─── Admin Moderation & Federation Management ────────────────────────────

  /**
   * Admin: List sticker packs waiting for review.
   */
  app.get('/api/admin/sticker-packs/reviews', {
    preHandler: [authenticate, requireAdmin],
  }, async () => {
    const db = getDb();
    const packs = db.select().from(schema.stickerPacks)
      .where(eq(schema.stickerPacks.status, 'pending_review'))
      .orderBy(desc(schema.stickerPacks.updatedAt))
      .all();

    return packs.map(pack => {
      const version = db.select().from(schema.stickerPackVersions)
        .where(and(
          eq(schema.stickerPackVersions.packId, pack.id),
          eq(schema.stickerPackVersions.status, 'pending_review'),
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
        createdAt: pack.createdAt,
        updatedAt: pack.updatedAt,
      };
    });
  });

  /**
   * Admin: Approve a sticker pack and its pending version.
   */
  app.post<{ Params: { id: string } }>('/api/admin/sticker-packs/:id/approve', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack) {
      return sendError(reply, 404, 'sticker_pack_not_found');
    }

    const pendingVersion = db.select().from(schema.stickerPackVersions)
      .where(and(
        eq(schema.stickerPackVersions.packId, pack.id),
        eq(schema.stickerPackVersions.status, 'pending_review'),
      )).get();

    const now = Date.now();

    if (pendingVersion) {
      db.update(schema.stickerPackVersions).set({
        status: 'approved',
      }).where(eq(schema.stickerPackVersions.id, pendingVersion.id)).run();

      db.update(schema.stickerPacks).set({
        name: pendingVersion.name,
        description: pendingVersion.description,
        coverAssetId: pendingVersion.coverAssetId,
        currentVersion: pendingVersion.version,
        status: 'approved',
        reviewNotes: null,
        reviewedBy: request.userId,
        reviewedAt: now,
        updatedAt: now,
      }).where(eq(schema.stickerPacks.id, pack.id)).run();
    } else {
      db.update(schema.stickerPacks).set({
        status: 'approved',
        reviewedBy: request.userId,
        reviewedAt: now,
        updatedAt: now,
      }).where(eq(schema.stickerPacks.id, pack.id)).run();
    }

    return { success: true, status: 'approved' };
  });

  /**
   * Admin: Reject a sticker pack and its pending version.
   */
  app.post<{ Params: { id: string }; Body?: { reviewNotes?: string } }>('/api/admin/sticker-packs/:id/reject', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack) {
      return sendError(reply, 404, 'sticker_pack_not_found');
    }

    const now = Date.now();
    const notes = request.body?.reviewNotes?.trim() || null;

    const pendingVersion = db.select().from(schema.stickerPackVersions)
      .where(and(
        eq(schema.stickerPackVersions.packId, pack.id),
        eq(schema.stickerPackVersions.status, 'pending_review'),
      )).get();

    if (pendingVersion) {
      db.update(schema.stickerPackVersions).set({
        status: 'rejected',
      }).where(eq(schema.stickerPackVersions.id, pendingVersion.id)).run();
    }

    const nextStatus = pack.currentVersion > 0 && pack.status === 'approved' ? 'approved' : 'rejected';

    db.update(schema.stickerPacks).set({
      status: nextStatus,
      reviewNotes: notes,
      reviewedBy: request.userId,
      reviewedAt: now,
      updatedAt: now,
    }).where(eq(schema.stickerPacks.id, pack.id)).run();

    return { success: true, status: nextStatus };
  });

  /**
   * Admin: List all packs across all statuses.
   */
  app.get<{ Querystring: { status?: string; originType?: string; q?: string } }>('/api/admin/sticker-packs', {
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const db = getDb();
    const { status, originType, q } = request.query;

    const queryFilters = [];
    if (status) queryFilters.push(eq(schema.stickerPacks.status, status));
    if (originType) queryFilters.push(eq(schema.stickerPacks.originType, originType));

    const rows = queryFilters.length > 0
      ? db.select().from(schema.stickerPacks).where(and(...queryFilters)).orderBy(desc(schema.stickerPacks.updatedAt)).all()
      : db.select().from(schema.stickerPacks).orderBy(desc(schema.stickerPacks.updatedAt)).all();

    const filtered = q?.trim()
      ? rows.filter(r => r.name.toLowerCase().includes(q.trim().toLowerCase()))
      : rows;

    return filtered.map(pack => {
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
        createdAt: pack.createdAt,
        updatedAt: pack.updatedAt,
      };
    });
  });

  /**
   * Admin: Set a sticker pack's administrative status (e.g. block / disable / active).
   */
  app.post<{ Params: { id: string }; Body: { status: 'approved' | 'blocked' | 'disabled' | 'active' } }>('/api/admin/sticker-packs/:id/status', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    const db = getDb();
    const pack = db.select().from(schema.stickerPacks).where(eq(schema.stickerPacks.id, request.params.id)).get();

    if (!pack) {
      return sendError(reply, 404, 'sticker_pack_not_found');
    }

    const { status } = request.body;
    if (!['approved', 'blocked', 'disabled', 'active'].includes(status)) {
      return sendError(reply, 400, 'validation_failed');
    }

    const now = Date.now();
    db.update(schema.stickerPacks).set({
      status,
      updatedAt: now,
    }).where(eq(schema.stickerPacks.id, pack.id)).run();

    return { success: true, status };
  });

  /**
   * Admin: Get sticker federation peer policies and active peer instances.
   */
  app.get('/api/admin/federation/stickers/peers', {
    preHandler: [authenticate, requireAdmin],
  }, async () => {
    const db = getDb();
    const peers = db.select().from(schema.federationPeers).all();
    const policies = db.select().from(schema.stickerPeerPolicies).all();
    const policyMap = new Map(policies.map(p => [p.peerOrigin, p]));

    return peers.map(peer => {
      const pol = policyMap.get(peer.origin);
      const replicas = db.select().from(schema.stickerPacks)
        .where(eq(schema.stickerPacks.sourceInstance, peer.origin)).all();

      return {
        origin: peer.origin,
        instanceName: peer.instanceName,
        policy: pol?.policy ?? 'allow',
        autoSync: pol ? Boolean(pol.autoSync) : false,
        replicaCount: replicas.length,
      };
    });
  });

  /**
   * Admin: Set peer sticker policy (allow or block, autoSync).
   */
  app.put<{ Params: { peerOrigin: string }; Body: { policy: 'allow' | 'block'; autoSync?: boolean } }>('/api/admin/federation/stickers/peers/:peerOrigin/policy', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    const db = getDb();
    const { peerOrigin } = request.params;
    const { policy, autoSync } = request.body;

    if (!['allow', 'block'].includes(policy)) {
      return sendError(reply, 400, 'validation_failed');
    }

    const now = Date.now();
    const existing = db.select().from(schema.stickerPeerPolicies)
      .where(eq(schema.stickerPeerPolicies.peerOrigin, peerOrigin)).get();

    if (existing) {
      db.update(schema.stickerPeerPolicies).set({
        policy,
        autoSync: autoSync !== undefined ? (autoSync ? 1 : 0) : existing.autoSync,
        updatedAt: now,
      }).where(eq(schema.stickerPeerPolicies.peerOrigin, peerOrigin)).run();
    } else {
      db.insert(schema.stickerPeerPolicies).values({
        id: randomUUID(),
        peerOrigin,
        policy,
        autoSync: autoSync ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    if (policy === 'block') {
      db.update(schema.stickerPacks).set({
        status: 'blocked',
        updatedAt: now,
      }).where(eq(schema.stickerPacks.sourceInstance, peerOrigin)).run();
    }

    return { success: true, policy };
  });

  /**
   * Admin: Query available sticker packs from an active remote peer.
   */
  app.get<{ Querystring: { peerOrigin: string } }>('/api/admin/federation/stickers/remote-packs', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    const { peerOrigin } = request.query;
    if (!peerOrigin) return sendError(reply, 400, 'validation_failed');

    const db = getDb();
    const peer = db.select().from(schema.federationPeers)
      .where(eq(schema.federationPeers.origin, peerOrigin)).get();

    if (!peer || peer.status !== 'active') {
      return sendError(reply, 404, 'not_found');
    }

    try {
      const ourOrigin = getOurOrigin();
      const body = JSON.stringify({});
      const headers = buildFederationHeaders(body, peer.hmacSecret, ourOrigin);

      const response = await federationFetch(
        peer.origin,
        '/api/federation/stickers/packs/list',
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        },
        'approved',
      );

      if (!response.ok) {
        return reply.code(response.status).send({ error: 'Failed to fetch remote sticker packs', statusCode: response.status });
      }

      const data = await response.json();
      return data;
    } catch (err) {
      return reply.code(502).send({ error: `Could not reach peer: ${(err as Error).message}`, statusCode: 502 });
    }
  });

  /**
   * Admin: Trigger synchronization of a remote pack from an active peer.
   */
  app.post<{ Body: { peerOrigin: string; packId: string } }>('/api/admin/federation/stickers/sync', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    const { peerOrigin, packId } = request.body;
    if (!peerOrigin || !packId) return sendError(reply, 400, 'validation_failed');

    try {
      const result = await syncRemotePack({ peerOrigin, packId });
      return { success: true, ...result };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'sticker_peer_blocked') {
        return sendError(reply, 403, 'sticker_peer_blocked');
      }
      return reply.code(502).send({ error: `Sync failed: ${msg}`, statusCode: 502 });
    }
  });
}
