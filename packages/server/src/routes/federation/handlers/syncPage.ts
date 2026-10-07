import { and, eq } from 'drizzle-orm';
import type { FederationMessageTarget, FederationRelayAttachment, FederationRelayEvent, FederationSyncResponse } from '@backspace/shared';
import { getDb, getRawDb, schema } from '../../../db/index.js';
import { getOurOrigin, normalizeOriginForCompare } from '../../../utils/federationAuth.js';
import { buildRelayPayload, dmMessageFederationRef, dmMessageMutationTarget, dmReplyRefForRelay, getDmParticipants } from '../../../utils/federationOutbox.js';

/**
 * Reading and serializing this instance's mutation log for a peer's
 * `POST /api/federation/sync` (handlers/relay.ts): `buildSyncResponse`. See
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
}

/** One context of the log as one requester may read it; built once per request. */
interface SyncLogReader {
  read(after: SyncPosition, limit: number): SyncPage;
  /** DM channel id → federatedId, for channels shared with the requester. */
  channelFederatedIds: ReadonlyMap<string, string>;
}

export interface SyncRequestScope {
  contextType: 'dm' | 'friend' | 'profile';
  dmChannelId: string | null;
  federatedId: string | null;
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

/**
 * Log rows matching `where`, strictly after `after`, oldest first, at most
 * `limit`. `join` may add tables the condition reads (aliased away from `ml`).
 */
function readLogPage(
  where: string,
  params: ReadonlyArray<string | number>,
  after: SyncPosition,
  limit: number,
  join = '',
): MutationLogRow[] {
  const keyset = after.id === null
    ? { sql: 'ml.mutated_at > ?', params: [after.ts] }
    : { sql: '(ml.mutated_at > ? OR (ml.mutated_at = ? AND ml.id > ?))', params: [after.ts, after.ts, after.id] };
  return getRawDb().prepare(`
    SELECT ${LOG_COLUMNS}
    FROM federation_mutation_log ml
    ${join}
    WHERE ${where} AND ${keyset.sql}
    ORDER BY ml.mutated_at ASC, ml.id ASC
    LIMIT ?
  `).all(...params, ...keyset.params, limit) as MutationLogRow[];
}

const EMPTY_READER: SyncLogReader = {
  read: () => ({ read: [], served: [] }),
  channelFederatedIds: new Map(),
};

/**
 * DM channels shared with the requester: those with at least one live member
 * homed at the requester's host. A reset peer's former users are detached
 * (`federation_home_orphaned`) or tombstoned here; their channels are this
 * instance's history, not the new incarnation's. Channels not involving the
 * requester are none of its business (third-instance over-broadcast).
 */
function sharedDmChannels(peerHost: string | null): Map<string, string> {
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

/** The home user ids of the requester's users known here, live and not detached. */
function requesterHomeUserIds(peerHost: string | null): string[] {
  if (peerHost === null) return [];
  const rows = getRawDb().prepare(`
    SELECT home_user_id, home_instance FROM users
    WHERE home_user_id IS NOT NULL AND home_instance IS NOT NULL
      AND is_deleted = 0 AND federation_home_orphaned = 0
  `).all() as Array<{ home_user_id: string; home_instance: string }>;
  return [...new Set(rows.filter(row => identityHost(row.home_instance) === peerHost).map(row => row.home_user_id))];
}

/** A `CASE` that reads `path` from the row's payload, or NULL when the payload is not JSON. */
function payloadField(path: string): string {
  return `(CASE WHEN json_valid(ml.payload) THEN json_extract(ml.payload, '${path}') END)`;
}

/**
 * DM rows the requester may see:
 * - every row of a conversation shared with it (`sharedDmChannels`);
 * - in any other federated conversation here, the `member_add` and
 *   `member_remove` rows about one of its own users, so the kick of its last
 *   member there still reaches it. Nothing else of such a conversation.
 *
 * Rows that would serialize to nothing are left out in SQL, so a page is not
 * filled with them: a `create`, `update` or reaction of a message deleted
 * since (its `delete` row follows), and a reaction row the reaction's current
 * state contradicts, so a replay converges on the state now instead of
 * passing through every add and remove.
 */
function dmReader(peerOrigin: string, scope: SyncRequestScope): SyncLogReader {
  const peerHost = identityHost(peerOrigin);
  const shared = sharedDmChannels(peerHost);
  const ownHomeUserIds = requesterHomeUserIds(peerHost);

  let channelFilter = scope.dmChannelId;
  if (!channelFilter && scope.federatedId) {
    const channel = getRawDb().prepare(
      'SELECT id FROM dm_channels WHERE federated_id = ? AND deleted_at IS NULL',
    ).get(scope.federatedId) as { id: string } | undefined;
    if (!channel) return { ...EMPTY_READER, channelFederatedIds: shared };
    channelFilter = channel.id;
  }
  if (shared.size === 0 && ownHomeUserIds.length === 0) return { ...EMPTY_READER, channelFederatedIds: shared };

  const memberUser = payloadField('$.membership.user.homeUserId');
  const where = `
    ml.context_type = 'dm'
    ${channelFilter ? 'AND ml.context_id = ?' : ''}
    AND (
      ml.context_id IN (SELECT value FROM json_each(?))
      OR (
        ml.mutation_type IN ('member_add', 'member_remove')
        AND ${memberUser} IN (SELECT value FROM json_each(?))
        AND EXISTS (
          SELECT 1 FROM dm_channels c
          WHERE c.id = ml.context_id AND c.federated_id IS NOT NULL AND c.deleted_at IS NULL
        )
      )
    )
    AND (ml.mutation_type NOT IN ('create', 'update', 'reaction_add', 'reaction_remove') OR dm.id IS NOT NULL)
    AND (
      ml.mutation_type NOT IN ('reaction_add', 'reaction_remove')
      OR CASE WHEN json_valid(ml.payload) THEN
        EXISTS (
          SELECT 1 FROM dm_reactions r
          WHERE r.dm_message_id = ml.entity_id
            AND r.user_id = json_extract(ml.payload, '$.userId')
            AND r.emoji = json_extract(ml.payload, '$.emoji')
        ) = (ml.mutation_type = 'reaction_add')
      ELSE 0 END
    )
  `;
  const params = [
    ...(channelFilter ? [channelFilter] : []),
    JSON.stringify([...shared.keys()]),
    JSON.stringify(ownHomeUserIds),
  ];
  const isOwnMemberRow = (row: MutationLogRow): boolean => {
    if (row.mutation_type !== 'member_add' && row.mutation_type !== 'member_remove') return false;
    const user = parsePayload<{ membership?: { user?: { homeInstance?: string } } }>(row.payload)?.membership?.user;
    return peerHost !== null && identityHost(user?.homeInstance) === peerHost;
  };
  return {
    channelFederatedIds: shared,
    read(after, limit) {
      const read = readLogPage(where, params, after, limit, 'LEFT JOIN dm_messages dm ON dm.id = ml.entity_id');
      return { read, served: read.filter(row => shared.has(row.context_id) || isOwnMemberRow(row)) };
    },
  };
}

/**
 * Friend events the requester may see: at least one side is homed at the
 * requester's host and, when that side has a row here, the row is live and
 * not detached (a detached or tombstoned row belongs to a dead incarnation of
 * the requester).
 */
function friendReader(peerOrigin: string): SyncLogReader {
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
  const qualifies = (row: MutationLogRow): boolean => {
    const friendship = parsePayload<{
      friendship?: { from?: { homeUserId?: string; homeInstance?: string }; to?: { homeUserId?: string; homeInstance?: string } };
    }>(row.payload)?.friendship;
    return friendship !== undefined && (sideQualifies(friendship.from) || sideQualifies(friendship.to));
  };
  return {
    channelFederatedIds: new Map(),
    read(after, limit) {
      const read = readLogPage("ml.context_type = 'friend'", [], after, limit);
      return { read, served: read.filter(qualifies) };
    },
  };
}

function profileReader(): SyncLogReader {
  return {
    channelFederatedIds: new Map(),
    read(after, limit) {
      const read = readLogPage("ml.context_type = 'profile'", [], after, limit);
      return { read, served: read };
    },
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * The `/sync` answer for one request: the events after `after` the requester
 * may see, at most `limit` rows read per page.
 *
 * A page never comes back empty while the log holds a row the requester may
 * see after it: when a full page serves nothing, the next page is read in
 * the same request, until one serves an event or the log ends. A requester
 * that stops on an empty page (every version before #255 does, and then
 * records the pull as complete) would otherwise end its catch-up for good at
 * a run of rows it may not see. `checkpoint` / `checkpointId` are the last
 * row read, and `hasMore` is whether the last page read was full.
 */
export async function buildSyncResponse(
  peerOrigin: string,
  scope: SyncRequestScope,
  after: SyncPosition,
  limit: number,
): Promise<FederationSyncResponse> {
  const reader = scope.contextType === 'friend'
    ? friendReader(peerOrigin)
    : scope.contextType === 'profile'
      ? profileReader()
      : dmReader(peerOrigin, scope);

  const events: FederationRelayEvent[] = [];
  let position = after;
  let last: MutationLogRow | undefined;
  for (;;) {
    const page = reader.read(position, limit);
    for (const row of page.served) {
      const event = serializeSyncRow(row, peerOrigin, reader.channelFederatedIds);
      if (event) events.push(event);
    }
    const pageLast = page.read[page.read.length - 1];
    if (pageLast) {
      last = pageLast;
      position = { ts: pageLast.mutated_at, id: pageLast.id };
    }
    const full = page.read.length >= limit;
    if (events.length > 0 || !full) {
      return {
        events,
        hasMore: full,
        checkpoint: last ? last.mutated_at : after.ts,
        ...(last ? { checkpointId: last.id } : {}),
      };
    }
    await yieldToEventLoop();
  }
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
 * null when it is not served: its subject is gone, or it is not the
 * requester's.
 */
function serializeSyncRow(
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
