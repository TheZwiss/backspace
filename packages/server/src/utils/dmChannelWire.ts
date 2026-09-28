import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DmChannel, DmLastMessagePreview } from '@backspace/shared';
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

/**
 * Every DM the user has open (a `dm_members` row with `closed = 0` on a
 * channel that is not soft-deleted), each with its members and last-message
 * preview, in the order of the user's membership rows. Used by the ready
 * payload and by `GET /api/dm`, so the two lists cannot differ.
 */
export function loadOpenDmChannels(db: Db, userId: string): DmChannel[] {
  const memberships = db.select()
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

  const memberRows = batchInArray(
    dmChannelIds,
    ids => db.select().from(schema.dmMembers).where(inArray(schema.dmMembers.dmChannelId, ids)).all(),
  );
  const memberIdsByChannel = new Map<string, string[]>();
  for (const m of memberRows) {
    const list = memberIdsByChannel.get(m.dmChannelId);
    if (list) list.push(m.userId);
    else memberIdsByChannel.set(m.dmChannelId, [m.userId]);
  }

  const userIds = [...new Set(memberRows.map(m => m.userId))];
  const userRows = userIds.length > 0
    ? batchInArray(userIds, ids => db.select().from(schema.users).where(inArray(schema.users.id, ids)).all())
    : [];
  const userMap = new Map(userRows.map(u => [u.id, u]));

  // Last message per channel in two steps: MAX(created_at) per channel, then
  // the rows at those timestamps. On a tie the first row per channel wins.
  const maxTimestamps = batchInArray(
    dmChannelIds,
    ids => db.select({
      dmChannelId: schema.dmMessages.dmChannelId,
      maxCreatedAt: sql<number>`MAX(${schema.dmMessages.createdAt})`.as('max_created_at'),
    }).from(schema.dmMessages).where(inArray(schema.dmMessages.dmChannelId, ids)).groupBy(schema.dmMessages.dmChannelId).all(),
  );
  const lastMessageMap = new Map<string, DmMessageRow>();
  if (maxTimestamps.length > 0) {
    const conditions = maxTimestamps.map(t =>
      and(eq(schema.dmMessages.dmChannelId, t.dmChannelId), eq(schema.dmMessages.createdAt, t.maxCreatedAt)),
    );
    const lastMessages = db.select().from(schema.dmMessages).where(or(...conditions)).all();
    for (const m of lastMessages) {
      if (!lastMessageMap.has(m.dmChannelId)) lastMessageMap.set(m.dmChannelId, m);
    }
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

  const dmChannels: DmChannel[] = [];
  for (const membership of memberships) {
    const channel = channelMap.get(membership.dmChannelId);
    if (!channel) continue;
    const members = (memberIdsByChannel.get(channel.id) ?? [])
      .map(id => userMap.get(id))
      .filter((u): u is UserRow => u !== undefined);
    const last = lastMessageMap.get(channel.id);
    dmChannels.push(toDmChannelWire(
      channel,
      members,
      last ? toDmLastMessagePreview(last, attachmentsByMessage.get(last.id) ?? []) : null,
    ));
  }
  return dmChannels;
}
