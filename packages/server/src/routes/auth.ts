import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq, or, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb, schema } from '../db/index.js';
import { hashPassword, verifyPassword, signJwt, authenticate } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { config } from '../config.js';
import type { RegisterRequest, LoginRequest, AuthResponse } from '@backspace/shared';
import { AVATAR_COLORS } from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';
import { extractDomain } from './federation.js';
import { fetchPeerEpoch } from '../utils/federationEpoch.js';
import { stripTrailingSlashes } from '../utils/federationAuth.js';
import { getInviteByToken, inviteStatus, redeemInvite, InviteUnavailableError } from '../utils/inviteService.js';
import { sendError, errorText } from '../utils/httpErrors.js';
import type { ErrorCode, ErrorDetails } from '@backspace/shared/src/errors';

const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const FEDERATED_USERNAME_MAX = 100;
const PASSWORD_MIN = 8;

/**
 * The availability check answers `{ available, reason }` rather than the
 * error contract, so a client that predates codes keeps working; the code
 * and details ride along for clients that localize.
 */
function unavailable(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  details?: ErrorDetails,
): FastifyReply {
  return reply.code(statusCode).send({
    available: false,
    reason: errorText(code, details),
    code,
    ...(details ? { details } : {}),
  });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterRequest }>('/api/auth/register', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '2 minutes',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const { username, password, displayName, avatarColor: requestedAvatarColor, homeInstance, homeUserId } = request.body;

    if (!username || typeof username !== 'string') {
      return sendError(reply, 400, 'username_required');
    }

    if (!password || typeof password !== 'string') {
      return sendError(reply, 400, 'password_required');
    }

    const trimmedUsername = username.trim().toLowerCase();

    // Replicated registrations (homeInstance provided) may use username@domain format
    // for collision fallback. Local registrations use strict alphanumeric+underscore.
    if (homeInstance) {
      // Validate homeInstance is a reasonable domain string
      if (typeof homeInstance !== 'string' || homeInstance.length > 253 || !/^[a-zA-Z0-9._-]+$/.test(homeInstance)) {
        return sendError(reply, 400, 'home_instance_invalid');
      }

      if (trimmedUsername.includes('@')) {
        // username@domain format: validate local part + domain part
        const atIndex = trimmedUsername.indexOf('@');
        const localPart = trimmedUsername.slice(0, atIndex);
        const domainPart = trimmedUsername.slice(atIndex + 1);

        if (localPart.length < USERNAME_MIN || localPart.length > USERNAME_MAX || !/^[a-z0-9_]+$/.test(localPart)) {
          return sendError(reply, 400, 'username_local_part_invalid', { min: USERNAME_MIN, max: USERNAME_MAX });
        }
        if (domainPart.length === 0 || domainPart.length > 253 || !/^[a-zA-Z0-9._-]+$/.test(domainPart)) {
          return sendError(reply, 400, 'username_domain_part_invalid');
        }
        if (trimmedUsername.length > FEDERATED_USERNAME_MAX) {
          return sendError(reply, 400, 'username_too_long', { max: FEDERATED_USERNAME_MAX });
        }
      } else {
        // Replicated users MUST use username@domain format — plain usernames
        // are reserved exclusively for native users of this instance
        return sendError(reply, 400, 'replicated_username_format_required');
      }
    } else {
      // Local registration — strict validation
      if (trimmedUsername.length < USERNAME_MIN || trimmedUsername.length > USERNAME_MAX) {
        return sendError(reply, 400, 'username_length_invalid', { min: USERNAME_MIN, max: USERNAME_MAX });
      }
      if (!/^[a-z0-9_]+$/.test(trimmedUsername)) {
        return sendError(reply, 400, 'username_characters_invalid');
      }
    }

    if (password.length < PASSWORD_MIN) {
      return sendError(reply, 400, 'password_too_short', { min: PASSWORD_MIN });
    }

    const db = getDb();

    // Read both gates from instance_settings.
    // - registrationOpen: nullable column; null falls back to env var (config.registrationOpen).
    //   Admin-explicit 0/1 overrides env. Gates LOCAL anonymous signup.
    // - federatedRegistrationOpen: NOT NULL DEFAULT 1 column. Gates FEDERATED identity
    //   replication (homeInstance set). Independent of registrationOpen by spec §1.2.
    const instanceRow = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    const registrationOpen = instanceRow?.registrationOpen !== null && instanceRow?.registrationOpen !== undefined
      ? instanceRow.registrationOpen === 1
      : config.registrationOpen;
    // instanceRow is guaranteed by ensureDefaults() (migrate.ts) to have id=1
    // post-boot, with federatedRegistrationOpen NOT NULL DEFAULT 1. The optional
    // chain is defensive against the impossible-in-production case of a missing
    // row (e.g., a hand-cleared DB) — falls open-closed rather than open-open
    // for federation, which is the safer default.
    const federatedRegistrationOpen = instanceRow?.federatedRegistrationOpen === 1;

    // Optional invite token. Only meaningful for the local-closed path; ignored
    // entirely on the federated path (spec §1.3, §5.6) and on the local-open path
    // (spec §5.7).
    const inviteToken = typeof request.body.inviteToken === 'string'
      ? request.body.inviteToken
      : undefined;

    if (homeInstance) {
      // Federated path: token IGNORED entirely. Gate is federatedRegistrationOpen.
      if (!federatedRegistrationOpen) {
        return sendError(reply, 403, 'federated_registration_closed');
      }
      // Falls through to the normal create-a-new-row path below. A federated
      // registration NEVER binds credentials to a pre-existing row.
    } else {
      // Local path: registrationOpen is the primary gate. A valid invite token
      // bypasses it when closed. When open, the token is silently ignored.
      if (!registrationOpen) {
        if (!inviteToken) {
          return sendError(reply, 403, 'invite_required');
        }
        // Pre-flight check: reject obviously-invalid tokens before any expensive
        // work (bcrypt). The final enforcement still happens inside the redemption
        // transaction below — this only short-circuits the easy reject path.
        const inviteRow = getInviteByToken(inviteToken);
        if (!inviteRow || inviteStatus(inviteRow) !== 'active') {
          return sendError(reply, 403, 'invite_invalid');
        }
      }
      // If registrationOpen is true: inviteToken is silently ignored — no validation,
      // no consumption (spec §5.7).
    }

    const passwordHash = await hashPassword(password);

    // --- Registration always creates a NEW row ---
    // This endpoint is public and unauthenticated: the caller supplies
    // `homeInstance`/`homeUserId` with no proof whatsoever that they control
    // that federated identity. It therefore must never bind these credentials
    // to a row that already exists — in particular not to a relay-created stub
    // (`passwordHash = '!federation-replicated'`), which is a placeholder for a
    // person who has never authenticated here. `homeUserId` is only unique
    // WITHIN an instance, so it is not an identifier we can match on either.
    //
    // Merging a stub into a real account (so the owner inherits their DM
    // history) is exclusively the job of the authenticated, S2S-proof-gated
    // reattach flow: POST /api/users/@me/reattach, which requires an
    // attach-proof token minted by the home instance.
    const existing = db.select().from(schema.users).where(eq(schema.users.username, trimmedUsername)).get();
    if (existing) {
      return sendError(reply, 409, 'username_taken');
    }

    const userId = generateSnowflake();
    const now = Date.now();

    // First registered user becomes instance admin (replicated users are never admins)
    const userCount = db.select().from(schema.users).all().length;
    const isFirstUser = userCount === 0 && !homeInstance;

    const avatarColor = (requestedAvatarColor && (AVATAR_COLORS as readonly string[]).includes(requestedAvatarColor))
      ? requestedAvatarColor
      : AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

    // Note: status is left at the schema default ('offline') and is set to
    // 'online' exclusively by the WebSocket auth path (ws/handler.ts). A
    // successful REST /register does not by itself imply a live connection —
    // the client may never establish a WS (transient network failure, mobile
    // background, error path between this 201 response and /ws connect),
    // which would otherwise produce a permanently stuck-online row that no
    // disconnect timer can clean up. The WS handshake will flip it to
    // 'online' once a real socket attaches.
    const userRow = {
      id: userId,
      username: trimmedUsername,
      displayName: displayName?.trim() || null,
      passwordHash,
      isAdmin: isFirstUser ? 1 : 0,
      homeInstance: homeInstance || null,
      homeUserId: (homeInstance && homeUserId && typeof homeUserId === 'string') ? homeUserId : null,
      avatarColor,
      createdAt: now,
    };

    // Only the LOCAL-CLOSED-WITH-VALID-TOKEN path consumes an invite. The
    // federated path (gated above on federatedRegistrationOpen) and the
    // local-open path never touch the invite_links table.
    const consumesInvite = !homeInstance && !registrationOpen && !!inviteToken;

    if (consumesInvite) {
      // Atomic redemption: the user INSERT, the usedCount bump, and the
      // invite_redemptions row all run inside one SQLite transaction. If any
      // step throws (token consumed by a concurrent request, username collision
      // bumping into the unique index, etc.) the entire transaction rolls back —
      // we never burn a redemption on a failed registration.
      try {
        redeemInvite(inviteToken!, () => {
          db.insert(schema.users).values(userRow).run();
          return { id: userId, username: trimmedUsername };
        });
      } catch (err) {
        if (err instanceof InviteUnavailableError) {
          // Concurrent revoke / last-slot race / expiry-while-typing all surface here.
          return sendError(reply, 403, 'invite_invalid');
        }
        throw err;
      }
    } else {
      // Standard local-open or federated-new-user path: plain user insert.
      db.insert(schema.users).values(userRow).run();
    }

    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!user) {
      return sendError(reply, 500, 'user_create_failed');
    }

    const token = signJwt({ userId: user.id, username: user.username });

    const response: AuthResponse = {
      token,
      user: sanitizeUser(user, true),
    };

    return reply.code(201).send(response);
  });

  app.get<{ Querystring: { username?: string } }>('/api/auth/check-username', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const raw = request.query.username;
    if (!raw || typeof raw !== 'string') {
      return unavailable(reply, 400, 'username_required');
    }

    const trimmed = raw.trim().toLowerCase();

    // Format validation (same rules as registration)
    if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) {
      return unavailable(reply, 200, 'username_length_invalid', { min: USERNAME_MIN, max: USERNAME_MAX });
    }
    if (!/^[a-z0-9_]+$/.test(trimmed)) {
      return unavailable(reply, 200, 'username_characters_invalid');
    }

    // Check registration is open
    const db = getDb();
    const instanceRow = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    const registrationOpen = instanceRow?.registrationOpen !== null && instanceRow?.registrationOpen !== undefined
      ? instanceRow.registrationOpen === 1
      : config.registrationOpen;
    if (!registrationOpen) {
      return unavailable(reply, 403, 'registration_closed');
    }

    const existing = db.select().from(schema.users).where(eq(schema.users.username, trimmed)).get();
    return reply.code(200).send({ available: !existing });
  });

  // Public — used by RegisterPage to debounce-validate invite tokens during
  // typing. The status -> response mapping enforces a "collapsed enumeration
  // shield": revoked, not-found, and malformed tokens all collapse to
  // `'invalid'` so this endpoint can't be used to distinguish them. Only
  // `expired` and `exhausted` surface as themselves because those are
  // legitimate UX hints ("ask the admin to extend it") rather than
  // existence/state leaks. The `name` field is returned ONLY in the valid
  // case — invalid responses must not leak any invite metadata.
  // Status code is always 200; the response body discriminates.
  app.get<{ Querystring: { token?: string } }>('/api/auth/check-invite', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const token = request.query.token;
    if (!token || typeof token !== 'string') {
      return reply.code(200).send({ valid: false, reason: 'invalid' });
    }

    // getInviteByToken pre-validates the 22-char base64url shape before
    // hitting the DB; malformed inputs return null here, so the same branch
    // covers both "wrong shape" and "shape ok, not in DB".
    const row = getInviteByToken(token);
    if (!row) {
      return reply.code(200).send({ valid: false, reason: 'invalid' });
    }

    const status = inviteStatus(row);
    if (status === 'active') {
      return reply.code(200).send({ valid: true, name: row.name });
    }
    if (status === 'expired' || status === 'exhausted') {
      return reply.code(200).send({ valid: false, reason: status });
    }
    // status === 'revoked' — collapsed to 'invalid' (no enumeration leak)
    return reply.code(200).send({ valid: false, reason: 'invalid' });
  });

  app.post<{ Body: LoginRequest }>('/api/auth/login', {
    config: {
      rateLimit: {
        max: 15,
        timeWindow: '2 minutes',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const { username, password } = request.body;

    if (!username || typeof username !== 'string') {
      return sendError(reply, 400, 'username_required');
    }

    if (!password || typeof password !== 'string') {
      return sendError(reply, 400, 'password_required');
    }

    const db = getDb();

    const user = db.select().from(schema.users).where(eq(schema.users.username, username.trim().toLowerCase())).get();
    if (!user) {
      return sendError(reply, 401, 'invalid_credentials');
    }

    if (user.isDeleted) {
      return sendError(reply, 401, 'account_deleted');
    }

    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      // For federated users, try verifying against the home instance.
      // If the password is valid there but stale here, self-heal the local hash.
      if (user.homeInstance) {
        // Detached account (§6.3b detach): its home domain now belongs to a
        // DIFFERENT incarnation — there is no trusted home to consult. The
        // self-heal path is permanently disabled: re-hashing on the new
        // incarnation's say-so would hand this established account to a
        // stranger. Local-hash login above remains the only (and sufficient)
        // way in — the hash was only ever written by the owner's registration
        // or an epoch-gated self-heal against the OLD incarnation.
        if (user.federationHomeOrphaned === 1) {
          return sendError(reply, 401, 'invalid_credentials');
        }
        try {
          const homeUsername = user.username.includes('@')
            ? user.username.split('@')[0]!
            : user.username;

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);

          const homeResponse = await fetch(`https://${user.homeInstance}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: homeUsername, password }),
            signal: controller.signal,
          });

          clearTimeout(timeout);

          if (homeResponse.ok) {
            // §6.3a epoch guard: self-heal (re-hashing the local password because
            // the home accepted it) must fire ONLY when the home instance is the
            // SAME incarnation we established trust with. A reset home (new
            // incarnation on the same domain) accepting a NEW same-name user's
            // credentials would otherwise silently hand that stranger this
            // established account. We gate on the trusted baseline epoch.
            //
            // Reuse the authenticated fetchPeerEpoch (HMAC-signed both ways) rather
            // than an unauthenticated login-response body — the latter is
            // TLS-MITM-bypassable and would re-open the exact hijack this closes.
            const homeDomain = extractDomain(user.homeInstance);
            const peer = db.select().from(schema.federationPeers)
              .where(or(
                eq(schema.federationPeers.origin, homeDomain),
                eq(schema.federationPeers.origin, `https://${homeDomain}`),
                eq(schema.federationPeers.origin, `http://${homeDomain}`),
              ))
              .get();

            if (peer && peer.peerInstanceId) {
              // Baseline on record → enforce. currentEpoch === null means "cannot
              // determine" (peer too old → 404, unreachable, bad sig, or the reset
              // peer's desynced secret rejects our signed request) → fail closed.
              const currentEpoch = await fetchPeerEpoch({ origin: peer.origin, hmacSecret: peer.hmacSecret });
              if (currentEpoch !== peer.peerInstanceId) {
                app.log.warn(
                  `Refused self-heal for ${user.username}: home epoch ${currentEpoch ?? 'unknown'} != baseline ${peer.peerInstanceId}`,
                );
                return sendError(reply, 401, 'invalid_credentials');
              }
            }
            // No peer row / null baseline → legacy allow (fall through to self-heal).

            // Home instance accepted the password — update our stale hash.
            // Do NOT set passwordChangedAt: this is a state correction, not a
            // password change. Setting it would invalidate existing valid JWTs.
            const newHash = await hashPassword(password);
            db.update(schema.users)
              .set({ passwordHash: newHash })
              .where(eq(schema.users.id, user.id))
              .run();

            app.log.info(`Self-healed password hash for federated user ${user.username} via ${user.homeInstance}`);
          } else {
            // Home instance also rejected — password is genuinely wrong
            return sendError(reply, 401, 'invalid_credentials');
          }
        } catch {
          // Home instance unreachable — fall back to local-only rejection
          return sendError(reply, 401, 'invalid_credentials');
        }
      } else {
        return sendError(reply, 401, 'invalid_credentials');
      }
    }

    // Note: status='online' is set exclusively by the WebSocket auth path
    // (ws/handler.ts). A successful REST /login does not by itself imply a
    // live connection — the client may never establish a WS (transient
    // network failure, mobile background, error path), which would otherwise
    // produce a permanently stuck-online row that no disconnect timer can
    // clean up. The user's reported status remains whatever it was; the WS
    // handshake will flip it to 'online' once a real socket attaches.
    const token = signJwt({ userId: user.id, username: user.username });

    const response: AuthResponse = {
      token,
      user: sanitizeUser(user, true),
    };

    return reply.code(200).send(response);
  });

  // ─── POST /api/auth/attach-proof ──────────────────────────────────────────
  // Mint a one-time proof token for detached-account re-attach on a peer
  // (re-attach spec §3.1). Native accounts only — the token proves control of
  // THIS home identity. 60s TTL, single-use, bound to the target peer domain
  // (the verifying peer's domain is checked server-side on D, not trusted from
  // the token bearer).
  app.post<{ Body: { targetDomain?: unknown } }>('/api/auth/attach-proof', {
    preHandler: authenticate,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const db = getDb();

    const rawTarget = request.body?.targetDomain;
    if (typeof rawTarget !== 'string' || rawTarget.trim().length === 0 || rawTarget.length > 255) {
      return sendError(reply, 400, 'target_domain_required');
    }
    const targetDomain = stripTrailingSlashes(rawTarget.trim().toLowerCase().replace(/^https?:\/\//, ''));
    // Re-check emptiness AFTER normalization: inputs like "https://" or "/"
    // pass the pre-normalization guard but collapse to "" — never persist an
    // inert target_domain='' proof row.
    if (targetDomain.length === 0) {
      return sendError(reply, 400, 'target_domain_required');
    }

    // Native accounts only — a federated/replicated account has no authority
    // to mint proofs for this domain's identities.
    if (request.homeInstance) {
      return sendError(reply, 403, 'native_account_required');
    }

    const now = Date.now();
    // Opportunistic janitor: expired rows have no residual value.
    db.delete(schema.federationAttachProofs)
      .where(lt(schema.federationAttachProofs.expiresAt, now))
      .run();

    const token = randomBytes(32).toString('hex');
    db.insert(schema.federationAttachProofs).values({
      token,
      homeUserId: request.userId,
      targetDomain,
      createdAt: now,
      expiresAt: now + 60_000,
      usedAt: null,
    }).run();

    return reply.code(200).send({ token });
  });
}
