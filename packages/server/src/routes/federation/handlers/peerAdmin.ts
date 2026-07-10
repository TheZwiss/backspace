import path from 'node:path';
import { getDb, schema } from '../../../db/index.js';
import { authenticate, requireAdmin } from '../../../utils/auth.js';
import { buildFederationHeaders, generateHmacSecret } from '../../../utils/federationAuth.js';
import { onPeerDeactivated } from '../../../utils/federationPeerActivation.js';
import { probePeerReachable, recoverOrDetectReset } from '../../../utils/federationRecovery.js';
import { homeInstanceMatch } from '../../../utils/federationReset.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { resolveLocalOrigin, sanitizePeer } from '../origin.js';

export function registerPeerAdminRoutes(app: FastifyInstance): void {
  // ─── GET /api/federation/peers ─────────────────────────────────────────────
  // Admin-only: list all federation peers (hmacSecret excluded).
  app.get(
    '/api/federation/peers',
    { preHandler: [authenticate, requireAdmin] },
    async (_request, reply) => {
      const db = getDb();
      const peers = db
        .select()
        .from(schema.federationPeers)
        .all();

      return reply.code(200).send({ peers: peers.map(sanitizePeer) });
    },
  );

  // ─── GET /api/federation/reset-events ──────────────────────────────────────
  // Admin-only: the durable reset journal + per-origin orphaned real accounts,
  // for the "Reset cleanup" admin surface (instance-epoch self-healing §6.4).
  // Read-only; disposition actions reuse the existing one-click Re-peer (reset
  // + initiate) and the existing DELETE /api/admin/users/:id (full-purge Remove).
  app.get(
    '/api/federation/reset-events',
    { preHandler: [authenticate, requireAdmin] },
    async (_request, reply) => {
      const db = getDb();
      const events = db.select().from(schema.federationResetEvents).all();

      const result = events.map((ev) => {
        const accounts = db
          .select({
            id: schema.users.id,
            username: schema.users.username,
            displayName: schema.users.displayName,
            avatarColor: schema.users.avatarColor,
          })
          .from(schema.users)
          .where(and(
            eq(schema.users.federationHomeOrphaned, 1),
            eq(schema.users.isDeleted, 0),
            homeInstanceMatch(ev.origin),
          ))
          .all();

        const orphanedAccounts = accounts.map((a) => {
          const ownedSpaces = db
            .select({ id: schema.spaces.id, name: schema.spaces.name })
            .from(schema.spaces)
            .where(eq(schema.spaces.ownerId, a.id))
            .all();
          const spaceMemberCount = db
            .select({ n: sql<number>`count(*)` })
            .from(schema.spaceMembers)
            .where(eq(schema.spaceMembers.userId, a.id))
            .get()?.n ?? 0;
          const messageCount = db
            .select({ n: sql<number>`count(*)` })
            .from(schema.messages)
            .where(eq(schema.messages.userId, a.id))
            .get()?.n ?? 0;
          return { ...a, ownedSpaces, spaceMemberCount, messageCount };
        });

        return {
          origin: ev.origin,
          deadEpoch: ev.deadEpoch,
          newEpoch: ev.newEpoch,
          detectedAt: ev.detectedAt,
          resolvedAt: ev.resolvedAt,
          stubCount: ev.stubCount,
          orphanedAccountCount: ev.orphanedAccountCount,
          acknowledgedAt: ev.acknowledgedAt,
          orphanedAccounts,
        };
      });

      return reply.code(200).send({ events: result });
    },
  );

  // ─── POST /api/federation/reset-events/acknowledge ─────────────────────────
  // Admin-only: dismiss a reset event from the admin banner. Purely
  // informational state — detached accounts stay detached and functional;
  // acknowledging just stops the surface from re-listing them (detach spec §4.6).
  app.post<{ Body: { origin: string } }>(
    '/api/federation/reset-events/acknowledge',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { origin } = request.body;
      if (!origin || typeof origin !== 'string') {
        return reply.code(400).send({ error: 'origin is required', statusCode: 400 });
      }
      const db = getDb();
      const existing = db
        .select()
        .from(schema.federationResetEvents)
        .where(eq(schema.federationResetEvents.origin, origin))
        .get();
      if (!existing) {
        return reply.code(404).send({ error: 'No reset event for this origin', statusCode: 404 });
      }
      if (existing.acknowledgedAt === null) {
        db.update(schema.federationResetEvents)
          .set({ acknowledgedAt: Date.now() })
          .where(eq(schema.federationResetEvents.origin, origin))
          .run();
      }
      return reply.code(200).send({ success: true });
    },
  );

  // ─── DELETE /api/federation/peers/:id ──────────────────────────────────────
  // Admin-only: revoke a federation peer and clean up its outbox.
  app.delete<{ Params: { id: string } }>(
    '/api/federation/peers/:id',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      // Revoke the peer
      db.update(schema.federationPeers)
        .set({ status: 'revoked' })
        .where(eq(schema.federationPeers.id, id))
        .run();

      onPeerDeactivated(id, 'admin_revoked').catch(err =>
        console.error('[federation] onPeerDeactivated from admin revoke failed:', err),
      );

      // Delete all outbox entries for this peer
      db.delete(schema.federationOutbox)
        .where(eq(schema.federationOutbox.peerId, id))
        .run();

      return reply.code(200).send({ success: true });
    },
  );

  // ─── POST /api/federation/peers/:id/reset ──────────────────────────────────
  // Admin-only: reset a peer that has transitioned to needs_attention.
  // Deletes the local peer row (cascade-deletes outbox entries via FK).
  // Admin must re-initiate peering out of band after reset.
  app.post<{ Params: { id: string } }>(
    '/api/federation/peers/:id/reset',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      if (peer.status !== 'needs_attention') {
        return reply.code(400).send({
          error: 'Reset is only available for peers in the needs_attention state. Use revoke for active peers.',
          statusCode: 400,
        });
      }

      // Cascade-delete handles federation_outbox entries (FK onDelete: 'cascade').
      db.delete(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .run();

      connectionManager.sendToAdmins({ type: 'federation_peers_changed' as const });

      return reply.code(200).send({ success: true });
    },
  );

  // ─── POST /api/federation/peers/:id/recheck ────────────────────────────────
  // Admin-only: run an immediate reachability probe on an unreachable peer.
  // On success the peer transitions to active (outbox flushes on the next tick).
  app.post<{ Params: { id: string } }>(
    '/api/federation/peers/:id/recheck',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      if (peer.status !== 'unreachable') {
        return reply.code(400).send({
          error: 'Recheck is only available for unreachable peers.',
          statusCode: 400,
        });
      }

      const probe = await probePeerReachable(peer.origin);

      if (probe.reachable) {
        const outcome = await recoverOrDetectReset(peer, probe);
        if (outcome === 'reset_detected') {
          // The peer is a new incarnation on the same domain. It was routed to
          // needs_attention (detection-only, no rekey) and must NOT be recovered
          // to active until an admin re-peers through the authenticated path.
          return reply.code(200).send({ recovered: false, status: 'needs_attention' });
        }
        return reply.code(200).send({ recovered: true, status: 'active' });
      }

      // Probe failed — advance pacing so a manual attempt stays consistent with
      // the recovery worker's schedule.
      db.update(schema.federationPeers)
        .set({ probeAttempts: peer.probeAttempts + 1, lastProbeAt: Date.now() })
        .where(eq(schema.federationPeers.id, peer.id))
        .run();

      return reply.code(200).send({ recovered: false, status: 'unreachable' });
    },
  );

  // ─── PATCH /api/federation/peers/:id ────────────────────────────────────────
  // Admin-only: update peer settings (e.g. auto-rotation interval).
  app.patch<{ Params: { id: string }; Body: { autoRotateIntervalDays?: number } }>(
    '/api/federation/peers/:id',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      const updateData: Record<string, number> = {};

      if (request.body.autoRotateIntervalDays !== undefined) {
        const interval = Number(request.body.autoRotateIntervalDays);
        if (isNaN(interval) || !Number.isInteger(interval) || interval < 1 || interval > 365) {
          return reply.code(400).send({ error: 'autoRotateIntervalDays must be an integer between 1 and 365', statusCode: 400 });
        }
        updateData.autoRotateIntervalDays = interval;
      }

      if (Object.keys(updateData).length === 0) {
        return reply.code(400).send({ error: 'No valid fields to update', statusCode: 400 });
      }

      db.update(schema.federationPeers)
        .set(updateData)
        .where(eq(schema.federationPeers.id, id))
        .run();

      const updated = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      return reply.code(200).send({ peer: sanitizePeer(updated!) });
    },
  );

  // ─── DELETE /api/federation/peers/:id/permanent ─────────────────────────────
  // Admin-only: permanently delete a revoked peer record.
  app.delete<{ Params: { id: string } }>(
    '/api/federation/peers/:id/permanent',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      if (peer.status !== 'revoked') {
        return reply.code(400).send({
          error: 'Only revoked peers can be permanently deleted. Revoke the peer first.',
          statusCode: 400,
        });
      }

      db.delete(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .run();

      return reply.code(200).send({ success: true });
    },
  );

  // ─── POST /api/federation/peers/:id/rotate ──────────────────────────────────
  // Admin-only: trigger immediate secret rotation for a peer.
  app.post<{ Params: { id: string } }>(
    '/api/federation/peers/:id/rotate',
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params;
      const db = getDb();

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.id, id))
        .get();

      if (!peer) {
        return reply.code(404).send({ error: 'Peer not found', statusCode: 404 });
      }

      if (peer.status !== 'active') {
        return reply.code(400).send({ error: 'Can only rotate secrets for active peers', statusCode: 400 });
      }

      if (peer.pendingHmacSecret) {
        return reply.code(409).send({
          error: 'A secret rotation is already in progress — wait for it to complete',
          statusCode: 409,
        });
      }

      const newSecret = generateHmacSecret();
      let localOrigin: string;
      try {
        localOrigin = resolveLocalOrigin();
      } catch {
        return reply.code(500).send({
          error: 'Cannot determine local instance origin. Set the DOMAIN environment variable.',
          statusCode: 500,
        });
      }

      // Send rotation request to peer, signed with the CURRENT (old) secret
      try {
        const rotateBody = JSON.stringify({ newSecret });
        const headers = buildFederationHeaders(rotateBody, peer.hmacSecret, localOrigin);

        const response = await fetch(`${peer.origin}/api/federation/peer/rotate`, {
          method: 'POST',
          headers,
          body: rotateBody,
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          let errorMessage = `Remote instance rejected rotation (HTTP ${response.status})`;
          try {
            const body = await response.json() as { error?: string };
            if (body.error) errorMessage = body.error;
          } catch { /* ignore parse failures */ }

          return reply.code(502).send({ error: errorMessage, statusCode: 502 });
        }

        // Store pending secret locally AFTER remote peer confirms acceptance
        db.update(schema.federationPeers)
          .set({
            pendingHmacSecret: newSecret,
            secretRotationAt: Date.now(),
          })
          .where(eq(schema.federationPeers.id, peer.id))
          .run();

        console.log(`[federation] Secret rotation initiated with peer ${peer.origin}`);

        return reply.code(200).send({ success: true, gracePeriodMs: 900_000 });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          return reply.code(504).send({
            error: 'Remote instance did not respond within 10 seconds',
            statusCode: 504,
          });
        }
        return reply.code(502).send({
          error: `Failed to reach remote instance: ${message}`,
          statusCode: 502,
        });
      }
    },
  );

}
