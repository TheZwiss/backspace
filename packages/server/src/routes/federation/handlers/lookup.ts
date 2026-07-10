import { getDb, schema } from '../../../db/index.js';
import { parseFederationHeaders, verifyPeerSignature } from '../../../utils/federationAuth.js';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isLookupRateLimited, isNonceDuplicate } from '../rateLimits.js';

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

      // 1. Verify HMAC (mirror relay endpoint)
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
      }

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, fedHeaders.origin))
        .get();

      if (!peer || peer.status !== 'active') {
        return reply.code(403).send({ error: 'Unknown or inactive peer', statusCode: 403 });
      }

      if (isLookupRateLimited(peer.origin)) {
        return reply.code(429).header('Retry-After', '60').send({ error: 'Rate limit exceeded', statusCode: 429 });
      }

      const bodyString = JSON.stringify(request.body);
      if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // 1b. Nonce-based replay protection
      if (fedHeaders.nonce) {
        if (isNonceDuplicate(peer.origin, fedHeaders.nonce)) {
          return reply.code(409).send({ error: 'Duplicate nonce — possible replay', statusCode: 409 });
        }
      } else if (peer.nonceSupported) {
        return reply.code(401).send({ error: 'Nonce required — peer previously supported nonces', statusCode: 401 });
      }

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
  // profile snapshot. Used by the stub-username backfill worker on peers that
  // hold legacy snowflake-named replicas of users now visible by their real
  // handle. Same auth+rate-limit shape as /users/lookup.
  app.post<{ Body: { homeUserId?: unknown } }>(
    '/api/federation/users/by-home-id',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const db = getDb();

      // 1. Verify HMAC headers
      const fedHeaders = parseFederationHeaders(request.headers as Record<string, string | string[] | undefined>);
      if (!fedHeaders) {
        return reply.code(401).send({ error: 'Missing or malformed federation headers', statusCode: 401 });
      }

      const peer = db
        .select()
        .from(schema.federationPeers)
        .where(eq(schema.federationPeers.origin, fedHeaders.origin))
        .get();

      if (!peer || peer.status !== 'active') {
        return reply.code(403).send({ error: 'Unknown or inactive peer', statusCode: 403 });
      }

      if (isLookupRateLimited(peer.origin)) {
        return reply.code(429).header('Retry-After', '60').send({ error: 'Rate limit exceeded', statusCode: 429 });
      }

      const bodyString = JSON.stringify(request.body);
      if (!verifyPeerSignature(bodyString, fedHeaders.signature, fedHeaders.timestamp, fedHeaders.nonce, peer)) {
        return reply.code(401).send({ error: 'Invalid signature', statusCode: 401 });
      }

      // Replay protection
      if (fedHeaders.nonce) {
        if (isNonceDuplicate(peer.origin, fedHeaders.nonce)) {
          return reply.code(409).send({ error: 'Duplicate nonce — possible replay', statusCode: 409 });
        }
      } else if (peer.nonceSupported) {
        return reply.code(401).send({ error: 'Nonce required — peer previously supported nonces', statusCode: 401 });
      }

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
          },
        },
      });
    },
  );

}
