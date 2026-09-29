import { and, eq } from 'drizzle-orm';
import type { FederationMessageTarget, FederationRelayAttachment, FederationRelayEvent } from '@backspace/shared';
import { getDb, getRawDb, schema } from '../../../db/index.js';
import { getOurOrigin, normalizeOriginForCompare } from '../../../utils/federationAuth.js';
import { buildRelayPayload, dmMessageFederationRef, dmMessageMutationTarget, dmReplyRefForRelay, getDmParticipants } from '../../../utils/federationOutbox.js';

/**
 * Reading and serializing one page of this instance's mutation log for a
 * peer's `POST /api/federation/sync` (handlers/relay.ts). See
 * docs/systems/federation.md, "Sync Endpoint".
 *
 * The log only holds mutations made on this instance (a receiver never
 * appends to it), so everything served is this instance's own word: its
 * messages, including those its users wrote as federated accounts of another
 * instance, and its own reactions, closes and edits to relayed copies.
 */

/** A point in the log, in `(mutated_at, id)` order; a null id is before every row of that millisecond. */
export interface SyncPosition {
  ts: number;
  id: string | null;
}

export interface MutationLogRow {
  id: string;
  entity_id: string;
  context_id: string;
  context_type: string;
  mutation_type: string;
  mutated_at: number;
  payload: string | null;
}

export interface SyncPage {
  /** Every row the page read, in log order: what pagination follows. */
  read: MutationLogRow[];
  /** The rows the requester may see, in log order. */
  served: MutationLogRow[];
  /** DM channel id → federatedId, for channels shared with the requester. */
  channelFederatedIds: Map<string, string>;
}

const LOG_COLUMNS = 'ml.id, ml.entity_id, ml.context_id, ml.context_type, ml.mutation_type, ml.mutated_at, ml.payload';

/**
 * The host an identity or origin names, lowercased, without scheme or port:
 * the same comparison attribution makes (`extractDomain`), which is what a
 * federated identity is. A bare `host:port` is parsed as a host too.
 */
export function identityHost(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Log rows matching `where`, strictly after `after`, oldest first, at most `limit`. */
export function readLogPage(
  where: string,
  params: ReadonlyArray<string | number>,
  after: SyncPosition,
  limit: number,
): MutationLogRow[] {
  const keyset = after.id === null
    ? { sql: 'ml.mutated_at > ?', params: [after.ts] }
    : { sql: '(ml.mutated_at > ? OR (ml.mutated_at = ? AND ml.id > ?))', params: [after.ts, after.ts, after.id] };
  return getRawDb().prepare(`
    SELECT ${LOG_COLUMNS}
    FROM federation_mutation_log ml
    WHERE ${where} AND ${keyset.sql}
    ORDER BY ml.mutated_at ASC, ml.id ASC
    LIMIT ?
  `).all(...params, ...keyset.params, limit) as MutationLogRow[];
}

/**
 * DM channels shared with the requester: those with at least one live member
 * homed at the requester's host. A reset peer's former users are detached
 * (`federation_home_orphaned`) or tombstoned here; their channels are this
 * instance's history, not the new incarnation's. Channels not involving the
 * requester are none of its business (third-instance over-broadcast).
 */
function sharedDmChannels(peerOrigin: string): Map<string, string> {
  const peerHost = identityHost(peerOrigin);
  const rows = getRawDb().prepare(`
    SELECT c.id AS channel_id, c.federated_id, u.home_instance
    FROM dm_channels c
    JOIN dm_members m ON m.dm_channel_id = c.id
    JOIN users u ON u.id = m.user_id
    WHERE c.federated_id IS NOT NULL AND c.deleted_at IS NULL
      AND u.is_deleted = 0
      AND u.federation_home_orphaned = 0
      AND u.home_instance IS NOT NULL
  `).all() as Array<{ channel_id: string; federated_id: string; home_instance: string }>;
  const shared = new Map<string, string>();
  for (const row of rows) {
    if (peerHost !== null && identityHost(row.home_instance) === peerHost) shared.set(row.channel_id, row.federated_id);
  }
  return shared;
}

export function readDmSyncPage(
  peerOrigin: string,
  after: SyncPosition,
  limit: number,
  dmChannelIdFilter: string | null,
  federatedIdFilter: string | null,
): SyncPage {
  const shared = sharedDmChannels(peerOrigin);
  let channelIds = [...shared.keys()];

  let filter = dmChannelIdFilter;
  if (!filter && federatedIdFilter) {
    for (const [channelId, federatedId] of shared) {
      if (federatedId === federatedIdFilter) filter = channelId;
    }
    if (!filter) channelIds = [];
  }
  if (filter) channelIds = channelIds.includes(filter) ? [filter] : [];

  if (channelIds.length === 0) return { read: [], served: [], channelFederatedIds: shared };
  const placeholders = channelIds.map(() => '?').join(',');
  const read = readLogPage(`ml.context_type = 'dm' AND ml.context_id IN (${placeholders})`, channelIds, after, limit);
  return { read, served: read, channelFederatedIds: shared };
}

/**
 * Friend events the requester may see: at least one side is homed at the
 * requester's host and, when that side has a row here, the row is live and
 * not detached (a detached or tombstoned row belongs to a dead incarnation of
 * the requester).
 */
export function readFriendSyncPage(peerOrigin: string, after: SyncPosition, limit: number): SyncPage {
  const read = readLogPage("ml.context_type = 'friend'", [], after, limit);
  const peerHost = identityHost(peerOrigin);
  const rowsByHomeUserId = getRawDb().prepare(`
    SELECT home_instance, is_deleted, federation_home_orphaned FROM users WHERE home_user_id = ?
  `);
  const sideQualifies = (side: { homeUserId?: string; homeInstance?: string } | undefined): boolean => {
    if (!side?.homeUserId || !side.homeInstance || peerHost === null) return false;
    if (identityHost(side.homeInstance) !== peerHost) return false;
    const local = (rowsByHomeUserId.all(side.homeUserId) as Array<{ home_instance: string | null; is_deleted: number; federation_home_orphaned: number }>)
      .find(row => identityHost(row.home_instance) === peerHost);
    return !local || (local.is_deleted === 0 && local.federation_home_orphaned === 0);
  };
  const served = read.filter((row) => {
    if (!row.payload) return false;
    try {
      const { friendship } = JSON.parse(row.payload) as {
        friendship?: { from?: { homeUserId?: string; homeInstance?: string }; to?: { homeUserId?: string; homeInstance?: string } };
      };
      return friendship !== undefined && (sideQualifies(friendship.from) || sideQualifies(friendship.to));
    } catch {
      return false;
    }
  });
  return { read, served, channelFederatedIds: new Map() };
}

export function readProfileSyncPage(after: SyncPosition, limit: number): SyncPage {
  const read = readLogPage("ml.context_type = 'profile'", [], after, limit);
  return { read, served: read, channelFederatedIds: new Map() };
}

function parsePayload<T>(payload: string | null): T | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

const EVENT_PAYLOAD_TYPES = new Set([
  'member_add', 'member_remove', 'ownership_transfer',
  'friend_request_create', 'friend_request_update', 'friend_request_cancel',
  'friend_add', 'friend_remove',
]);

/**
 * The relay event a log row stands for, as the live relay would send it, or
 * null when it is not served: its subject is gone (a message deleted since), a
 * reaction's current state contradicts it, or it is not the requester's.
 */
export function serializeSyncRow(
  row: MutationLogRow,
  peerOrigin: string,
  channelFederatedIds: ReadonlyMap<string, string>,
): FederationRelayEvent | null {
  const db = getDb();
  const type = row.mutation_type as FederationRelayEvent['eventType'];
  const base = {
    messageId: row.entity_id,
    encryptionVersion: 0 as const,
    timestamp: row.mutated_at,
  };

  if (EVENT_PAYLOAD_TYPES.has(type)) {
    // Membership and friend mutations store the full event in the payload.
    const payload = parsePayload<Partial<FederationRelayEvent>>(row.payload) ?? {};
    return {
      eventType: type,
      contextType: (row.context_type ?? 'dm') as 'dm' | 'friend' | 'profile',
      ...(row.context_type === 'dm' || !row.context_type ? { dmChannelId: row.context_id } : {}),
      ...base,
      ...payload,
    } as FederationRelayEvent;
  }

  switch (type) {
    case 'delete': {
      // The row is gone; the delete path logged the target it had.
      const target = parsePayload<{ target?: FederationMessageTarget }>(row.payload)?.target;
      return { eventType: 'delete', dmChannelId: row.context_id, ...base, ...(target ? { target } : {}) };
    }

    case 'reaction_add':
    case 'reaction_remove': {
      const reaction = parsePayload<{ userId: string; homeUserId: string; homeInstance?: string; emoji: string; createdAt?: number }>(row.payload);
      if (!reaction) return null;
      // Name the message in shared coordinates, as the live relay does:
      // `entity_id` is this instance's local id, which the peer does not hold
      // when this row is a relayed copy.
      const message = db
        .select({ id: schema.dmMessages.id, sourceInstance: schema.dmMessages.sourceInstance, sourceMessageId: schema.dmMessages.sourceMessageId })
        .from(schema.dmMessages)
        .where(eq(schema.dmMessages.id, row.entity_id))
        .get();
      if (!message) return null;
      // Served only when the reaction's current state agrees with the row,
      // so a replay converges on the state now instead of passing through
      // every add and remove.
      const present = db
        .select({ id: schema.dmReactions.id })
        .from(schema.dmReactions)
        .where(and(
          eq(schema.dmReactions.dmMessageId, message.id),
          eq(schema.dmReactions.userId, reaction.userId),
          eq(schema.dmReactions.emoji, reaction.emoji),
        ))
        .get() !== undefined;
      if (present !== (type === 'reaction_add')) return null;
      const target = dmMessageFederationRef(message);
      return {
        eventType: type,
        dmChannelId: row.context_id,
        ...base,
        reaction: {
          messageId: target.messageId,
          messageHomeInstance: target.messageHomeInstance,
          userId: reaction.userId,
          homeUserId: reaction.homeUserId,
          homeInstance: reaction.homeInstance || getOurOrigin(),
          emoji: reaction.emoji,
          createdAt: reaction.createdAt ?? row.mutated_at,
        },
      };
    }

    case 'dm_close':
    case 'dm_reopen': {
      const dmCloseReopen = parsePayload<{ homeUserId: string; homeInstance: string }>(row.payload);
      const federatedId = channelFederatedIds.get(row.context_id);
      if (!dmCloseReopen || !federatedId) return null;
      return { eventType: type, dmChannelId: row.context_id, federatedId, ...base, dmCloseReopen };
    }

    case 'read_state_update': {
      const readState = parsePayload<NonNullable<FederationRelayEvent['readState']>>(row.payload);
      const federatedId = channelFederatedIds.get(row.context_id);
      if (!readState || !federatedId) return null;
      return { eventType: 'read_state_update', dmChannelId: row.context_id, federatedId, ...base, readState };
    }

    case 'group_metadata_update': {
      const metadata = parsePayload<NonNullable<FederationRelayEvent['metadata']>>(row.payload);
      const federatedId = channelFederatedIds.get(row.context_id);
      if (!metadata || !federatedId) return null;
      return { eventType: 'group_metadata_update', dmChannelId: row.context_id, federatedId, ...base, metadata };
    }

    case 'file_rejected': {
      const rejection = parsePayload<{
        attachmentId: string;
        sourceFilename: string;
        rejectionReason: string;
        rejectionLimit: number;
        affectedUserIds: string[];
        affectedUsers?: Array<{ homeUserId: string; homeInstance: string }>;
      }>(row.payload);
      if (!rejection) return null;
      // A reverse relay: it names the message by the id it has on the
      // instance it came from, and only that instance may hear of it.
      const copy = db
        .select({ sourceInstance: schema.dmMessages.sourceInstance })
        .from(schema.dmMessages)
        .where(and(eq(schema.dmMessages.sourceMessageId, row.entity_id), eq(schema.dmMessages.dmChannelId, row.context_id)))
        .get();
      if (!copy?.sourceInstance || normalizeOriginForCompare(copy.sourceInstance) !== normalizeOriginForCompare(peerOrigin)) return null;
      return {
        eventType: 'file_rejected',
        dmChannelId: row.context_id,
        ...base,
        attachmentId: rejection.attachmentId,
        sourceFilename: rejection.sourceFilename,
        rejectionReason: rejection.rejectionReason,
        rejectionLimit: rejection.rejectionLimit,
        affectedUserIds: rejection.affectedUserIds,
        ...(rejection.affectedUsers ? { affectedUsers: rejection.affectedUsers } : {}),
      };
    }

    case 'profile_update': {
      const profileUpdate = parsePayload<{ profileUpdate?: NonNullable<FederationRelayEvent['profileUpdate']> }>(row.payload)?.profileUpdate;
      if (!profileUpdate) return null;
      return { eventType: 'profile_update', contextType: 'profile', ...base, profileUpdate };
    }

    case 'create':
    case 'update':
      return serializeMessageRow(row, type);

    default:
      return null;
  }
}

/** A create or update, with the message as it is now; null once it is deleted (the delete row follows). */
function serializeMessageRow(row: MutationLogRow, type: 'create' | 'update'): FederationRelayEvent | null {
  const db = getDb();
  const message = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, row.entity_id)).get();
  if (!message) return null;
  const author = db.select().from(schema.users).where(eq(schema.users.id, message.userId)).get();
  if (!author) return null;

  const localOrigin = getOurOrigin();
  const attachments: FederationRelayAttachment[] = db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.dmMessageId, message.id))
    .all()
    .map(a => ({
      id: a.id,
      filename: a.filename,
      originalName: a.originalName,
      mimetype: a.mimetype,
      size: a.size,
      width: a.width ?? undefined,
      height: a.height ?? undefined,
      duration: a.duration ?? undefined,
      playable: a.playable ?? null,
      thumbnailFilename: a.thumbnailFilename ?? undefined,
      sourceUrl: `${localOrigin}/api/uploads/${a.filename}`,
    }));

  // A group carries its federatedId so the peer finds the conversation by it
  // instead of computing a 1-on-1 key.
  const channel = db
    .select({ federatedId: schema.dmChannels.federatedId, ownerId: schema.dmChannels.ownerId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, row.context_id))
    .get();
  const target = type === 'update' ? dmMessageMutationTarget(message, message.userId) : null;

  return {
    eventType: type,
    ...(channel?.federatedId && channel.ownerId ? { federatedId: channel.federatedId } : {}),
    dmChannelId: row.context_id,
    messageId: message.id,
    encryptionVersion: 0,
    timestamp: row.mutated_at,
    participants: getDmParticipants(row.context_id),
    ...(target ? { target } : {}),
    message: {
      ...buildRelayPayload(message, author, dmReplyRefForRelay(row.context_id, message.replyToId)),
      attachments: attachments.length > 0 ? attachments : undefined,
    },
  };
}
