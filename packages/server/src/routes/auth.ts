import type { FastifyInstance } from 'fastify';
import { eq, or } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { hashPassword, verifyPassword, signJwt } from '../utils/auth.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { config } from '../config.js';
import type { RegisterRequest, LoginRequest, AuthResponse } from '@backspace/shared';
import { AVATAR_COLORS } from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';
import { findFederatedUser, extractDomain } from './federation.js';
import { fetchPeerEpoch } from '../utils/federationEpoch.js';
import { getInviteByToken, inviteStatus, redeemInvite, InviteUnavailableError } from '../utils/inviteService.js';

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
      return reply.code(400).send({ error: 'Username is required', statusCode: 400 });
    }

    if (!password || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Password is required', statusCode: 400 });
    }

    const trimmedUsername = username.trim().toLowerCase();

    // Replicated registrations (homeInstance provided) may use username@domain format
    // for collision fallback. Local registrations use strict alphanumeric+underscore.
    if (homeInstance) {
      // Validate homeInstance is a reasonable domain string
      if (typeof homeInstance !== 'string' || homeInstance.length > 253 || !/^[a-zA-Z0-9._-]+$/.test(homeInstance)) {
        return reply.code(400).send({ error: 'Invalid homeInstance domain', statusCode: 400 });
      }

      if (trimmedUsername.includes('@')) {
        // username@domain format: validate local part + domain part
        const atIndex = trimmedUsername.indexOf('@');
        const localPart = trimmedUsername.slice(0, atIndex);
        const domainPart = trimmedUsername.slice(atIndex + 1);

        if (localPart.length < 3 || localPart.length > 32 || !/^[a-z0-9_]+$/.test(localPart)) {
          return reply.code(400).send({ error: 'Username local part must be 3-32 lowercase alphanumeric/underscore characters', statusCode: 400 });
        }
        if (domainPart.length === 0 || domainPart.length > 253 || !/^[a-zA-Z0-9._-]+$/.test(domainPart)) {
          return reply.code(400).send({ error: 'Username domain part is invalid', statusCode: 400 });
        }
        if (trimmedUsername.length > 100) {
          return reply.code(400).send({ error: 'Username must be 100 characters or less', statusCode: 400 });
        }
      } else {
        // Replicated users MUST use username@domain format — plain usernames
        // are reserved exclusively for native users of this instance
        return reply.code(400).send({ error: 'Replicated users must use username@domain format', statusCode: 400 });
      }
    } else {
      // Local registration — strict validation
      if (trimmedUsername.length < 3 || trimmedUsername.length > 32) {
        return reply.code(400).send({ error: 'Username must be between 3 and 32 characters', statusCode: 400 });
      }
      if (!/^[a-z0-9_]+$/.test(trimmedUsername)) {
        return reply.code(400).send({ error: 'Username can only contain lowercase letters, numbers, and underscores', statusCode: 400 });
      }
    }

    if (password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters', statusCode: 400 });
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
        return reply.code(403).send({ error: 'Federated registration is closed on this instance', statusCode: 403 });
      }
      // Fall through to existing federated stub upgrade / new federated user logic below.
    } else {
      // Local path: registrationOpen is the primary gate. A valid invite token
      // bypasses it when closed. When open, the token is silently ignored.
      if (!registrationOpen) {
        if (!inviteToken) {
          return reply.code(403).send({ error: 'Registration is closed. An invite is required.', statusCode: 403 });
        }
        // Pre-flight check: reject obviously-invalid tokens before any expensive
        // work (bcrypt). The final enforcement still happens inside the redemption
        // transaction below — this only short-circuits the easy reject path.
        const inviteRow = getInviteByToken(inviteToken);
        if (!inviteRow || inviteStatus(inviteRow) !== 'active') {
          return reply.code(403).send({ error: 'Invalid or expired invite', statusCode: 403 });
        }
      }
      // If registrationOpen is true: inviteToken is silently ignored — no validation,
      // no consumption (spec §5.7).
    }

    const passwordHash = await hashPassword(password);

    // --- Federated stub upgrade path (BEFORE username uniqueness check) ---
    // If this is a federated registration, check if a relay-created stub already
    // exists for this person. If so, upgrade it (add credentials, update username)
    // instead of creating a duplicate record. The user gets their full DM history.
    // This must run BEFORE the username check because the stub may have a different
    // username (e.g., "291255103060533248@nova.ddns.net") that wouldn't collide.
    if (homeInstance && homeUserId) {
      const usernameBase = trimmedUsername.includes('@') ? trimmedUsername.split('@')[0]! : trimmedUsername;
      const existingStub = findFederatedUser(homeUserId, homeInstance, db, { username: usernameBase });

      if (existingStub) {
        // If the found user already has real credentials, they already registered.
        // Return 409 so the client falls back to login.
        if (existingStub.passwordHash !== '!federation-replicated') {
          return reply.code(409).send({ error: 'Username already taken', statusCode: 409 });
        }

        // Check the NEW username isn't taken by someone else (not the stub itself)
        const usernameCollision = db.select().from(schema.users)
          .where(eq(schema.users.username, trimmedUsername)).get();
        if (usernameCollision && usernameCollision.id !== existingStub.id) {
          return reply.code(409).send({ error: 'Username already taken', statusCode: 409 });
        }

        // Upgrade the stub: add credentials, update username and profile
        const updates: Record<string, string | number | null> = {
          passwordHash,
          username: trimmedUsername,
          homeUserId,
        };
        if (displayName?.trim() && !existingStub.displayName) {
          updates.displayName = displayName.trim();
        }
        const avatarColor = (requestedAvatarColor && (AVATAR_COLORS as readonly string[]).includes(requestedAvatarColor))
          ? requestedAvatarColor
          : AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
        if (!existingStub.avatarColor) {
          updates.avatarColor = avatarColor;
        }

        db.update(schema.users)
          .set(updates)
          .where(eq(schema.users.id, existingStub.id))
          .run();

        const upgraded = db.select().from(schema.users).where(eq(schema.users.id, existingStub.id)).get();
        if (!upgraded) {
          return reply.code(500).send({ error: 'Failed to upgrade user stub', statusCode: 500 });
        }

        console.log(`[auth] Upgraded federation stub ${existingStub.id} (${existingStub.username} → ${trimmedUsername}) to full account`);

        const token = signJwt({ userId: upgraded.id, username: upgraded.username });
        const response: AuthResponse = {
          token,
          user: sanitizeUser(upgraded, true),
        };
        return reply.code(200).send(response);
      }
    }

    // --- Normal registration path (no existing stub found) ---
    // Username uniqueness check (for non-federated registrations, or federated
    // registrations where no stub was found to upgrade)
    const existing = db.select().from(schema.users).where(eq(schema.users.username, trimmedUsername)).get();
    if (existing) {
      return reply.code(409).send({ error: 'Username already taken', statusCode: 409 });
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

    // Only the LOCAL-CLOSED-WITH-VALID-TOKEN path consumes an invite. The federated
    // paths (handled above and in the stub-upgrade block) and the local-open path
    // never touch the invite_links table.
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
          return reply.code(403).send({ error: 'Invalid or expired invite', statusCode: 403 });
        }
        throw err;
      }
    } else {
      // Standard local-open or federated-new-user path: plain user insert.
      db.insert(schema.users).values(userRow).run();
    }

    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!user) {
      return reply.code(500).send({ error: 'Failed to create user', statusCode: 500 });
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
      return reply.code(400).send({ available: false, reason: 'Username is required' });
    }

    const trimmed = raw.trim().toLowerCase();

    // Format validation (same rules as registration)
    if (trimmed.length < 3 || trimmed.length > 32) {
      return reply.code(200).send({ available: false, reason: 'Username must be between 3 and 32 characters' });
    }
    if (!/^[a-z0-9_]+$/.test(trimmed)) {
      return reply.code(200).send({ available: false, reason: 'Username can only contain lowercase letters, numbers, and underscores' });
    }

    // Check registration is open
    const db = getDb();
    const instanceRow = db.select().from(schema.instanceSettings).where(eq(schema.instanceSettings.id, 1)).get();
    const registrationOpen = instanceRow?.registrationOpen !== null && instanceRow?.registrationOpen !== undefined
      ? instanceRow.registrationOpen === 1
      : config.registrationOpen;
    if (!registrationOpen) {
      return reply.code(403).send({ available: false, reason: 'Registration is currently closed' });
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
      return reply.code(400).send({ error: 'Username is required', statusCode: 400 });
    }

    if (!password || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Password is required', statusCode: 400 });
    }

    const db = getDb();

    const user = db.select().from(schema.users).where(eq(schema.users.username, username.trim().toLowerCase())).get();
    if (!user) {
      return reply.code(401).send({ error: 'Invalid username or password', statusCode: 401 });
    }

    if (user.isDeleted) {
      return reply.code(401).send({ error: 'This account has been deleted', statusCode: 401 });
    }

    // A federated account whose home instance was reset (a new incarnation stood
    // up on the same domain) is FROZEN: its identity cannot be cryptographically
    // proven continuous across the wipe (design §2 non-goal), so we must never let
    // anyone — including a new same-name user on the reset home — authenticate into
    // it. Freezing is reversible (admin Keep/Remove, or the real user re-registers
    // into a fresh account). This is the enforcement half of the §6.3b quarantine;
    // it blocks the local-password path AND, by returning first, the self-heal path.
    if (user.federationHomeOrphaned === 1) {
      return reply.code(401).send({ error: 'Invalid username or password', statusCode: 401 });
    }

    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) {
      // For federated users, try verifying against the home instance.
      // If the password is valid there but stale here, self-heal the local hash.
      if (user.homeInstance) {
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
                return reply.code(401).send({ error: 'Invalid username or password', statusCode: 401 });
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
            return reply.code(401).send({ error: 'Invalid username or password', statusCode: 401 });
          }
        } catch {
          // Home instance unreachable — fall back to local-only rejection
          return reply.code(401).send({ error: 'Invalid username or password', statusCode: 401 });
        }
      } else {
        return reply.code(401).send({ error: 'Invalid username or password', statusCode: 401 });
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
}
