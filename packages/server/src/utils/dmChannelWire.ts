import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DmChannel, DmLastMessagePreview, DmMessageWithUser } from '@backspace/shared';
import type { getDb } from '../db/index.js';
import { schema } from '../db/index.js';
import { sanitizeUser } from './sanitize.js';
import { batchInArray } from './sqlBatch.js';

type Db = ReturnType<typeof getDb>;
type DmChannelRow = typeof schema.dmChannels.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;
type DmMessageRow = typeof schema.dmMessages.$inferSelect;

/**
 * The one place a `DmChannel` is put on the wire. The ready payload,
 * `GET /api/dm` and `dm_channel_created` all go through it, so a client that
 * learns a conversation from any of them gets the same fields: above all
 * `federatedId`, the key it uses to recognise two instances' copies of one
 * conversation, and the group metadata (`name`, `icon`, owner identity).
 *
 * `members` are user rows in the order the caller wants them listed; they are
 * sanitized here.
 */
export function toDmChannelWire(
  channel: DmChannelRow,
  members: UserRow[],
  lastMessage: DmChannel['lastMessage'],
): DmChannel {
  return {
    id: channel.id,
    federatedId: channel.federatedId ?? null,
    ownerId: channel.ownerId ?? null,
    ownerHomeUserId: channel.ownerHomeUserId ?? null,
    ownerHomeInstance: channel.ownerHomeInstance ?? null,
    createdAt: channel.createdAt,
    name: channel.name ?? null,
    icon: channel.icon ?? null,
    metadataUpdatedAt: channel.metadataUpdatedAt ?? 0,
    members: members.map(u => sanitizeUser(u)),
    lastMessage: lastMessage ?? null,
  };
}

/** The sidebar preview of a DM's newest message. */
export function toDmLastMessagePreview(
  message: DmMessageRow,
  attachments: Array<{ type: string; filename: string }>,
): DmLastMessagePreview {
  return {
    id: message.id,
    dmChannelId: message.dmChannelId,
    userId: message.userId,
    content: message.content,
    createdAt: message.createdAt,
    type: message.type === 'system' ? 'system' : 'user',
    attachments,
  };
}

type DmMemberRow = typeof schema.dmMembers.$inferSelect;

/**
 * The sidebar preview of the newest message of each channel in `channelIds`,
 * keyed by channel. Chunked, so any number of channels stays under SQLite's
 * bound-variable limit. On a tie on `created_at` the first row per channel
 * wins.
 */
function newestMessagePreviews(db: Db, channelIds: string[]): Map<string, DmLastMessagePreview> {
  const previews = new Map<string, DmLastMessagePreview>();
  if (channelIds.length === 0) return previews;

  // One grouped pass per chunk finds each channel's newest timestamp, and the
  // rows at it are joined back. (A correlated MAX per candidate row re-reads
  // the conversation for every message in it: quadratic in its length.)
  const newest = batchInArray(channelIds, ids => {
    const latest = db.select({
      dmChannelId: schema.dmMessages.dmChannelId,
      maxCreatedAt: sql<number>`MAX(${schema.dmMessages.createdAt})`.as('max_created_at'),
    })
      .from(schema.dmMessages)
      .where(inArray(schema.dmMessages.dmChannelId, ids))
      .groupBy(schema.dmMessages.dmChannelId)
      .as('latest');
    return db.select()
      .from(schema.dmMessages)
      .innerJoin(latest, and(
        eq(schema.dmMessages.dmChannelId, latest.dmChannelId),
        eq(schema.dmMessages.createdAt, latest.maxCreatedAt),
      ))
      .all()
      .map(row => row.dm_messages);
  });
  const lastMessageMap = new Map<string, DmMessageRow>();
  for (const m of newest) {
    if (!lastMessageMap.has(m.dmChannelId)) lastMessageMap.set(m.dmChannelId, m);
  }

  const lastMessageIds = [...lastMessageMap.values()].map(m => m.id);
  const attachmentRows = lastMessageIds.length > 0
    ? batchInArray(lastMessageIds, ids =>
        db.select({
          dmMessageId: schema.attachments.dmMessageId,
          type: schema.attachments.mimetype,
          filename: schema.attachments.originalName,
        }).from(schema.attachments).where(inArray(schema.attachments.dmMessageId, ids)).all(),
      )
    : [];
  const attachmentsByMessage = new Map<string, Array<{ type: string; filename: string }>>();
  for (const a of attachmentRows) {
    if (!a.dmMessageId) continue;
    const list = attachmentsByMessage.get(a.dmMessageId);
    const entry = { type: a.type, filename: a.filename };
    if (list) list.push(entry);
    else attachmentsByMessage.set(a.dmMessageId, [entry]);
  }

  for (const [channelId, message] of lastMessageMap) {
    previews.set(channelId, toDmLastMessagePreview(message, attachmentsByMessage.get(message.id) ?? []));
  }
  return previews;
}

/**
 * Each channel's members as user rows, in the order of its membership rows.
 */
function membersByChannel(db: Db, channelIds: string[]): Map<string, UserRow[]> {
  const memberRows = batchInArray(
    channelIds,
    ids => db.select().from(schema.dmMembers).where(inArray(schema.dmMembers.dmChannelId, ids)).all(),
  );
  const userIds = [...new Set(memberRows.map(m => m.userId))];
  const userRows = userIds.length > 0
    ? batchInArray(userIds, ids => db.select().from(schema.users).where(inArray(schema.users.id, ids)).all())
    : [];
  const userMap = new Map(userRows.map(u => [u.id, u]));

  const byChannel = new Map<string, UserRow[]>();
  for (const m of memberRows) {
    const user = userMap.get(m.userId);
    if (!user) continue;
    const list = byChannel.get(m.dmChannelId);
    if (list) list.push(user);
    else byChannel.set(m.dmChannelId, [user]);
  }
  return byChannel;
}

/**
 * Every DM the user has open (a `dm_members` row with `closed = 0` on a
 * channel that is not soft-deleted), each with its members and last-message
 * preview, in the order of the user's membership rows. Used by the ready
 * payload and by `GET /api/dm`, so the two lists cannot differ.
 *
 * `openMemberships` are the user's open membership rows when the caller has
 * already read them (the ready builder does); otherwise they are read here.
 */
export function loadOpenDmChannels(db: Db, userId: string, openMemberships?: DmMemberRow[]): DmChannel[] {
  const memberships = openMemberships ?? db.select()
    .from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.userId, userId),
      eq(schema.dmMembers.closed, 0),
    ))
    .all();
  if (memberships.length === 0) return [];

  const dmChannelIds = memberships.map(m => m.dmChannelId);

  const channelRows = batchInArray(
    dmChannelIds,
    ids => db.select().from(schema.dmChannels)
      .where(and(inArray(schema.dmChannels.id, ids), isNull(schema.dmChannels.deletedAt))).all(),
  );
  const channelMap = new Map(channelRows.map(c => [c.id, c]));
  const members = membersByChannel(db, dmChannelIds);
  const previews = newestMessagePreviews(db, dmChannelIds);

  const dmChannels: DmChannel[] = [];
  for (const membership of memberships) {
    const channel = channelMap.get(membership.dmChannelId);
    if (!channel) continue;
    dmChannels.push(toDmChannelWire(channel, members.get(channel.id) ?? [], previews.get(channel.id) ?? null));
  }
  return dmChannels;
}

/**
 * One DM channel as it goes on the wire, or null when the row does not exist
 * or is soft-deleted. Every emitter that sends a single conversation
 * (`dm_channel_created`, the create responses, re-attach) uses this, so its
 * payload is the entry the ready payload and `GET /api/dm` list for the row.
 *
 * `lastMessage` is the message the emitter is delivering with the channel
 * (the one that reopens it, a relayed message, a bootstrap system message);
 * without it, the newest stored message's preview is used.
 */
export function loadDmChannelWire(
  db: Db,
  channelId: string,
  lastMessage?: DmLastMessagePreview | DmMessageWithUser,
): DmChannel | null {
  const channel = db.select()
    .from(schema.dmChannels)
    .where(and(eq(schema.dmChannels.id, channelId), isNull(schema.dmChannels.deletedAt)))
    .get();
  if (!channel) return null;
  const members = membersByChannel(db, [channelId]).get(channelId) ?? [];
  const last = lastMessage ?? newestMessagePreviews(db, [channelId]).get(channelId) ?? null;
  return toDmChannelWire(channel, members, last);
}
