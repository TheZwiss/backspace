import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { generateSnowflake } from './snowflake.js';
import crypto from 'node:crypto';
import type { FederationRelayEvent, FederationRelayParticipant, FederationRelayAttachment, DmMessageWithUser } from '@backspace/shared';
import { config } from '../config.js';

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
  dmMessageId: string,
  dmChannelId: string,
  mutationType: string,
  payload?: string,
): void {
  try {
    if (!isFederationRelayEnabled()) {
      return;
    }

    const db = getDb();
    db.insert(schema.federationMutationLog)
      .values({
        id: generateSnowflake(),
        dmMessageId,
        dmChannelId,
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
  messageId: string,
  dmChannelId: string,
  eventType: string,
  payload: string,
): void {
  try {
    if (!isFederationRelayEnabled()) {
      return;
    }

    const db = getDb();

    const activePeers = db
      .select()
      .from(schema.federationPeers)
      .where(eq(schema.federationPeers.status, 'active'))
      .all();

    if (activePeers.length === 0) {
      return;
    }

    const ttlDays = getRelayTtlDays();
    const now = Date.now();
    const expiresAt = now + (ttlDays * 86_400_000);

    for (const peer of activePeers) {
      db.transaction((tx) => {
        const existing = tx
          .select()
          .from(schema.federationOutbox)
          .where(
            and(
              eq(schema.federationOutbox.peerId, peer.id),
              eq(schema.federationOutbox.messageId, messageId),
            ),
          )
          .get();

        if (eventType === 'delete' && existing?.eventType === 'create') {
          // Message created and deleted before relay — net effect is nothing
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
              dmChannelId,
              messageId,
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
 * Compute a deterministic canonical DM pair ID from two home user IDs.
 * The pair is sorted lexicographically before hashing to ensure the same
 * result regardless of argument order. Returns first 32 hex chars of SHA-256.
 */
export function canonicalDmPairId(homeUserIdA: string, homeUserIdB: string): string {
  const sorted = [homeUserIdA, homeUserIdB].sort();
  return crypto.createHash('sha256').update(sorted.join(':')).digest('hex').slice(0, 32);
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
    })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  const domainOrigin = config.domain ? `https://${config.domain}` : '';

  return members.map(m => ({
    homeUserId: m.homeUserId || m.id,
    homeInstance: m.homeInstance || domainOrigin,
  }));
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
  const domainOrigin = config.domain ? `https://${config.domain}` : `http://localhost:${config.port}`;

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

  appendMutationLog(message.id, dmChannelId, eventType);
  queueOutboxEvent(message.id, dmChannelId, eventType, JSON.stringify({
    message: {
      ...buildRelayPayload(message, message.user),
      attachments: attachments.length > 0 ? attachments : undefined,
    },
    participants,
  }));
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
    homeInstance: user.homeInstance || config.domain || '',
    content: message.content,
    replyToId: message.replyToId ?? null,
    editedAt: message.editedAt ?? null,
    createdAt: message.createdAt,
  };
}
