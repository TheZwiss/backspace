import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { generateSnowflake } from './snowflake.js';
import crypto from 'node:crypto';
import type { FederationRelayEvent, FederationRelayParticipant, FederationRelayAttachment, DmMessageWithUser, FederationRelayRequest } from '@backspace/shared';
import { getOurOrigin, buildFederationHeaders, generateHmacSecret } from './federationAuth.js';
import { extractDomain } from '../routes/federation.js';
import { racePeering, ensurePeered } from './federationPeering.js';

// ─── Settings Cache ──────────────────────────────────────────────────────────

interface CachedSettings {
  relayEnabled: boolean;
  relayTtlDays: number;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000; // 30 seconds

let cachedSettings: CachedSettings | null = null;

function fetchSettings(): CachedSettings {
  const now = Date.now();
  if (cachedSettings && (now - cachedSettings.fetchedAt) < CACHE_TTL_MS) {
    return cachedSettings;
  }

  const db = getDb();
  const row = db
    .select({
      relayEnabled: schema.instanceSettings.federationRelayEnabled,
      relayTtlDays: schema.instanceSettings.federationRelayTtlDays,
    })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.id, 1))
    .get();

  cachedSettings = {
    relayEnabled: row?.relayEnabled === 1,
    relayTtlDays: row?.relayTtlDays ?? 30,
    fetchedAt: now,
  };

  return cachedSettings;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns true if the federation relay feature is enabled in instance settings.
 * Result is cached for 30 seconds to avoid repeated DB reads.
 */
export function isFederationRelayEnabled(): boolean {
  try {
    return fetchSettings().relayEnabled;
  } catch (err) {
    console.error('[federation-outbox] Failed to check relay enabled status:', err);
    return false;
  }
}

/**
 * Returns the configured relay TTL in days (default 30).
 * Shares the same 30-second cache as isFederationRelayEnabled().
 */
export function getRelayTtlDays(): number {
  try {
    return fetchSettings().relayTtlDays;
  } catch (err) {
    console.error('[federation-outbox] Failed to read relay TTL days:', err);
    return 30;
  }
}

/**
 * Append an entry to the federation mutation log.
 * No-op if federation relay is disabled.
 * Failures are logged but never propagate — federation must not break DM flow.
 */
export function appendMutationLog(
  entityId: string,
  contextId: string,
  mutationType: string,
  payload?: string,
  contextType: string = 'dm',
): void {
  try {
    if (!isFederationRelayEnabled()) {
      return;
    }

    const db = getDb();
    db.insert(schema.federationMutationLog)
      .values({
        id: generateSnowflake(),
        entityId,
        contextId,
        contextType,
        mutationType,
        mutatedAt: Date.now(),
        payload: payload ?? null,
      })
      .run();
  } catch (err) {
    console.error('[federation-outbox] Failed to append mutation log:', err);
  }
}

/**
 * Queue an outbox event for all active federation peers.
 *
 * Performs per-peer coalescing inside a transaction:
 * - If a 'create' already exists and a 'delete' arrives, the entry is removed
 *   (net effect: message was never relayed).
 * - If an entry already exists, it is updated with the latest payload/event type,
 *   preserving the original 'create' event type if applicable.
 * - Otherwise a new entry is inserted.
 *
 * No-op if federation relay is disabled.
 * Failures are logged but never propagate — federation must not break DM flow.
 */
export function queueOutboxEvent(
  entityId: string,
  contextId: string,
  eventType: string,
  payload: string,
  targetPeerOrigins?: string[],
  contextType: string = 'dm',
): void {
  try {
    if (!isFederationRelayEnabled()) {
      return;
    }

    const db = getDb();

    const peers = db
      .select()
      .from(schema.federationPeers)
      .where(
        inArray(schema.federationPeers.status, ['active', 'pending', 'unreachable']),
      )
      .all();

    if (peers.length === 0 && !targetPeerOrigins) {
      return;
    }

    // If targetPeerOrigins specified, only queue to those peers
    let matchedPeers = targetPeerOrigins
      ? peers.filter(p => targetPeerOrigins.includes(p.origin))
      : peers;

    // For targeted origins with no existing peer record, create pending placeholders.
    // autoAcceptPeering controls INCOMING acceptance, not outgoing initiation —
    // when a local user sends a DM requiring relay, the server creates the placeholder
    // regardless of the setting. The peer/accept gate on the REMOTE side decides
    // whether to accept or queue our request.
    if (targetPeerOrigins) {
      const matchedOrigins = new Set(matchedPeers.map(p => p.origin));

      for (const origin of targetPeerOrigins) {
        if (matchedOrigins.has(origin)) continue;

        const existingPeer = db
          .select({ status: schema.federationPeers.status })
          .from(schema.federationPeers)
          .where(eq(schema.federationPeers.origin, origin))
          .get();

        if (!existingPeer) {
          // No peer row — create pending placeholder, handshake fires on next tick
          const peerId = generateSnowflake();
          const now = Date.now();
          db.insert(schema.federationPeers).values({
            id: peerId,
            origin,
            hmacSecret: generateHmacSecret(),
            status: 'pending',
            createdAt: now,
          }).run();
          const newPeer = db.select().from(schema.federationPeers)
            .where(eq(schema.federationPeers.id, peerId)).get();
          if (newPeer) {
            matchedPeers = [...matchedPeers, newPeer];
            console.log(`[federation] queueOutboxEvent: created pending placeholder for ${origin}`);
          }
          continue;
        }

        // schema.federationPeers.status is plain text — narrow to known union for
        // compile-time exhaustiveness check without widening to `string`.
        const status = existingPeer.status as
          | 'active'
          | 'pending'
          | 'unreachable'
          | 'awaiting_approval'
          | 'needs_attention'
          | 'rejected'
          | 'revoked';

        switch (status) {
          case 'active':
          case 'pending':
          case 'unreachable': {
            // Race: peer transitioned to a deliverable status between the initial
            // peers SELECT and this point in the loop. Re-fetch the full row and
            // add to matchedPeers so the outer enqueue loop includes this peer.
            // Do NOT silently drop — symmetric onPeerActivated on the peer's side
            // is not guaranteed to cover asymmetric-failure cases (lost /peer/accept
            // 200, health-check-only transition on one side).
            const raced = db
              .select()
              .from(schema.federationPeers)
              .where(eq(schema.federationPeers.origin, origin))
              .get();
            if (raced) {
              matchedPeers = [...matchedPeers, raced];
              console.log(`[federation] queueOutboxEvent: race-caught ${origin} (now ${status}); enqueueing`);
            }
            break;
          }
          case 'awaiting_approval':
            console.debug(`[federation] queueOutboxEvent: skipping ${origin} (awaiting_approval); mutation log will replay on activation`);
            break;
          case 'needs_attention':
            console.debug(`[federation] queueOutboxEvent: skipping ${origin} (needs_attention; admin Reset required); mutation log will replay after Reset + re-peer`);
            break;
          case 'rejected':
            console.debug(`[federation] queueOutboxEvent: skipping ${origin} (rejected peering)`);
            break;
          case 'revoked':
            console.debug(`[federation] queueOutboxEvent: skipping ${origin} (revoked by admin)`);
            break;
          default: {
            // Exhaustiveness check — no `as never` cast. TypeScript enforces
            // that every status value is handled; adding a new value to the
            // union without a case here fails typecheck.
            const _exhaustive: never = status;
            console.error(`[federation] queueOutboxEvent: unknown peer status for ${origin}: ${String(_exhaustive)}`);
            break;
          }
        }
      }
    }

    if (matchedPeers.length === 0) {
      return;
    }

    const ttlDays = getRelayTtlDays();
    const now = Date.now();
    const expiresAt = now + (ttlDays * 86_400_000);

    for (const peer of matchedPeers) {
      db.transaction((tx) => {
        const existing = tx
          .select()
          .from(schema.federationOutbox)
          .where(
            and(
              eq(schema.federationOutbox.peerId, peer.id),
              eq(schema.federationOutbox.entityId, entityId),
            ),
          )
          .get();

        if (eventType === 'delete' && existing?.eventType === 'create') {
          // Entity created and deleted before relay — net effect is nothing
          tx.delete(schema.federationOutbox)
            .where(eq(schema.federationOutbox.id, existing.id))
            .run();
        } else if (existing) {
          // Coalesce: update existing entry with latest state.
          // If the original was a 'create', keep it as 'create' so the peer
          // receives the full message on first relay rather than an update/delete
          // for something it never saw.
          tx.update(schema.federationOutbox)
            .set({
              eventType: existing.eventType === 'create' ? 'create' : eventType,
              payload,
              attempts: 0,
              nextRetryAt: now,
            })
            .where(eq(schema.federationOutbox.id, existing.id))
            .run();
        } else {
          // No existing entry — insert new
          tx.insert(schema.federationOutbox)
            .values({
              id: generateSnowflake(),
              peerId: peer.id,
              contextId,
              entityId,
              contextType,
              eventType,
              payload,
              encryptionVersion: 0,
              attempts: 0,
              nextRetryAt: now,
              expiresAt,
              createdAt: now,
            })
            .run();
        }
      });
    }
  } catch (err) {
    console.error('[federation-outbox] Failed to queue outbox event:', err);
  }
}

/**
 * Compute a federated ID for a DM channel.
 *
 * For 1-on-1 DMs: deterministic SHA-256 hash of 2 sorted home user IDs (backward compatible).
 * For group DMs: call with no arguments to generate a new UUID.
 */
export function computeFederatedId(homeUserIdA: string, homeUserIdB: string): string;
export function computeFederatedId(): string;
export function computeFederatedId(homeUserIdA?: string, homeUserIdB?: string): string {
  if (homeUserIdA && homeUserIdB) {
    // 1-on-1: deterministic pair hash (backward compatible with canonicalDmPairId)
    const sorted = [homeUserIdA, homeUserIdB].sort();
    return crypto.createHash('sha256').update(sorted.join(':')).digest('hex').slice(0, 32);
  }
  // Group: origin-assigned UUID
  return crypto.randomUUID();
}

/**
 * Look up all members of a DM channel and return their federated identities.
 * Used to include participants in relay events so the receiving instance can
 * resolve both parties without relying on the friends list.
 */
export function getDmParticipants(dmChannelId: string): FederationRelayParticipant[] {
  const db = getDb();
  const members = db
    .select({
      userId: schema.dmMembers.userId,
      homeUserId: schema.users.homeUserId,
      homeInstance: schema.users.homeInstance,
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      avatar: schema.users.avatar,
      avatarColor: schema.users.avatarColor,
    })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  const domainOrigin = getOurOrigin();

  return members.map(m => ({
    homeUserId: m.homeUserId || m.id,
    homeInstance: m.homeInstance || domainOrigin,
    profile: {
      username: m.username ?? null,
      displayName: m.displayName ?? null,
      avatar: m.avatar ?? null,
      avatarColor: m.avatarColor ?? null,
    },
  }));
}

/**
 * Compute which peer origins need to receive events for a group DM.
 * Returns undefined for 1-on-1 DMs (broadcast to all).
 * Returns a list of origins for group DMs (participant-aware routing).
 */
export function getGroupDmTargetOrigins(dmChannelId: string): string[] | undefined {
  const db = getDb();
  const channel = db
    .select({ ownerId: schema.dmChannels.ownerId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();

  // Always compute target origins from participants — both 1-on-1 and group DMs.
  // Returning undefined (broadcast to all) would skip the pending-placeholder creation
  // in queueOutboxEvent(), preventing relay when no peer exists yet.
  const participants = getDmParticipants(dmChannelId);
  const ourOrigin = getOurOrigin();

  const origins = new Set<string>();
  for (const p of participants) {
    const normalized = p.homeInstance.startsWith('http') ? p.homeInstance : `https://${p.homeInstance}`;
    if (normalized !== ourOrigin) {
      origins.add(normalized);
    }
  }

  // No remote participants — no relay needed
  if (origins.size === 0) return undefined;

  return Array.from(origins);
}

/**
 * Queue a DM message for federation relay to all active peers.
 * Builds the complete relay payload including attachments with sourceUrl
 * and participant identities. Single source of truth for relay payload
 * construction — all create/update relay hooks call this function.
 *
 * Accepts the already-fetched DmMessageWithUser to avoid redundant DB queries
 * and transaction timing issues — the caller has already committed writes and
 * fetched the message for the WebSocket broadcast.
 */
export function queueDmRelay(
  message: DmMessageWithUser,
  dmChannelId: string,
  eventType: 'create' | 'update',
): void {
  const domainOrigin = getOurOrigin();

  const attachments: FederationRelayAttachment[] = (message.attachments ?? []).map(a => ({
    id: a.id,
    filename: a.filename,
    originalName: a.originalName,
    mimetype: a.mimetype,
    size: a.size,
    width: a.width ?? undefined,
    height: a.height ?? undefined,
    duration: a.duration ?? undefined,
    thumbnailFilename: a.thumbnailFilename ?? undefined,
    sourceUrl: `${domainOrigin}/api/uploads/${a.filename}`,
  }));

  const participants = getDmParticipants(dmChannelId);

  const targetOrigins = getGroupDmTargetOrigins(dmChannelId);

  // Fetch channel to check if it's a group DM with a federatedId
  const db = getDb();
  const channel = db
    .select({ federatedId: schema.dmChannels.federatedId, ownerId: schema.dmChannels.ownerId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();

  appendMutationLog(message.id, dmChannelId, eventType);
  queueOutboxEvent(message.id, dmChannelId, eventType, JSON.stringify({
    ...(channel?.federatedId && channel.ownerId ? { federatedId: channel.federatedId } : {}),
    message: {
      ...buildRelayPayload(message, message.user),
      attachments: attachments.length > 0 ? attachments : undefined,
    },
    participants,
  }), targetOrigins);
}

/**
 * Compute a deterministic context ID for friend events between two users.
 * Sorts home user IDs so the context is the same regardless of who initiates.
 */
export function buildFriendContextId(homeUserIdA: string, homeUserIdB: string): string {
  const sorted = [homeUserIdA, homeUserIdB].sort();
  return `friend:${sorted[0]}:${sorted[1]}`;
}

/**
 * Determine which peer instance origins need to receive a friend event.
 * Returns an empty array if both users are local (no relay needed).
 */
export function getFriendEventTargets(
  fromHomeInstance: string | null | undefined,
  toHomeInstance: string | null | undefined,
): string[] {
  const ourOrigin = getOurOrigin();
  const targets = new Set<string>();

  const normalizedFrom = fromHomeInstance?.startsWith('http') ? fromHomeInstance : fromHomeInstance ? `https://${fromHomeInstance}` : null;
  const normalizedTo = toHomeInstance?.startsWith('http') ? toHomeInstance : toHomeInstance ? `https://${toHomeInstance}` : null;

  if (normalizedFrom && normalizedFrom !== ourOrigin) {
    targets.add(normalizedFrom);
  }
  if (normalizedTo && normalizedTo !== ourOrigin) {
    targets.add(normalizedTo);
  }

  return Array.from(targets);
}

/**
 * Build the relay payload object for a DM message.
 * Used internally by queueDmRelay and the sync endpoint.
 */
export function buildRelayPayload(
  message: {
    id: string;
    content: string | null;
    replyToId?: string | null;
    editedAt?: number | null;
    createdAt: number;
  },
  user: {
    id: string;
    homeUserId: string | null;
    homeInstance: string | null;
  },
): NonNullable<FederationRelayEvent['message']> {
  return {
    userId: user.id,
    homeUserId: user.homeUserId || user.id,
    homeInstance: user.homeInstance || getOurOrigin(),
    content: message.content,
    replyToId: message.replyToId ?? null,
    editedAt: message.editedAt ?? null,
    createdAt: message.createdAt,
  };
}

/** 3s budget for the on-demand handshake before a call relay POST. */
export const CALL_PEERING_TIMEOUT_MS = 3_000;

export type CallRelayFailureReason =
  | 'peer_rejected'
  | 'peer_awaiting_approval'
  | 'peer_transient_failure'
  | 'post_failed';

export type CallRelayResult =
  | { ok: true }
  | { ok: false; reason: CallRelayFailureReason; error: string };

/**
 * Send call signaling events directly to a remote peer (bypasses outbox).
 * Latency-sensitive: if no active peer exists, race an ensurePeered handshake
 * against `opts.peeringTimeoutMs` (default CALL_PEERING_TIMEOUT_MS).
 *
 * `peeringTimeoutMs: 0` = non-blocking mode (used by sendTypingRelay):
 *   - If the peer is currently active, POST. Otherwise skip the POST, kick off
 *     ensurePeered() in the background as a warm-up, and return
 *     { ok:false, reason:'peer_transient_failure' }.
 */
export async function sendCallRelay(
  targetPeerOrigin: string,
  events: FederationRelayEvent[],
  opts: { peeringTimeoutMs?: number } = {},
): Promise<CallRelayResult> {
  const timeoutMs = opts.peeringTimeoutMs ?? CALL_PEERING_TIMEOUT_MS;
  const db = getDb();

  // ─── Fast path: peer already active or unreachable (health check handles) ──
  const existing = db.select()
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, targetPeerOrigin))
    .get();

  let peer = existing && (existing.status === 'active' || existing.status === 'unreachable')
    ? existing
    : null;

  if (!peer) {
    // ─── Non-blocking mode (typing): warm up in background, do not POST ──
    if (timeoutMs === 0) {
      ensurePeered(targetPeerOrigin).catch(err => {
        console.warn('[federation] typing-triggered background handshake:', targetPeerOrigin, err);
      });
      return { ok: false, reason: 'peer_transient_failure', error: 'peer not active' };
    }

    // ─── Race ensurePeered against the deadline ──
    const raced = await racePeering(targetPeerOrigin, timeoutMs);

    switch (raced.status) {
      case 'active':
        // Re-fetch the now-active peer row for HMAC secret.
        peer = db.select()
          .from(schema.federationPeers)
          .where(eq(schema.federationPeers.origin, targetPeerOrigin))
          .get() ?? null;
        if (!peer) {
          return { ok: false, reason: 'peer_transient_failure', error: 'peer row missing after handshake' };
        }
        break;
      case 'rejected':
        return { ok: false, reason: 'peer_rejected', error: raced.error };
      case 'pending':
        return { ok: false, reason: 'peer_awaiting_approval', error: raced.error };
      case 'failed':
        return { ok: false, reason: 'peer_transient_failure', error: raced.error };
      case 'timeout':
        return { ok: false, reason: 'peer_transient_failure', error: `Peering handshake did not complete within ${(timeoutMs / 1000).toFixed(1)}s` };
      default: {
        // Exhaustiveness check — catches any future additions to EnsurePeeredResult.
        const _exhaustive: never = raced;
        return { ok: false, reason: 'peer_transient_failure', error: `unexpected peering result: ${JSON.stringify(_exhaustive)}` };
      }
    }
  }

  // ─── POST ──────────────────────────────────────────────────────────────────
  const ourOrigin = getOurOrigin();
  const body: FederationRelayRequest = {
    version: 1,
    sourceInstance: ourOrigin,
    events,
  };
  const bodyStr = JSON.stringify(body);

  const signingSecret = peer.pendingHmacSecret ?? peer.hmacSecret;
  const headers = buildFederationHeaders(bodyStr, signingSecret, ourOrigin);

  try {
    const res = await fetch(`${targetPeerOrigin}/api/federation/relay`, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) return { ok: true };

    const text = await res.text().catch(() => '');
    if (res.status >= 400 && res.status < 500) {
      return {
        ok: false,
        reason: 'post_failed',
        error: `HTTP ${res.status}: ${text}`,
      };
    }
    return {
      ok: false,
      reason: 'peer_transient_failure',
      error: `HTTP ${res.status}: ${text}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'peer_transient_failure',
      error: err instanceof Error ? err.message : 'fetch_failed',
    };
  }
}

/**
 * Queue a read_state_update relay event for cross-instance read state sync.
 * Translates a local channel ack into federation coordinates using the
 * message's sourceInstance/sourceMessageId mapping.
 */
export function queueReadStateRelay(
  channelId: string,
  messageId: string,
  userId: string,
): void {
  if (!isFederationRelayEnabled()) return;

  const db = getDb();
  const ourOrigin = getOurOrigin();

  // Channel must have a federatedId for cross-instance sync
  const channel = db.select({ federatedId: schema.dmChannels.federatedId, ownerId: schema.dmChannels.ownerId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, channelId))
    .get();
  if (!channel?.federatedId) return;

  // Resolve the user's federated identity
  const user = db.select({ homeUserId: schema.users.homeUserId, homeInstance: schema.users.homeInstance })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (!user) return;

  const homeUserId = user.homeUserId || userId;
  const homeInstance = user.homeInstance || ourOrigin;

  // Determine the acked message's federation coordinates
  const msg = db.select({ sourceInstance: schema.dmMessages.sourceInstance, sourceMessageId: schema.dmMessages.sourceMessageId })
    .from(schema.dmMessages)
    .where(eq(schema.dmMessages.id, messageId))
    .get();

  let messageRef: { sourceInstance: string; sourceMessageId: string };
  if (msg?.sourceInstance && msg?.sourceMessageId) {
    // Message was relayed here — use its original coordinates
    messageRef = { sourceInstance: msg.sourceInstance, sourceMessageId: msg.sourceMessageId };
  } else {
    // Message originated on this instance
    messageRef = { sourceInstance: ourOrigin, sourceMessageId: messageId };
  }

  const now = Date.now();
  const payload: FederationRelayEvent = {
    eventType: 'read_state_update',
    dmChannelId: channelId,
    messageId: `read_state:${userId}:${now}`,
    federatedId: channel.federatedId,
    encryptionVersion: 0,
    timestamp: now,
    readState: {
      user: { homeUserId, homeInstance },
      messageRef,
    },
  };

  const targetOrigins = getGroupDmTargetOrigins(channelId);
  queueOutboxEvent(
    `read_state:${channel.federatedId}:${userId}`,
    channelId,
    'read_state_update',
    JSON.stringify(payload),
    targetOrigins,
  );
}

/**
 * Queue a dm_close or dm_reopen event for federation relay.
 * Sends to all peer instances that have a copy of the DM.
 */
export function queueDmCloseRelay(
  dmChannelId: string,
  userId: string,
  eventType: 'dm_close' | 'dm_reopen',
): void {
  if (!isFederationRelayEnabled()) return;

  const db = getDb();
  const ourOrigin = getOurOrigin();

  // Channel must have a federatedId for cross-instance sync
  const channel = db.select({ federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();
  if (!channel?.federatedId) return;

  // Resolve the user's federated identity
  const user = db.select({ homeUserId: schema.users.homeUserId, homeInstance: schema.users.homeInstance })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (!user) return;

  const homeUserId = user.homeUserId || userId;
  const homeInstance = user.homeInstance || ourOrigin;

  const now = Date.now();
  const payload: FederationRelayEvent = {
    eventType,
    dmChannelId,
    messageId: `${eventType}:${channel.federatedId}:${userId}:${now}`,
    federatedId: channel.federatedId,
    encryptionVersion: 0,
    timestamp: now,
    dmCloseReopen: {
      homeUserId,
      homeInstance,
    },
  };

  const targetOrigins = getGroupDmTargetOrigins(dmChannelId);
  queueOutboxEvent(
    `${eventType}:${channel.federatedId}:${userId}`,
    dmChannelId,
    eventType,
    JSON.stringify(payload),
    targetOrigins,
  );
}

/**
 * Send typing indicator events directly to remote peers (bypasses outbox).
 * Fire-and-forget — typing is ephemeral, lost packets are acceptable.
 */
export async function sendTypingRelay(
  dmChannelId: string,
  eventType: 'dm_typing_start' | 'dm_typing_stop',
  userId: string,
): Promise<void> {
  if (!isFederationRelayEnabled()) return;

  const db = getDb();
  const participants = getDmParticipants(dmChannelId);
  const ourOrigin = getOurOrigin();

  // Find the typing user's identity
  const typingUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!typingUser) return;

  // Get the channel's federatedId for cross-instance identification
  const channel = db.select({ federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();
  if (!channel?.federatedId) return;

  // Find unique remote peer origins
  const remoteOrigins = new Set<string>();
  for (const p of participants) {
    const normalized = p.homeInstance.startsWith('http') ? p.homeInstance : `https://${p.homeInstance}`;
    if (normalized !== ourOrigin) {
      remoteOrigins.add(normalized);
    }
  }

  if (remoteOrigins.size === 0) return;

  const event: FederationRelayEvent = {
    eventType,
    contextType: 'dm',
    messageId: `typing:${userId}:${Date.now()}`,
    federatedId: channel.federatedId,
    participants,
    encryptionVersion: 0,
    timestamp: Date.now(),
    typing: {
      homeUserId: typingUser.homeUserId || typingUser.id,
      homeInstance: typingUser.homeInstance || extractDomain(ourOrigin),
      username: typingUser.username ?? '',
    },
  };

  // Fire-and-forget to each remote peer; 0ms peering timeout = non-blocking warm-up.
  for (const peerOrigin of remoteOrigins) {
    sendCallRelay(peerOrigin, [event], { peeringTimeoutMs: 0 })
      .then(result => {
        if (!result.ok) {
          console.debug(`[federation] Typing relay to ${peerOrigin}: ${result.reason} ${result.error}`);
        }
      })
      .catch(err => {
        console.warn(`[federation] Typing relay to ${peerOrigin} threw unexpectedly:`, err);
      });
  }
}
