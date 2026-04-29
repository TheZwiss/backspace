import type { FastifyInstance } from 'fastify';
import { authenticate, requireAdmin } from '../utils/auth.js';
import {
  createInvite,
  listInvites,
  patchInvite,
  revokeInvite,
  reinstateInvite,
  deleteInvite,
  listRedemptions,
  InviteNotFoundError,
  InviteStateConflictError,
  InviteValidationError,
} from '../utils/inviteService.js';
import type {
  CreateInviteRequest,
  UpdateInviteRequest,
  ReinstateInviteRequest,
} from '@backspace/shared';

/**
 * Admin CRUD routes for invite links. All endpoints sit behind the
 * `[authenticate, requireAdmin]` preHandler chain — invites are an
 * instance-local moderation surface and never reach federation.
 *
 * The handlers are thin wrappers: they parse the request shape, delegate
 * to `inviteService` (which owns validation, transactions, and status
 * derivation), and translate the typed service errors into HTTP statuses:
 *
 *   - InviteValidationError    → 400 Bad Request
 *   - InviteNotFoundError      → 404 Not Found
 *   - InviteStateConflictError → 409 Conflict
 *   - anything else            → propagates to Fastify's 500 handler
 *
 * Response shapes mirror spec §3.1 — see `docs/superpowers/specs/2026-04-28-registration-invites-design.md`.
 */
export async function invitesRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateInviteRequest }>('/api/admin/invites', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    try {
      const invite = createInvite(request.body, request.userId);
      return reply.code(201).send(invite);
    } catch (err) {
      if (err instanceof InviteValidationError) {
        return reply.code(400).send({ error: err.message, statusCode: 400 });
      }
      throw err;
    }
  });

  app.get<{ Querystring: { status?: string } }>('/api/admin/invites', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    const status = request.query.status === 'archived' ? 'archived' : 'active';
    const invites = listInvites(status);
    return reply.code(200).send({ invites });
  });

  app.patch<{ Params: { id: string }; Body: UpdateInviteRequest }>('/api/admin/invites/:id', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    try {
      const invite = patchInvite(request.params.id, request.body ?? {});
      return reply.code(200).send(invite);
    } catch (err) {
      if (err instanceof InviteNotFoundError) {
        return reply.code(404).send({ error: err.message, statusCode: 404 });
      }
      if (err instanceof InviteStateConflictError) {
        return reply.code(409).send({ error: err.message, statusCode: 409 });
      }
      if (err instanceof InviteValidationError) {
        return reply.code(400).send({ error: err.message, statusCode: 400 });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/invites/:id/revoke', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    try {
      const invite = revokeInvite(request.params.id);
      return reply.code(200).send({ invite });
    } catch (err) {
      if (err instanceof InviteNotFoundError) {
        return reply.code(404).send({ error: err.message, statusCode: 404 });
      }
      if (err instanceof InviteStateConflictError) {
        return reply.code(409).send({ error: err.message, statusCode: 409 });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string }; Body: ReinstateInviteRequest }>('/api/admin/invites/:id/reinstate', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    try {
      const result = reinstateInvite(request.params.id, request.body ?? {});
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof InviteNotFoundError) {
        return reply.code(404).send({ error: err.message, statusCode: 404 });
      }
      if (err instanceof InviteStateConflictError) {
        return reply.code(409).send({ error: err.message, statusCode: 409 });
      }
      if (err instanceof InviteValidationError) {
        return reply.code(400).send({ error: err.message, statusCode: 400 });
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/admin/invites/:id', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    try {
      deleteInvite(request.params.id);
      return reply.code(200).send({ success: true });
    } catch (err) {
      if (err instanceof InviteNotFoundError) {
        return reply.code(404).send({ error: err.message, statusCode: 404 });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/admin/invites/:id/redemptions', {
    preHandler: [authenticate, requireAdmin],
  }, async (request, reply) => {
    const redemptions = listRedemptions(request.params.id);
    return reply.code(200).send({ redemptions });
  });
}
