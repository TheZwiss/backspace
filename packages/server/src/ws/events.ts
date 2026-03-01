import { eq, inArray, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { connectionManager } from './handler.js';
import type { VoiceRoom, DmRoomMeta, ServerRoomMeta } from './handler.js';
import { isMember, getChannelServerId, isDmMember, hasPermission, PermissionBits } from '../utils/permissions.js';
import { broadcastDmMessage, getDmMessageWithUser } from '../routes/dm.js';
import type { User, MessageWithUser, Attachment, DmMessageWithUser } from '@backspace/shared';

function sanitizeUser(row: typeof schema.users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatar: row.avatar,
    status: (row.status ?? 'offline') as User['status'],
    customStatus: row.customStatus,
    isAdmin: row.isAdmin === 1,
    createdAt: row.createdAt,
  };
}

function getMessageWithUser(messageId: string): MessageWithUser | null {
  const db = getDb();
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!message) return null;

  const user = db.select().from(schema.users).where(eq(schema.users.id, message.userId)).get();
  if (!user) return null;

  const attachmentRows = db.select()
    .from(schema.attachments)
    .where(eq(schema.attachments.messageId, messageId))
    .all();

  const attachments: Attachment[] = attachmentRows.map(a => ({
    id: a.id,
    messageId: a.messageId ?? messageId,
    filename: a.filename,
    originalName: a.originalName,
    mimetype: a.mimetype,
    size: a.size,
    createdAt: a.createdAt,
  }));

  const reactionRows = db.select()
    .from(schema.reactions)
    .where(eq(schema.reactions.messageId, messageId))
    .all();

  const reactions = reactionRows.map(r => ({
    id: r.id,
    messageId: r.messageId,
    userId: r.userId,
    emoji: r.emoji,
    createdAt: r.createdAt,
  }));

  let replyTo: MessageWithUser | null = null;
  if (message.replyToId) {
    // Simple fetch for replyTo (one level deep to avoid recursion loops)
    const replyMsg = db.select().from(schema.messages).where(eq(schema.messages.id, message.replyToId)).get();
    if (replyMsg) {
      const replyUser = db.select().from(schema.users).where(eq(schema.users.id, replyMsg.userId)).get();
      if (replyUser) {
        replyTo = {
          id: replyMsg.id,
          channelId: replyMsg.channelId,
          userId: replyMsg.userId,
          replyToId: replyMsg.replyToId,
          content: replyMsg.content,
          editedAt: replyMsg.editedAt,
          createdAt: replyMsg.createdAt,
          user: sanitizeUser(replyUser),
          attachments: [], // Don't fetch attachments for replies to save bandwidth
          reactions: [], // Don't fetch reactions for replies
        };
      }
    }
  }

  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    replyToId: message.replyToId,
    content: message.content,
    editedAt: message.editedAt,
    createdAt: message.createdAt,
    user: sanitizeUser(user),
    attachments,
    reactions,
    replyTo,
  };
}

// Typing timeout tracking
const typingTimeouts: Map<string, NodeJS.Timeout> = new Map();

export function handleClientEvent(
  event: Record<string, unknown>,
  userId: string,
  username: string,
): void {
  const type = event.type as string;

  switch (type) {
    case 'message_create':
      handleMessageCreate(event, userId);
      break;
    case 'message_edit':
      handleMessageEdit(event, userId);
      break;
    case 'message_delete':
      handleMessageDelete(event, userId);
      break;
    case 'typing_start':
      handleTypingStart(event, userId, username);
      break;
    case 'presence_update':
      handlePresenceUpdate(event, userId);
      break;
    case 'voice_join':
      handleVoiceJoin(event, userId);
      break;
    case 'voice_leave':
      handleVoiceLeave(userId);
      break;
    case 'dm_message_create':
      handleDmMessageCreate(event, userId);
      break;
    case 'dm_typing_start':
      handleDmTypingStart(event, userId, username);
      break;
    case 'dm_message_edit':
      handleDmMessageEdit(event, userId);
      break;
    case 'dm_message_delete':
      handleDmMessageDelete(event, userId);
      break;
    case 'reaction_add':
      handleReactionAdd(event, userId);
      break;
    case 'reaction_remove':
      handleReactionRemove(event, userId);
      break;
    case 'channel_ack':
      handleChannelAck(event, userId);
      break;
    case 'dm_call_start':
      handleDmCallStart(event, userId, username);
      break;
    case 'dm_call_accept':
      handleDmCallAccept(event, userId);
      break;
    case 'dm_call_reject':
      handleDmCallReject(event, userId);
      break;
    case 'dm_call_end':
      handleDmCallEnd(event, userId);
      break;
    case 'voice_status':
      handleVoiceStatus(event, userId);
      break;
    default:
      connectionManager.sendToUser(userId, {
        type: 'error',
        message: `Unknown event type: ${type}`,
      });
  }
}

function handleMessageCreate(event: Record<string, unknown>, userId: string): void {
  const channelId = event.channelId as string;
  const content = event.content as string;
  const replyToId = event.replyToId as string | undefined;

  if (!channelId || typeof channelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'channelId is required' });
    return;
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'content is required' });
    return;
  }

  const serverId = getChannelServerId(channelId);
  if (!serverId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Channel not found' });
    return;
  }

  if (!hasPermission(userId, serverId, PermissionBits.SEND_MESSAGES, channelId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing SEND_MESSAGES permission' });
    return;
  }

  const db = getDb();
  const messageId = generateSnowflake();
  const now = Date.now();

  db.insert(schema.messages).values({
    id: messageId,
    channelId,
    userId,
    replyToId: replyToId || null,
    content: content.trim(),
    createdAt: now,
  }).run();

  const messageWithUser = getMessageWithUser(messageId);
  if (messageWithUser) {
    // Broadcast to members with VIEW_CHANNEL on this channel
    connectionManager.sendToChannel(serverId, channelId, {
      type: 'message_created',
      message: messageWithUser,
    });
  }
}

function handleMessageEdit(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;
  const content = event.content as string;

  if (!messageId || typeof messageId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'messageId is required' });
    return;
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'content is required' });
    return;
  }

  const db = getDb();
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!message) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message not found' });
    return;
  }

  if (message.userId !== userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You can only edit your own messages' });
    return;
  }

  const now = Date.now();
  db.update(schema.messages)
    .set({ content: content.trim(), editedAt: now })
    .where(eq(schema.messages.id, messageId))
    .run();

  const serverId = getChannelServerId(message.channelId);
  if (!serverId) return;

  const updatedMessage = getMessageWithUser(messageId);
  if (updatedMessage) {
    connectionManager.sendToChannel(serverId, message.channelId, {
      type: 'message_updated',
      message: updatedMessage,
    });
  }
}

function handleMessageDelete(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;

  if (!messageId || typeof messageId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'messageId is required' });
    return;
  }

  const db = getDb();
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!message) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message not found' });
    return;
  }

  const serverId = getChannelServerId(message.channelId);
  if (!serverId) return;

  // Allow author or MANAGE_MESSAGES permission holder to delete
  const isAuthor = message.userId === userId;
  const canManageMessages = hasPermission(userId, serverId, PermissionBits.MANAGE_MESSAGES, message.channelId);

  if (!isAuthor && !canManageMessages) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You cannot delete this message' });
    return;
  }

  // Delete attachments then message
  db.delete(schema.attachments).where(eq(schema.attachments.messageId, messageId)).run();
  db.delete(schema.messages).where(eq(schema.messages.id, messageId)).run();

  connectionManager.sendToChannel(serverId, message.channelId, {
    type: 'message_deleted',
    messageId,
    channelId: message.channelId,
  });
}

function handleTypingStart(event: Record<string, unknown>, userId: string, username: string): void {
  const channelId = event.channelId as string;

  if (!channelId || typeof channelId !== 'string') return;

  const serverId = getChannelServerId(channelId);
  if (!serverId) return;

  if (!hasPermission(userId, serverId, PermissionBits.SEND_MESSAGES, channelId)) return;

  // Clear previous typing timeout for this user+channel
  const key = `${userId}:${channelId}`;
  const existing = typingTimeouts.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  // Broadcast typing event to channel viewers (exclude sender)
  connectionManager.sendToChannel(serverId, channelId, {
    type: 'typing',
    channelId,
    userId,
    username,
  }, userId);

  // Auto-expire typing after 5 seconds
  const timeout = setTimeout(() => {
    typingTimeouts.delete(key);
  }, 5000);
  typingTimeouts.set(key, timeout);
}

function handlePresenceUpdate(event: Record<string, unknown>, userId: string): void {
  const status = event.status as string;

  if (!status || !['online', 'idle', 'dnd'].includes(status)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Status must be "online", "idle", or "dnd"' });
    return;
  }

  const db = getDb();
  db.update(schema.users).set({ status }).where(eq(schema.users.id, userId)).run();

  // Broadcast to all servers user is in
  const userServers = connectionManager.getUserServers(userId);
  for (const serverId of userServers) {
    connectionManager.sendToServer(serverId, {
      type: 'presence_update',
      userId,
      status,
    }, userId);
  }

  // Also send to self (other tabs)
  connectionManager.sendToUser(userId, {
    type: 'presence_update',
    userId,
    status,
  });
}

// ─── Voice Handlers (Unified Room API) ─────────────────────────────────────

/** Helper: broadcast a voice leave and auto-end empty DM calls. */
function broadcastRoomLeave(roomId: string, room: VoiceRoom, userId: string): void {
  if (room.roomType === 'server') {
    const meta = room.metadata as ServerRoomMeta;
    connectionManager.sendToServer(meta.serverId, {
      type: 'voice_state_update',
      channelId: roomId,
      userId,
      action: 'leave',
    });
  } else {
    connectionManager.sendToDmMembers(roomId, {
      type: 'voice_state_update',
      channelId: roomId,
      userId,
      action: 'leave',
    });
    // Auto-end call if DM room is now empty and was active
    const updatedRoom = connectionManager.getRoom(roomId);
    if (updatedRoom && updatedRoom.participants.size === 0 && (updatedRoom.metadata as DmRoomMeta).state === 'active') {
      connectionManager.destroyRoom(roomId);
      connectionManager.sendToDmMembers(roomId, {
        type: 'dm_call_ended',
        dmChannelId: roomId,
      });
    }
  }
}

function handleVoiceJoin(event: Record<string, unknown>, userId: string): void {
  const channelId = event.channelId as string;

  if (!channelId || typeof channelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'channelId is required' });
    return;
  }

  const serverId = getChannelServerId(channelId);
  if (!serverId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Channel not found' });
    return;
  }

  if (!hasPermission(userId, serverId, PermissionBits.CONNECT, channelId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing CONNECT permission' });
    return;
  }

  // If the user is already in this exact room (e.g. WS reconnect re-registration),
  // skip the leave+join broadcast to avoid visual flicker for other users.
  const currentRoom = connectionManager.getUserRoom(userId);
  if (currentRoom && currentRoom.roomId === channelId) {
    const status = connectionManager.getVoiceUserStatus(userId);
    if (status) {
      connectionManager.sendToRoom(channelId, {
        type: 'voice_status_update',
        userId,
        channelId,
        isMuted: status.isMuted,
        isDeafened: status.isDeafened,
        isCameraOn: status.isCameraOn,
        isScreenSharing: status.isScreenSharing,
      });
    }
    return;
  }

  // Leave current room (server OR DM)
  const left = connectionManager.leaveCurrentRoom(userId);
  if (left) {
    broadcastRoomLeave(left.roomId, left.room, userId);
  }

  // Cancel any ringing DM rooms where this user is the caller
  // (edge case: user starts DM call then joins server voice before anyone accepts)
  for (const [roomId, room] of connectionManager.getAllRooms()) {
    if (room.roomType === 'dm') {
      const meta = room.metadata as DmRoomMeta;
      if (meta.state === 'ringing' && meta.callerId === userId) {
        connectionManager.destroyRoom(roomId);
        connectionManager.sendToDmMembers(roomId, {
          type: 'dm_call_ended',
          dmChannelId: roomId,
        });
      }
    }
  }

  // Lazy-create server room
  connectionManager.createRoom(channelId, 'server', { type: 'server', serverId });

  // Join room
  connectionManager.joinRoom(channelId, userId);

  // Broadcast join
  connectionManager.sendToRoom(channelId, {
    type: 'voice_state_update',
    channelId,
    userId,
    action: 'join',
  });

  // Also broadcast current voice status if it exists (persisted during moves)
  const status = connectionManager.getVoiceUserStatus(userId);
  if (status) {
    connectionManager.sendToRoom(channelId, {
      type: 'voice_status_update',
      userId,
      channelId,
      isMuted: status.isMuted,
      isDeafened: status.isDeafened,
      isCameraOn: status.isCameraOn,
      isScreenSharing: status.isScreenSharing,
    });
  }
}

function handleVoiceLeave(userId: string): void {
  const left = connectionManager.leaveCurrentRoom(userId);
  if (left) {
    broadcastRoomLeave(left.roomId, left.room, userId);
  }
  connectionManager.clearVoiceUserStatus(userId);
}

function handleVoiceStatus(event: Record<string, unknown>, userId: string): void {
  const isMuted = event.isMuted === true;
  const isDeafened = event.isDeafened === true;
  const isCameraOn = event.isCameraOn === true;
  const isScreenSharing = event.isScreenSharing === true;

  // BUG FIX: uses unified getUserRoom() instead of server-only getUserVoiceChannel()
  // This now works for both server channels AND DM calls.
  const userRoom = connectionManager.getUserRoom(userId);
  if (!userRoom) return;

  connectionManager.setVoiceUserStatus(userId, isMuted, isDeafened, isCameraOn, isScreenSharing);

  // sendToRoom routes to sendToServer for server rooms, sendToDmMembers for DM rooms
  connectionManager.sendToRoom(userRoom.roomId, {
    type: 'voice_status_update',
    userId,
    channelId: userRoom.roomId,
    isMuted,
    isDeafened,
    isCameraOn,
    isScreenSharing,
  });
}

// ─── DM Message Handlers ───────────────────────────────────────────────────

function handleDmMessageCreate(event: Record<string, unknown>, userId: string): void {
  const dmChannelId = event.dmChannelId as string;
  const content = event.content as string | undefined;
  const attachmentIds = event.attachments as string[] | undefined;
  const replyToId = event.replyToId as string | undefined;

  if (!dmChannelId || typeof dmChannelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'dmChannelId is required' });
    return;
  }

  const hasContent = content && typeof content === 'string' && content.trim().length > 0;
  const hasAttachments = attachmentIds && Array.isArray(attachmentIds) && attachmentIds.length > 0;

  if (!hasContent && !hasAttachments) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message must have content or attachments' });
    return;
  }

  if (!isDmMember(dmChannelId, userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Not a member of this DM channel' });
    return;
  }

  const db = getDb();
  const messageId = generateSnowflake();
  const now = Date.now();

  db.insert(schema.dmMessages).values({
    id: messageId,
    dmChannelId,
    userId,
    replyToId: replyToId || null,
    content: hasContent ? content.trim() : null,
    createdAt: now,
  }).run();

  // Link attachments to this DM message
  if (hasAttachments) {
    for (const attId of attachmentIds) {
      db.update(schema.attachments)
        .set({ dmMessageId: messageId })
        .where(eq(schema.attachments.id, attId))
        .run();
    }
  }

  const dmMessage = getDmMessageWithUser(messageId);
  if (!dmMessage) return;

  // Broadcast to all DM members (including those who closed the channel)
  broadcastDmMessage(dmChannelId, dmMessage);
}

function handleDmTypingStart(event: Record<string, unknown>, userId: string, username: string): void {
  const dmChannelId = event.dmChannelId as string;

  if (!dmChannelId || typeof dmChannelId !== 'string') return;

  if (!isDmMember(dmChannelId, userId)) return;

  const key = `dm:${userId}:${dmChannelId}`;
  const existing = typingTimeouts.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  // Send to all other DM members
  const db = getDb();
  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  for (const member of dmMembers) {
    if (member.userId !== userId) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_typing',
        dmChannelId,
        userId,
        username,
      });
    }
  }

  const timeout = setTimeout(() => {
    typingTimeouts.delete(key);
  }, 5000);
  typingTimeouts.set(key, timeout);
}

function handleDmMessageEdit(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;
  const content = event.content as string;

  if (!messageId || typeof messageId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'messageId is required' });
    return;
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'content is required' });
    return;
  }

  const db = getDb();
  const msg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!msg) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message not found' });
    return;
  }

  if (msg.userId !== userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You can only edit your own messages' });
    return;
  }

  const now = Date.now();
  db.update(schema.dmMessages)
    .set({ content: content.trim(), editedAt: now })
    .where(eq(schema.dmMessages.id, messageId))
    .run();

  const updated = getDmMessageWithUser(messageId);
  if (!updated) return;

  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, msg.dmChannelId))
    .all();

  for (const member of dmMembers) {
    connectionManager.sendToUser(member.userId, {
      type: 'dm_message_updated',
      message: updated,
    });
  }
}

function handleDmMessageDelete(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;

  if (!messageId || typeof messageId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'messageId is required' });
    return;
  }

  const db = getDb();
  const msg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!msg) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Message not found' });
    return;
  }

  if (msg.userId !== userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You can only delete your own messages' });
    return;
  }

  // Delete attachments linked to this DM message
  db.delete(schema.attachments)
    .where(eq(schema.attachments.dmMessageId, messageId))
    .run();

  // Delete reactions
  db.delete(schema.dmReactions)
    .where(eq(schema.dmReactions.dmMessageId, messageId))
    .run();

  // Delete message
  db.delete(schema.dmMessages)
    .where(eq(schema.dmMessages.id, messageId))
    .run();

  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, msg.dmChannelId))
    .all();

  for (const member of dmMembers) {
    connectionManager.sendToUser(member.userId, {
      type: 'dm_message_deleted',
      messageId,
      dmChannelId: msg.dmChannelId,
    });
  }
}

// ─── Reaction Handlers ─────────────────────────────────────────────────────

function handleReactionAdd(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;
  const emoji = event.emoji as string;

  if (!messageId || !emoji) return;

  const db = getDb();
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!message) return;

  const serverId = getChannelServerId(message.channelId);
  if (!serverId || !isMember(serverId, userId)) return;

  const reactionId = generateSnowflake();
  try {
    db.insert(schema.reactions).values({
      id: reactionId,
      messageId,
      userId,
      emoji,
      createdAt: Date.now(),
    }).run();

    connectionManager.sendToChannel(serverId, message.channelId, {
      type: 'reaction_added',
      messageId,
      reaction: {
        id: reactionId,
        messageId,
        userId,
        emoji,
        createdAt: Date.now(),
      },
    });
  } catch (err) {
    // Unique constraint violation (already reacted)
  }
}

function handleReactionRemove(event: Record<string, unknown>, userId: string): void {
  const messageId = event.messageId as string;
  const emoji = event.emoji as string;

  if (!messageId || !emoji) return;

  const db = getDb();
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (!message) return;

  const serverId = getChannelServerId(message.channelId);
  if (!serverId || !isMember(serverId, userId)) return;

  const result = db.delete(schema.reactions)
    .where(and(
      eq(schema.reactions.messageId, messageId),
      eq(schema.reactions.userId, userId),
      eq(schema.reactions.emoji, emoji)
    ))
    .run();

  if (result.changes > 0) {
    connectionManager.sendToChannel(serverId, message.channelId, {
      type: 'reaction_removed',
      messageId,
      userId,
      emoji,
    });
  }
}

// ─── Read State Handler ────────────────────────────────────────────────────

function handleChannelAck(event: Record<string, unknown>, userId: string): void {
  const channelId = event.channelId as string;
  const messageId = event.messageId as string;
  if (!channelId || !messageId) return;

  const db = getDb();

  const existing = db.select()
    .from(schema.readStates)
    .where(and(
      eq(schema.readStates.userId, userId),
      eq(schema.readStates.channelId, channelId),
    ))
    .get();

  const now = Date.now();

  if (existing) {
    // Only update if the new messageId is newer (larger snowflake)
    if (BigInt(messageId) > BigInt(existing.lastReadMessageId)) {
      db.update(schema.readStates)
        .set({ lastReadMessageId: messageId, updatedAt: now })
        .where(and(
          eq(schema.readStates.userId, userId),
          eq(schema.readStates.channelId, channelId),
        ))
        .run();
    }
  } else {
    db.insert(schema.readStates).values({
      userId,
      channelId,
      lastReadMessageId: messageId,
      updatedAt: now,
    }).run();
  }

  // Echo ack back to all of this user's connections (multi-tab sync)
  connectionManager.sendToUser(userId, {
    type: 'channel_ack',
    channelId,
    messageId,
  });
}

// ─── DM Call Handlers (Unified Room API) ───────────────────────────────────

function handleDmCallStart(event: Record<string, unknown>, userId: string, username: string): void {
  const dmChannelId = event.dmChannelId as string;
  if (!dmChannelId || typeof dmChannelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'dmChannelId is required' });
    return;
  }

  if (!isDmMember(dmChannelId, userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You are not a member of this DM channel' });
    return;
  }

  // Leave current room if in one
  const left = connectionManager.leaveCurrentRoom(userId);
  if (left) {
    broadcastRoomLeave(left.roomId, left.room, userId);
  }
  connectionManager.clearVoiceUserStatus(userId);

  // Cancel any other ringing rooms started by this user
  for (const [roomId, room] of connectionManager.getAllRooms()) {
    if (room.roomType === 'dm' && roomId !== dmChannelId) {
      const meta = room.metadata as DmRoomMeta;
      if (meta.state === 'ringing' && meta.callerId === userId) {
        connectionManager.destroyRoom(roomId);
        connectionManager.sendToDmMembers(roomId, {
          type: 'dm_call_ended',
          dmChannelId: roomId,
        });
      }
    }
  }

  // Create DM room in ringing state (fails if already active)
  const created = connectionManager.createDmRoom(dmChannelId, userId);
  if (!created) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'A call is already active in this DM channel' });
    return;
  }

  // Ring other members
  connectionManager.sendToDmMembers(dmChannelId, {
    type: 'dm_call_incoming',
    dmChannelId,
    callerId: userId,
    callerName: username,
  }, userId);
}

function handleDmCallAccept(event: Record<string, unknown>, userId: string): void {
  const dmChannelId = event.dmChannelId as string;
  if (!dmChannelId || typeof dmChannelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'dmChannelId is required' });
    return;
  }

  if (!isDmMember(dmChannelId, userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You are not a member of this DM channel' });
    return;
  }

  const room = connectionManager.getRoom(dmChannelId);
  if (!room || room.roomType !== 'dm') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'No active call in this DM channel' });
    return;
  }

  const meta = room.metadata as DmRoomMeta;

  if (meta.state === 'ringing') {
    // First accept — transition ringing→active and join the caller
    connectionManager.activateDmRoom(dmChannelId);

    // Leave caller's current room if in one
    const callerLeft = connectionManager.leaveCurrentRoom(meta.callerId);
    if (callerLeft) {
      broadcastRoomLeave(callerLeft.roomId, callerLeft.room, meta.callerId);
    }

    // Join caller into the DM room
    connectionManager.joinRoom(dmChannelId, meta.callerId);

    // Broadcast voice_state_update join for caller
    connectionManager.sendToDmMembers(dmChannelId, {
      type: 'voice_state_update',
      channelId: dmChannelId,
      userId: meta.callerId,
      action: 'join',
    });
  }
  // If already active, this is a late-join (e.g. 3rd member joining group call).
  // Skip the ringing→active transition and caller join — just join the acceptor below.

  // Leave acceptor's current room if in one
  const acceptorLeft = connectionManager.leaveCurrentRoom(userId);
  if (acceptorLeft) {
    broadcastRoomLeave(acceptorLeft.roomId, acceptorLeft.room, userId);
  }

  // Join acceptor into the DM room
  connectionManager.joinRoom(dmChannelId, userId);

  // Notify all DM members that the call was accepted
  connectionManager.sendToDmMembers(dmChannelId, {
    type: 'dm_call_accepted',
    dmChannelId,
  });

  // Broadcast voice_state_update join for acceptor
  connectionManager.sendToDmMembers(dmChannelId, {
    type: 'voice_state_update',
    channelId: dmChannelId,
    userId,
    action: 'join',
  });
}

function handleDmCallReject(event: Record<string, unknown>, userId: string): void {
  const dmChannelId = event.dmChannelId as string;
  if (!dmChannelId || typeof dmChannelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'dmChannelId is required' });
    return;
  }

  if (!isDmMember(dmChannelId, userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You are not a member of this DM channel' });
    return;
  }

  const room = connectionManager.getRoom(dmChannelId);
  if (!room) return; // No active call, silently ignore

  // Destroy room
  connectionManager.destroyRoom(dmChannelId);

  // Notify all DM members that the call was rejected
  connectionManager.sendToDmMembers(dmChannelId, {
    type: 'dm_call_rejected',
    dmChannelId,
  });
}

function handleDmCallEnd(event: Record<string, unknown>, userId: string): void {
  const dmChannelId = event.dmChannelId as string;
  if (!dmChannelId || typeof dmChannelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'dmChannelId is required' });
    return;
  }

  if (!isDmMember(dmChannelId, userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You are not a member of this DM channel' });
    return;
  }

  const room = connectionManager.getRoom(dmChannelId);
  if (!room) return; // No active call, silently ignore

  // Clear voice user states for all participants
  for (const participantId of room.participants) {
    connectionManager.clearVoiceUserStatus(participantId);
  }

  // Destroy room (removes all participants from userToRoom)
  connectionManager.destroyRoom(dmChannelId);

  // Notify all DM members that the call ended
  connectionManager.sendToDmMembers(dmChannelId, {
    type: 'dm_call_ended',
    dmChannelId,
  });
}
