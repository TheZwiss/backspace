import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { connectionManager } from '../ws/handler.js';
import { loadDmChannelWire } from './dmChannelWire.js';
import type { DmReconcileResult } from './dmConversation.js';

/**
 * Tell local clients about 1-on-1 rows `reconcileDmChannelFederatedId`
 * re-keyed or merged, so each DM list shows the conversation once, under its
 * current row and key, without a reload. Existing events only:
 *
 * - merged: `dm_channel_closed` for the merged-away row to every affected
 *   member (a client that never listed it ignores it);
 * - merged or re-keyed: `dm_channel_created` with the surviving row, which the
 *   client's DM merge module upserts (refreshing a stale `federatedId` in
 *   place), to the members who have that row open. A member who closed the
 *   conversation keeps it closed; the next message resurfaces it as usual.
 *
 * Call after the transaction that reconciled has committed. Noops tell no one.
 */
export function announceDmReconcile(results: readonly DmReconcileResult[]): void {
  const db = getDb();
  for (const result of results) {
    if (result.action === 'noop') continue;

    if (result.action === 'merged') {
      for (const userId of result.affectedUserIds) {
        connectionManager.sendToUser(userId, { type: 'dm_channel_closed', dmChannelId: result.channelId });
      }
    }

    const dmChannel = loadDmChannelWire(db, result.targetChannelId);
    if (!dmChannel) continue;
    const openMembers = db
      .select({ userId: schema.dmMembers.userId })
      .from(schema.dmMembers)
      .where(and(eq(schema.dmMembers.dmChannelId, result.targetChannelId), eq(schema.dmMembers.closed, 0)))
      .all();
    for (const { userId } of openMembers) {
      connectionManager.sendToUser(userId, { type: 'dm_channel_created', dmChannel });
    }
  }
}
