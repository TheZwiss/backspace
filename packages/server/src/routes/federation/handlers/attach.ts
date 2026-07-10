import path from 'node:path';
import { config } from '../../../config.js';
import { getDb, getRawDb, schema } from '../../../db/index.js';
import { authenticate } from '../../../utils/auth.js';
import { fetchHomeProfileByHomeId, verifyAttachProofWithPeer } from '../../../utils/federationAttach.js';
import { parseFederationHeaders, verifyPeerSignature } from '../../../utils/federationAuth.js';
import { sendSignedJson } from './signedResponse.js';
import { sanitizeUser } from '../../../utils/sanitize.js';
import { collectProfileBroadcastTargetIds } from '../../../utils/userDeletion.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, eq, isNull, or } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { DmChannel } from '@backspace/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { buildDmChannelPayload } from '../dmChannels.js';
import { extractDomain } from '../identity.js';
import { downloadProfileAsset } from '../profile.js';
import { isLookupRateLimited, isNonceDuplicate } from '../rateLimits.js';
import { reconcileDmChannelFederatedId } from '../reconciliation.js';
import type { DmReconcileResult } from '../reconciliation.js';

export function registerAttachRoutes(app: FastifyInstance): void {
  // ─── POST /api/federation/verify-attach-proof ───────────────────────────────
  // Server-to-server: verify a one-time attach-proof token minted by
  // /api/auth/attach-proof (re-attach spec §3.1). The token is single-use (an
  // atomic claim guarantees only one concurrent verification can win) and is
  // bound to the CALLING peer's domain — the binding is checked against the
  // authenticated peer row (extractDomain(peer.origin)), NEVER trusted from the
  // request body. This is the anti-replay control: a compromised requester
  // cannot redeem a token minted for a different peer. The response is HMAC-
  // signed (epoch pattern) so the caller can trust the identity it carries; all
  // failure modes fail closed to a signed { valid: false }.
  app.post<{ Body: { token?: unknown } }>(
    '/api/federation/verify-attach-proof',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const db = getDb();
      const rawDb = getRawDb();

      // 1. Verify HMAC headers (mirror by-home-id / users-lookup).
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

      // 2. Sign every downstream response with the peer's shared secret so the
      // caller can trust the identity (or the fail-closed verdict) it carries.
      const sendSigned = (payload: { valid: false } | { valid: true; homeUserId: string; username: string }): FastifyReply =>
        sendSignedJson(reply, payload, peer.hmacSecret);

      // 3. Validate the token shape (64 hex chars, as minted by attach-proof).
      const rawToken = (request.body as { token?: unknown } | null)?.token;
      if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/i.test(rawToken)) {
        return sendSigned({ valid: false });
      }

      // 4. Atomic single-use claim. The domain binding is server-side: the
      // token's target_domain must equal the AUTHENTICATED peer's domain, never
      // a value from the request body. Concurrent verifications cannot both win
      // because only the first UPDATE that flips used_at from NULL matches.
      const peerDomain = extractDomain(peer.origin).toLowerCase();
      const now = Date.now();
      const claimed = rawDb.prepare(`
        UPDATE federation_attach_proofs
        SET used_at = ?
        WHERE token = ? AND used_at IS NULL AND expires_at > ? AND lower(target_domain) = ?
        RETURNING home_user_id
      `).get(now, rawToken, now, peerDomain) as { home_user_id: string } | undefined;

      if (!claimed) {
        return sendSigned({ valid: false });
      }

      // 5. Re-confirm the home user is still native (not tombstoned, not turned
      // into a replicated stub) since the token was minted.
      const homeUser = db
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.id, claimed.home_user_id),
            eq(schema.users.isDeleted, 0),
            isNull(schema.users.homeInstance),
          ),
        )
        .get();

      if (!homeUser) {
        return sendSigned({ valid: false });
      }

      return sendSigned({ valid: true, homeUserId: homeUser.id, username: homeUser.username });
    },
  );

  // ─── POST /api/users/@me/reattach ────────────────────────────────────────────
  // Owner-initiated exception to the detach invariant (re-attach spec §3.2).
  // Requires BOTH identities: the session proves the detached account (local
  // password authority), the one-time token — verified with the home peer over
  // signed S2S — proves the new home account. Registered here rather than in
  // users.ts because it consumes federation-internal machinery (peer HMAC
  // channel, profile fetch, asset download). URL path stays /api/users/@me/*.
  app.post<{ Body: { token?: unknown } }>('/api/users/@me/reattach', {
    preHandler: authenticate,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const db = getDb();
    const rawDb = getRawDb();

    const rawToken = (request.body as { token?: unknown } | null)?.token;
    if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/i.test(rawToken)) {
      return reply.code(400).send({ error: 'token is required (64-char hex)', statusCode: 400 });
    }

    // Guard 1: session user must be a LIVE detached federated account. A missing
    // or tombstoned row is a 404 (nothing to re-attach); a live non-detached /
    // native account is a 403 (re-attach is meaningless — it already syncs).
    const detached = db.select().from(schema.users).where(eq(schema.users.id, request.userId)).get();
    if (!detached || detached.isDeleted === 1) {
      return reply.code(404).send({ error: 'User not found', statusCode: 404 });
    }
    if (!detached.homeInstance || detached.federationHomeOrphaned !== 1) {
      return reply.code(403).send({ error: 'Only detached accounts can re-attach', statusCode: 403 });
    }

    // Guard 2: the home domain must be an ACTIVE peer — the proof is only as
    // trustworthy as the S2S channel it is verified over.
    const homeDomain = extractDomain(detached.homeInstance).toLowerCase();
    const normPeer = (origin: string) => extractDomain(origin).toLowerCase();
    const peerRow = db.select().from(schema.federationPeers).all()
      .find(p => normPeer(p.origin) === homeDomain && p.status === 'active');
    if (!peerRow) {
      return reply.code(409).send({ error: 'Home instance is not an active peer', statusCode: 409 });
    }

    // Guard 3: verify the one-time proof with the home instance (fails closed).
    const verified = await verifyAttachProofWithPeer(peerRow, rawToken);
    if (!verified.valid) {
      return reply.code(401).send({ error: 'Attach proof could not be verified', statusCode: 401 });
    }

    // Guard 4: if the new identity already has a local row for this domain, it
    // MUST be a replicated stub (the merge source, §3.3). A real account holding
    // it means state corruption — abort loudly, do not merge.
    const normHome = `lower(replace(replace(coalesce(home_instance, ''), 'https://', ''), 'http://', ''))`;
    const existingRow = rawDb.prepare(`
      SELECT id, password_hash FROM users
      WHERE home_user_id = ? AND ${normHome} = ? AND is_deleted = 0 AND id != ?
    `).get(verified.homeUserId, homeDomain, detached.id) as { id: string; password_hash: string } | undefined;
    if (existingRow && existingRow.password_hash !== '!federation-replicated') {
      console.error(`[federation] Re-attach conflict: identity ${verified.homeUserId}@${homeDomain} held by non-stub account ${existingRow.id}`);
      return reply.code(409).send({ error: 'The new identity is already bound to another account on this instance', statusCode: 409 });
    }

    // Username: adopt the new home base when it differs (existing collision-suffix
    // scheme). Usernames are not identity, so a base match keeps the current handle.
    const currentBase = detached.username.includes('@')
      ? detached.username.slice(0, detached.username.indexOf('@'))
      : detached.username;
    let newUsername = detached.username;
    const newBase = verified.username.toLowerCase();
    if (newBase !== currentBase.toLowerCase()) {
      let candidate = `${newBase}@${homeDomain}`;
      let attempt = 0;
      while (rawDb.prepare(`SELECT 1 FROM users WHERE username = ? AND id != ?`).get(candidate, detached.id)) {
        attempt++;
        candidate = `${newBase}_${attempt}@${homeDomain}`;
        if (attempt > 10) {
          candidate = `${newBase}_${randomBytes(4).toString('hex')}@${homeDomain}`;
          break;
        }
      }
      newUsername = candidate;
    }

    // Merge + re-bind, atomically. All users.id FK repointing lives here; dedupe
    // rows that would collide on a composite PK / unique index BEFORE repointing
    // (spec §3.3). The stub row is the only source — a real account holding the
    // identity was already rejected by guard 4.
    const dmReconcileResults: DmReconcileResult[] = [];
    rawDb.transaction(() => {
      if (existingRow) {
        const stubId = existingRow.id;
        const targetId = detached.id;
        // dm_members (composite PK dm_channel_id+user_id → dedupe): drop the
        // stub's membership where the detached row is already a member.
        rawDb.prepare(`DELETE FROM dm_members WHERE user_id = ? AND dm_channel_id IN (SELECT dm_channel_id FROM dm_members WHERE user_id = ?)`).run(stubId, targetId);
        rawDb.prepare(`UPDATE dm_members SET user_id = ? WHERE user_id = ?`).run(targetId, stubId);
        // dm_messages / messages (RESTRICT FK, no unique on user_id → straight repoint).
        rawDb.prepare(`UPDATE dm_messages SET user_id = ? WHERE user_id = ?`).run(targetId, stubId);
        rawDb.prepare(`UPDATE messages SET user_id = ? WHERE user_id = ?`).run(targetId, stubId);
        // attachments.uploader_id (plain text column, NO FK, no unique → straight
        // repoint). A replicated stub that uploaded a DM/channel attachment would
        // otherwise leave uploader_id dangling at the deleted stub's id — broken
        // attribution.
        rawDb.prepare(`UPDATE attachments SET uploader_id = ? WHERE uploader_id = ?`).run(targetId, stubId);
        // dm_reactions (dedupe on dm_message_id+emoji per user).
        rawDb.prepare(`DELETE FROM dm_reactions WHERE user_id = ? AND EXISTS (SELECT 1 FROM dm_reactions r2 WHERE r2.user_id = ? AND r2.dm_message_id = dm_reactions.dm_message_id AND r2.emoji = dm_reactions.emoji)`).run(stubId, targetId);
        rawDb.prepare(`UPDATE dm_reactions SET user_id = ? WHERE user_id = ?`).run(targetId, stubId);
        // reactions (dedupe on message_id+emoji per user).
        rawDb.prepare(`DELETE FROM reactions WHERE user_id = ? AND EXISTS (SELECT 1 FROM reactions r2 WHERE r2.user_id = ? AND r2.message_id = reactions.message_id AND r2.emoji = reactions.emoji)`).run(stubId, targetId);
        rawDb.prepare(`UPDATE reactions SET user_id = ? WHERE user_id = ?`).run(targetId, stubId);
        // friends (composite PK user_id+friend_id → dedupe both directions, then
        // repoint, then drop any self-friendship the repoint created).
        rawDb.prepare(`DELETE FROM friends WHERE user_id = ? AND friend_id IN (SELECT friend_id FROM friends WHERE user_id = ?)`).run(stubId, targetId);
        rawDb.prepare(`DELETE FROM friends WHERE friend_id = ? AND user_id IN (SELECT user_id FROM friends WHERE friend_id = ?)`).run(stubId, targetId);
        rawDb.prepare(`UPDATE friends SET user_id = ? WHERE user_id = ?`).run(targetId, stubId);
        rawDb.prepare(`UPDATE friends SET friend_id = ? WHERE friend_id = ?`).run(targetId, stubId);
        rawDb.prepare(`DELETE FROM friends WHERE user_id = friend_id`).run();
        // friend_requests (unique on neither col alone; repoint both, drop self-rows).
        rawDb.prepare(`UPDATE friend_requests SET from_id = ? WHERE from_id = ?`).run(targetId, stubId);
        rawDb.prepare(`UPDATE friend_requests SET to_id = ? WHERE to_id = ?`).run(targetId, stubId);
        rawDb.prepare(`DELETE FROM friend_requests WHERE from_id = to_id`).run();
        // read_states (composite PK user_id+channel_id → dedupe).
        rawDb.prepare(`DELETE FROM read_states WHERE user_id = ? AND channel_id IN (SELECT channel_id FROM read_states WHERE user_id = ?)`).run(stubId, targetId);
        rawDb.prepare(`UPDATE read_states SET user_id = ? WHERE user_id = ?`).run(targetId, stubId);
        // dm_channels.owner_id (plain text column, NO FK → straight repoint).
        rawDb.prepare(`UPDATE dm_channels SET owner_id = ? WHERE owner_id = ?`).run(targetId, stubId);
        rawDb.prepare(`DELETE FROM users WHERE id = ?`).run(stubId);
      }

      // Group-DM ownership continuity: channels the OLD identity owned keep
      // authority under the NEW identity (owner_home_user_id is the S2S
      // authority key, not a users.id FK).
      const normOwnerHome = `lower(replace(replace(coalesce(owner_home_instance, ''), 'https://', ''), 'http://', ''))`;
      rawDb.prepare(`UPDATE dm_channels SET owner_home_user_id = ? WHERE owner_home_user_id = ? AND ${normOwnerHome} = ?`)
        .run(verified.homeUserId, detached.homeUserId, homeDomain);

      // Re-bind. profile_updated_at is nulled so the home's next profile_update
      // (any version) tier-1 matches and applies (the accept-and-skip guards
      // only fire on federation_home_orphaned = 1).
      rawDb.prepare(`UPDATE users SET home_user_id = ?, federation_home_orphaned = 0, username = ?, profile_updated_at = NULL WHERE id = ?`)
        .run(verified.homeUserId, newUsername, detached.id);

      // Reconcile the account's 1-on-1 DM channels: the home_user_id just
      // changed, so every 1-on-1 federatedId derived from it is now stale.
      // Re-key or merge each into its new-identity channel so history stays a
      // single conversation (reattach-dm-reconcile spec §3.2). Group DMs (UUID
      // federatedId / != 2 members) are skipped by the helper.
      const oneOnOne = rawDb.prepare(`
        SELECT c.id FROM dm_channels c
        WHERE c.deleted_at IS NULL
          AND c.federated_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM dm_members m WHERE m.dm_channel_id = c.id AND m.user_id = ?)
          AND (SELECT count(*) FROM dm_members m2 WHERE m2.dm_channel_id = c.id) = 2
      `).all(detached.id) as Array<{ id: string }>;
      for (const c of oneOnOne) {
        // A merge earlier in this loop may have deleted this id — reconcile
        // returns noop for a missing/mutated channel, so the loop is convergent.
        const result = reconcileDmChannelFederatedId(rawDb, c.id);
        if (result.action !== 'noop') dmReconcileResults.push(result);
      }
    })();

    // Best-effort initial profile pull (spec §3.2 step 4). Failure is fine — the
    // account is re-attached; the next relay fills the profile.
    const home = await fetchHomeProfileByHomeId(peerRow, verified.homeUserId);
    if (home) {
      let avatar: string | null = null;
      let banner: string | null = null;
      if (home.profile.avatar) {
        const url = home.profile.avatar.startsWith('http') ? home.profile.avatar : `${peerRow.origin}/api/uploads/${home.profile.avatar}`;
        avatar = (await downloadProfileAsset(url, peerRow.origin)) ?? url;
      }
      if (home.profile.banner) {
        const url = home.profile.banner.startsWith('http') ? home.profile.banner : `${peerRow.origin}/api/uploads/${home.profile.banner}`;
        banner = (await downloadProfileAsset(url, peerRow.origin)) ?? url;
      }
      db.update(schema.users).set({
        displayName: home.profile.displayName ?? home.username,
        avatar,
        banner,
        avatarColor: home.profile.avatarColor ?? detached.avatarColor,
        bio: home.profile.bio,
      }).where(eq(schema.users.id, detached.id)).run();
    }

    const updated = db.select().from(schema.users).where(eq(schema.users.id, detached.id)).get()!;
    console.log(`[federation] Re-attached account ${updated.id} (${updated.username}): ${detached.homeUserId} → ${verified.homeUserId} @ ${homeDomain}`);

    // Broadcast to friends / DM / space co-members + all self connections.
    const targetIds = collectProfileBroadcastTargetIds(updated.id);
    targetIds.add(updated.id);
    for (const uid of targetIds) {
      connectionManager.sendToUser(uid, { type: 'user_updated' as const, user: sanitizeUser(updated, uid === updated.id) });
    }

    // Push DM-list refresh for reconciled channels to affected local members so
    // the merged/re-keyed conversation replaces the split without a reload
    // (reattach-dm-reconcile spec §3.4). Reuses existing events, no new type:
    //  - merged: dm_channel_closed removes the stale source entry; dm_channel_created
    //    (full DmChannel payload — the client handler reads dmChannel.members) resurfaces
    //    the surviving target with its merged history.
    //  - rekeyed: dm_channel_created upserts the channel by id (spaceStore.addDmChannel
    //    replaces by id), refreshing the now-stale federatedId in place. dm_channel_updated
    //    would only patch name/icon, not federatedId, so it cannot heal the client here.
    for (const r of dmReconcileResults) {
      const targetPayload = buildDmChannelPayload(r.targetChannelId, db);
      for (const uid of r.affectedUserIds) {
        if (r.action === 'merged') {
          connectionManager.sendToUser(uid, { type: 'dm_channel_closed' as const, dmChannelId: r.channelId });
        }
        if (targetPayload) {
          connectionManager.sendToUser(uid, { type: 'dm_channel_created' as const, dmChannel: targetPayload });
        }
      }
    }

    return reply.code(200).send({ success: true, user: sanitizeUser(updated, true) });
  });

}
