import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { eq, like, or, and, ne, sql, isNull, isNotNull, gte, lte, asc, desc } from 'drizzle-orm';
import { authenticate, requireAdmin, hashPassword } from '../utils/auth.js';
import { getStorageStats, getOrphanedFiles, cleanupStorage, cleanupOldMedia, cleanupStaleTusSessions } from '../utils/storageJanitor.js';
import { getDb, schema } from '../db/index.js';
import { connectionManager } from '../ws/handler.js';
import { tombstoneUser, collectDeletionBroadcastTargets } from '../utils/userDeletion.js';
import { deleteUploadFile } from '../utils/fileCleanup.js';
import { sanitizeUser } from '../utils/sanitize.js';
import type { AdminUser, AdminUserListResponse, AdminResetPasswordResponse } from '@backspace/shared';

function toAdminUser(row: typeof schema.users.$inferSelect): AdminUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatar: row.avatar,
    avatarColor: row.avatarColor,
    status: row.status ?? 'offline',
    isAdmin: row.isAdmin === 1,
    isDeleted: row.isDeleted === 1,
    homeInstance: row.homeInstance,
    createdAt: row.createdAt,
  };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ─── Storage Management ──────────────────────────────────────────────────

  // GET /api/admin/storage/stats — storage overview
  app.get('/api/admin/storage/stats', { preHandler: [authenticate, requireAdmin] }, async (_request, reply) => {
    try {
      const stats = getStorageStats();
      return reply.code(200).send(stats);
    } catch (err: any) {
      return reply.code(500).send({ error: `Failed to compute storage stats: ${err.message}`, statusCode: 500 });
    }
  });

  // GET /api/admin/storage/orphans — list orphaned files
  app.get('/api/admin/storage/orphans', { preHandler: [authenticate, requireAdmin] }, async (_request, reply) => {
    try {
      const orphans = getOrphanedFiles();
      return reply.code(200).send({ orphans });
    } catch (err: any) {
      return reply.code(500).send({ error: `Failed to list orphaned files: ${err.message}`, statusCode: 500 });
    }
  });

  // POST /api/admin/storage/cleanup — delete orphaned files
  app.post<{ Body: { dryRun?: boolean } }>('/api/admin/storage/cleanup', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    try {
      const dryRun = request.body?.dryRun ?? false;
      const result = cleanupStorage(dryRun);
      return reply.code(200).send(result);
    } catch (err: any) {
      return reply.code(500).send({ error: `Cleanup failed: ${err.message}`, statusCode: 500 });
    }
  });

  // POST /api/admin/storage/cleanup-media — delete chat media older than N days
  app.post<{ Body: { maxAgeDays: number; dryRun?: boolean } }>('/api/admin/storage/cleanup-media', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    try {
      const maxAgeDays = Number(request.body?.maxAgeDays);
      if (isNaN(maxAgeDays) || maxAgeDays < 1) {
        return reply.code(400).send({ error: 'maxAgeDays must be a positive number', statusCode: 400 });
      }
      const dryRun = request.body?.dryRun ?? false;
      const result = cleanupOldMedia(maxAgeDays, dryRun);
      return reply.code(200).send(result);
    } catch (err: any) {
      return reply.code(500).send({ error: `Media cleanup failed: ${err.message}`, statusCode: 500 });
    }
  });

  // POST /api/admin/storage/cleanup-tus — admin-driven sweep of stale tus
  // upload sessions. Defaults: maxAgeHours=1 (matches the staleTusSessions
  // display threshold), dryRun=false. Per-file unlink errors are surfaced via
  // CleanupResult.errors. No DB rows touched — `.tus/` is filesystem-only.
  app.post<{ Body: { maxAgeHours?: number; dryRun?: boolean } }>('/api/admin/storage/cleanup-tus', { preHandler: [authenticate, requireAdmin] }, async (request, reply) => {
    try {
      const rawAge = request.body?.maxAgeHours;
      const maxAgeHours = rawAge === undefined ? 1 : Number(rawAge);
      if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
        return reply.code(400).send({ error: 'maxAgeHours must be a positive finite number', statusCode: 400 });
      }
      const dryRun = request.body?.dryRun ?? false;
      const thresholdMs = maxAgeHours * 60 * 60 * 1000;
      const result = cleanupStaleTusSessions(thresholdMs, dryRun);
      return reply.code(200).send({
        dryRun,
        deletedFiles: result.deletedFiles,
        freedBytes: result.freedBytes,
        deletedAttachmentRecords: 0,
        errors: result.errors,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: `Tus cleanup failed: ${err.message}`, statusCode: 500 });
    }
  });

  // ─── User Management ────────────────────────────────────────────────────

  // GET /api/admin/users — paginated user list with search
  app.get<{ Querystring: { q?: string; page?: string; pageSize?: string; showDeleted?: string; homeInstance?: string; role?: string; joinedAfter?: string; joinedBefore?: string; sort?: string } }>(
    '/api/admin/users',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const db = getDb();
      const q = request.query.q?.trim() || '';
      const page = Math.max(1, parseInt(request.query.page || '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(request.query.pageSize || '50', 10) || 50));
      const showDeleted = request.query.showDeleted === 'true';

      const conditions = [];
      if (!showDeleted) {
        conditions.push(eq(schema.users.isDeleted, 0));
      }
      if (q) {
        const pattern = `%${q}%`;
        conditions.push(or(
          like(schema.users.username, pattern),
          like(schema.users.displayName, pattern),
        )!);
      }

      // Instance filter
      const homeInstanceFilter = request.query.homeInstance;
      if (homeInstanceFilter === 'local') {
        conditions.push(isNull(schema.users.homeInstance));
      } else if (homeInstanceFilter) {
        conditions.push(eq(schema.users.homeInstance, homeInstanceFilter));
      }

      // Role filter
      const roleFilter = request.query.role;
      if (roleFilter === 'admin') {
        conditions.push(eq(schema.users.isAdmin, 1));
      } else if (roleFilter === 'non-admin') {
        conditions.push(eq(schema.users.isAdmin, 0));
      }

      // Date range filter
      const joinedAfter = request.query.joinedAfter;
      if (joinedAfter) {
        const ts = new Date(joinedAfter).getTime();
        if (!isNaN(ts)) conditions.push(gte(schema.users.createdAt, ts));
      }
      const joinedBefore = request.query.joinedBefore;
      if (joinedBefore) {
        const ts = new Date(joinedBefore + 'T23:59:59.999Z').getTime();
        if (!isNaN(ts)) conditions.push(lte(schema.users.createdAt, ts));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // Dynamic sort
      const sortParam = request.query.sort || 'newest';
      let orderByClause;
      switch (sortParam) {
        case 'oldest': orderByClause = asc(schema.users.createdAt); break;
        case 'az': orderByClause = asc(schema.users.username); break;
        case 'za': orderByClause = desc(schema.users.username); break;
        default: orderByClause = desc(schema.users.createdAt); break;
      }

      const countResult = db.select({ count: sql<number>`count(*)` })
        .from(schema.users)
        .where(where)
        .get();
      const total = countResult?.count ?? 0;

      const rows = db.select()
        .from(schema.users)
        .where(where)
        .orderBy(orderByClause)
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .all();

      const response: AdminUserListResponse = {
        users: rows.map(toAdminUser),
        total,
        page,
        pageSize,
      };

      return reply.code(200).send(response);
    },
  );

  // GET /api/admin/users/instances — distinct home instance domains
  app.get('/api/admin/users/instances', { preHandler: [authenticate, requireAdmin] }, async (_request, reply) => {
    const db = getDb();
    const rows = db.selectDistinct({ homeInstance: schema.users.homeInstance })
      .from(schema.users)
      .where(isNotNull(schema.users.homeInstance))
      .all();
    const instances = rows.map(r => r.homeInstance).filter(Boolean) as string[];
    return reply.code(200).send({ instances });
  });

  // PATCH /api/admin/users/:id/role — promote/demote admin
  app.patch<{ Params: { id: string }; Body: { isAdmin: boolean } }>(
    '/api/admin/users/:id/role',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id: targetId } = request.params;
      const { isAdmin } = request.body;

      if (typeof isAdmin !== 'boolean') {
        return reply.code(400).send({ error: 'isAdmin must be a boolean', statusCode: 400 });
      }

      const db = getDb();
      const target = db.select().from(schema.users).where(eq(schema.users.id, targetId)).get();
      if (!target) {
        return reply.code(404).send({ error: 'User not found', statusCode: 404 });
      }
      if (target.isDeleted === 1) {
        return reply.code(400).send({ error: 'Cannot change role of a deleted user', statusCode: 400 });
      }

      // Promote: block federated users
      if (isAdmin && target.homeInstance) {
        return reply.code(403).send({ error: 'Federated users cannot be promoted to admin', statusCode: 403 });
      }

      // Demote: prevent removing the last admin
      if (!isAdmin && target.isAdmin === 1) {
        const adminCount = db.select({ count: sql<number>`count(*)` })
          .from(schema.users)
          .where(and(eq(schema.users.isAdmin, 1), eq(schema.users.isDeleted, 0)))
          .get();
        if ((adminCount?.count ?? 0) <= 1) {
          return reply.code(400).send({ error: 'Cannot demote the last admin', statusCode: 400 });
        }
      }

      db.update(schema.users)
        .set({ isAdmin: isAdmin ? 1 : 0 })
        .where(eq(schema.users.id, targetId))
        .run();

      const updated = db.select().from(schema.users).where(eq(schema.users.id, targetId)).get()!;

      // Broadcast user_updated so the target's UI reflects the isAdmin change
      connectionManager.sendToUser(targetId, {
        type: 'user_updated',
        user: sanitizeUser(updated),
      });

      return reply.code(200).send(toAdminUser(updated));
    },
  );

  // POST /api/admin/users/:id/reset-password — generate temporary password
  app.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/reset-password',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id: targetId } = request.params;
      const db = getDb();

      const target = db.select().from(schema.users).where(eq(schema.users.id, targetId)).get();
      if (!target) {
        return reply.code(404).send({ error: 'User not found', statusCode: 404 });
      }
      if (target.isDeleted === 1) {
        return reply.code(400).send({ error: 'Cannot reset password of a deleted user', statusCode: 400 });
      }
      if (target.homeInstance) {
        return reply.code(400).send({ error: 'Federated users authenticate via their home instance', statusCode: 400 });
      }

      const temporaryPassword = crypto.randomBytes(12).toString('base64url');
      const hash = await hashPassword(temporaryPassword);

      db.update(schema.users)
        .set({ passwordHash: hash, passwordChangedAt: Date.now() })
        .where(eq(schema.users.id, targetId))
        .run();

      // Force re-auth by disconnecting all sessions
      connectionManager.forceDisconnectUser(targetId);

      const response: AdminResetPasswordResponse = { temporaryPassword };
      return reply.code(200).send(response);
    },
  );

  // DELETE /api/admin/users/:id — tombstone a user account
  app.delete<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id: targetId } = request.params;
      const db = getDb();

      if (targetId === request.userId) {
        return reply.code(400).send({ error: 'Use account settings to delete your own account', statusCode: 400 });
      }

      const target = db.select().from(schema.users).where(eq(schema.users.id, targetId)).get();
      if (!target) {
        return reply.code(404).send({ error: 'User not found', statusCode: 404 });
      }
      if (target.isDeleted === 1) {
        return reply.code(400).send({ error: 'User is already deleted', statusCode: 400 });
      }

      // Check if user owns any spaces
      const ownedSpaces = db.select({ id: schema.spaces.id, name: schema.spaces.name })
        .from(schema.spaces)
        .where(eq(schema.spaces.ownerId, targetId))
        .all();
      if (ownedSpaces.length > 0) {
        return reply.code(400).send({
          error: 'User owns spaces — transfer ownership first',
          statusCode: 400,
          ownedSpaces,
        });
      }

      // Collect broadcast targets BEFORE tombstone deletes DB rows
      const { memberSpaceIds, targetUserIds } = collectDeletionBroadcastTargets(targetId);

      const filesToDelete = tombstoneUser(targetId);
      for (const filename of filesToDelete) {
        deleteUploadFile(filename);
      }

      // Broadcast member_left to each space
      for (const spaceId of memberSpaceIds) {
        connectionManager.sendToSpace(spaceId, {
          type: 'member_left',
          spaceId,
          userId: targetId,
        });
      }

      // Broadcast user_updated with sanitized deleted user data
      const deletedRow = getDb().select().from(schema.users).where(eq(schema.users.id, targetId)).get();
      if (deletedRow) {
        const deletedUser = sanitizeUser(deletedRow);
        const userUpdatedEvent = { type: 'user_updated' as const, user: deletedUser };
        for (const uid of targetUserIds) {
          connectionManager.sendToUser(uid, userUpdatedEvent);
        }
      }

      connectionManager.forceDisconnectUser(targetId);

      return reply.code(200).send({ success: true });
    },
  );

  // Test-only: seed federation_peers row directly. STRICTLY gated by NODE_ENV='test'
  // AND ENABLE_TEST_ROUTES='1'. Returns 404 in any other configuration. Used by
  // the two-instance integration harness to wire up matching HMAC secrets between
  // home and remote without running the multi-step approval flow.
  app.post<{ Body: { origin: string; hmacSecret: string; status?: string; instanceName?: string } }>(
    '/api/admin/test/seed-peer',
    async (request, reply) => {
      if (process.env.NODE_ENV !== 'test' || process.env.ENABLE_TEST_ROUTES !== '1') {
        return reply.code(404).send({ error: 'Not Found', statusCode: 404 });
      }
      const { origin, hmacSecret, status, instanceName } = request.body;
      if (typeof origin !== 'string' || !origin.startsWith('http')) {
        return reply.code(400).send({ error: 'origin must be an http(s) URL', statusCode: 400 });
      }
      if (typeof hmacSecret !== 'string' || hmacSecret.length < 32) {
        return reply.code(400).send({ error: 'hmacSecret must be a string ≥32 chars', statusCode: 400 });
      }
      const validStatuses = new Set(['active', 'pending', 'awaiting_approval', 'rejected', 'revoked', 'needs_attention', 'unreachable', 'accepted']);
      if (status !== undefined && !validStatuses.has(status)) {
        return reply.code(400).send({ error: `status must be one of ${[...validStatuses].join(', ')}`, statusCode: 400 });
      }
      const db = getDb();
      const id = crypto.randomUUID();
      db.insert(schema.federationPeers)
        .values({
          id,
          origin,
          instanceName: instanceName ?? null,
          hmacSecret,
          status: status ?? 'active',
          consecutiveFailures: 0,
          consecutiveAuthFailures: 0,
          lastSyncedAt: 0,
          nonceSupported: 1,
          autoRotateIntervalDays: 90,
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: schema.federationPeers.origin,
          set: { hmacSecret, status: status ?? 'active', instanceName: instanceName ?? null },
        })
        .run();
      return reply.code(200).send({ ok: true, id });
    },
  );
}
