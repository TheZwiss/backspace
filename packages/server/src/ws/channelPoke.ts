import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { generateSnowflake } from '../utils/snowflake.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { getDb, schema } from '../db/index.js';
import { getChannelSpaceId, hasPermission, PermissionBits } from '../utils/permissions.js';
import { connectionManager } from './handler.js';

// Persist passive history before broadcasting; the separate poke event only animates live viewers.
export function handleChannelPoke({ event, userId, ws }: {
  event: Record<string, unknown>; userId: string; ws: WebSocket;
}): void {
  const { channelId, targetUserId } = event;
  const fail = (message: string) => ws.send(JSON.stringify({ type: 'channel_poke_failed', message }));
  if (typeof channelId !== 'string' || typeof targetUserId !== 'string') {
    fail('Invalid poke target'); return;
  }
  const spaceId = getChannelSpaceId(channelId);
  if (!spaceId || !hasPermission(userId, spaceId, PermissionBits.VIEW_CHANNEL, channelId)
    || !hasPermission(userId, spaceId, PermissionBits.SEND_MESSAGES, channelId)
    || !hasPermission(targetUserId, spaceId, PermissionBits.VIEW_CHANNEL, channelId)) {
    fail('Poke requires channel access and permission to send messages'); return;
  }
  const db = getDb();
  const actor = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const target = db.select().from(schema.users).where(eq(schema.users.id, targetUserId)).get();
  if (!actor || !target) { fail('Poke user not found'); return; }
  const username = actor.displayName ?? actor.username;
  const targetUsername = target.displayName ?? target.username;
  const message = db.insert(schema.messages).values({
    id: generateSnowflake(), channelId, userId, type: 'system',
    content: JSON.stringify({ event: 'channel_poke', targetUserId, username, targetUsername }),
    createdAt: Date.now(),
  }).returning().get();
  connectionManager.sendToChannel(spaceId, channelId, {
    type: 'message_created',
    message: { ...message, user: sanitizeUser(actor), attachments: [], embeds: [], reactions: [] },
  });
  // The gateway's per-user limiter applies across tabs before this handler runs.
  connectionManager.sendToChannel(spaceId, channelId, {
    type: 'channel_poke', channelId, userId, targetUserId,
    username: actor.displayName ?? actor.username,
    targetUsername: target.displayName ?? target.username,
  });
}
