import { getDb, schema } from '../../../db/index.js';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isLookupRateLimited } from '../rateLimits.js';
import { authenticateS2SPeer } from './s2sAuth.js';

export function registerLookupRoutes(app: FastifyInstance): void {
  // ─── POST /api/federation/users/lookup ─────────────────────────────────────
  // Server-to-server: resolve a username on this instance to its canonical
  // (homeUserId, profile snapshot). Used by another instance to construct a
  // friend_request_create event without requiring a federated user account.
  //
  // Returns 200 with profile snapshot for native users (regardless of the
  // user's `discoverable` setting — exact-handle resolution).
  // Returns 404 for tombstoned users, replicated stubs, or unknown usernames.
  app.post<{ Body: { username?: unknown } }>(
    '/api/federation/users/lookup',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const db = getDb();

      // Shared inbound S2S-auth preamble: headers → active peer → rate limit →
      // signature → nonce replay. The per-peer lookup rate limiter (60/min) runs
      // BEFORE signature verification and sends `Retry-After: 60`. This endpoint
      // never logged on a missing nonce (logMissingNonce omitted).
      const auth = authenticateS2SPeer(request, reply, {
        rateLimiter: { limited: isLookupRateLimited, retryAfterSeconds: 60 },
      });
      if (!auth.ok) return;

      // 2. Validate body
      const rawUsername = (request.body as { username?: unknown } | null)?.username;
      if (typeof rawUsername !== 'string') {
        return reply.code(400).send({ error: 'username is required (string)', statusCode: 400 });
      }
      const username = rawUsername.trim().toLowerCase();
      if (!username) {
        return reply.code(400).send({ error: 'username is required', statusCode: 400 });
      }

      // 3. Native-only lookup with isDeleted filter; discoverable is NOT consulted.
      const user = db
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.username, username),
            eq(schema.users.isDeleted, 0),
            isNull(schema.users.homeInstance),
          ),
        )
        .get();

      if (!user) {
        return reply.code(404).send({ found: false, code: 'user_not_found' });
      }

      return reply.code(200).send({
        found: true,
        user: {
          homeUserId: user.id,
          username: user.username,
          profile: {
            displayName: user.displayName,
            avatar: user.avatar,
            avatarColor: user.avatarColor,
            banner: user.banner,
            bio: user.bio,
            status: user.status as 'online' | 'idle' | 'dnd' | 'offline' | null,
          },
        },
      });
    },
  );

  // ─── POST /api/federation/users/by-home-id ──────────────────────────────────
  // Server-to-server: reverse-lookup a homeUserId to its canonical username +
  // versioned profile. Peers ask it when they create a row for one of our
  // users, on activation for rows with a placeholder or pre-1.8 suffixed name
  // or no profile version, from client DM routes and on re-attach; they apply
  // the answer as they apply a `profile_update`. Same auth+rate-limit shape
  // as /users/lookup.
  app.post<{ Body: { homeUserId?: unknown } }>(
    '/api/federation/users/by-home-id',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const db = getDb();

      // Shared inbound S2S-auth preamble: headers → active peer → rate limit →
      // signature → nonce replay. Same shape as /users/lookup: per-peer lookup
      // rate limiter (60/min) BEFORE signature, `Retry-After: 60`, no
      // missing-nonce warning.
      const auth = authenticateS2SPeer(request, reply, {
        rateLimiter: { limited: isLookupRateLimited, retryAfterSeconds: 60 },
      });
      if (!auth.ok) return;

      // 2. Validate body
      const rawId = (request.body as { homeUserId?: unknown } | null)?.homeUserId;
      if (typeof rawId !== 'string' || rawId.trim().length === 0) {
        return reply.code(400).send({ error: 'homeUserId is required (string)', statusCode: 400 });
      }
      const homeUserId = rawId.trim();

      // 3. Native-only lookup. Match by id (canonical native id) OR home_user_id
      // (backfilled column natives carry to satisfy tier-1 lookups). Excludes
      // tombstoned and replicated stubs.
      const user = db
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.isDeleted, 0),
            isNull(schema.users.homeInstance),
            or(eq(schema.users.id, homeUserId), eq(schema.users.homeUserId, homeUserId)),
          ),
        )
        .get();

      if (!user) {
        return reply.code(200).send({ found: false });
      }

      return reply.code(200).send({
        found: true,
        user: {
          homeUserId: user.homeUserId ?? user.id,
          username: user.username,
          profile: {
            displayName: user.displayName,
            avatar: user.avatar,
            avatarColor: user.avatarColor,
            status: user.status as 'online' | 'idle' | 'dnd' | 'offline' | null,
            banner: user.banner,
            bio: user.bio,
            accentColor: user.accentColor,
            // The version `profile_update` carries. A profile never edited
            // has none stored; it is the one the account was created with,
            // so its creation time orders it before every later edit.
            profileUpdatedAt: user.profileUpdatedAt ?? user.createdAt,
          },
        },
      });
    },
  );

}
