import { eq, inArray, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { connectionManager } from './handler.js';
import type { VoiceRoom, DmRoomMeta, SpaceRoomMeta } from './handler.js';
import { isMember, getChannelSpaceId, isDmMember, hasPermission, computePermissions, PermissionBits } from '../utils/permissions.js';
import { broadcastDmMessage, getDmMessageWithUser } from '../routes/dm.js';
import { MAX_MESSAGE_LENGTH, type MessageWithUser, type Attachment, type DmMessageWithUser, type Embed } from '@backspace/shared';
import { sanitizeUser } from '../utils/sanitize.js';
import { deleteAttachmentFiles } from '../utils/fileCleanup.js';
import { resolveEmbeds, reResolveEmbeds, embedRowToEmbed } from '../utils/embedResolver.js';

/**
 * Re-evaluate SPEAK permission for all participants in voice channels
 * belonging to the given space. On transition, updates the in-memory
 * permissionMutedUsers Set and broadcasts voice_permission_muted events.
 */
export function checkVoicePermissions(spaceId: string): void {
  for (const [roomId, room] of connectionManager.getAllRooms()) {
    if (room.roomType !== 'space') continue;
    const meta = room.metadata as SpaceRoomMeta;
    if (meta.spaceId !== spaceId) continue;

    for (const userId of room.participants) {
      const perms = computePermissions(userId, spaceId, roomId);
      const canSpeak = (perms & PermissionBits.SPEAK) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
      const wasMuted = connectionManager.isPermissionMuted(spaceId, userId);
      const shouldMute = !canSpeak;

      if (shouldMute !== wasMuted) {
        connectionManager.setPermissionMuted(spaceId, userId, shouldMute);
        connectionManager.sendToSpace(spaceId, {
          type: 'voice_permission_muted',
          userId,
          spaceId,
          muted: shouldMute,
        });
      }
    }
  }
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
    thumbnailFilename: a.thumbnailFilename ?? null,
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

  const embedRows = db.select()
    .from(schema.embeds)
    .where(eq(schema.embeds.messageId, messageId))
    .all();

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
          embeds: [],
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
    embeds: embedRows.map(e => embedRowToEmbed(e)),
    reactions,
    replyTo,
  };
}

// Typing timeout tracking (capped to prevent unbounded growth)
const MAX_TYPING_ENTRIES = 10_000;
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
    case 'mark_unread':
      handleMarkUnread(event, userId);
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
    case 'voice_space_mute':
      handleVoiceSpaceMute(event, userId);
      break;
    case 'voice_space_deafen':
      handleVoiceSpaceDeafen(event, userId);
      break;
    case 'voice_move':
      handleVoiceMove(event, userId);
      break;
    case 'voice_disconnect':
      handleVoiceDisconnect(event, userId);
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

  if (content.length > MAX_MESSAGE_LENGTH) {
    connectionManager.sendToUser(userId, { type: 'error', message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less` });
    return;
  }

  const spaceId = getChannelSpaceId(channelId);
  if (!spaceId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Channel not found' });
    return;
  }

  if (!hasPermission(userId, spaceId, PermissionBits.SEND_MESSAGES, channelId)) {
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
    connectionManager.sendToChannel(spaceId, channelId, {
      type: 'message_created',
      message: messageWithUser,
    });

    // Resolve embeds asynchronously
    setImmediate(() => {
      resolveEmbeds(messageId, content.trim(), channelId, false, spaceId).catch(() => {});
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

  if (content.length > MAX_MESSAGE_LENGTH) {
    connectionManager.sendToUser(userId, { type: 'error', message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less` });
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

  const spaceId = getChannelSpaceId(message.channelId);
  if (!spaceId) return;

  const updatedMessage = getMessageWithUser(messageId);
  if (updatedMessage) {
    connectionManager.sendToChannel(spaceId, message.channelId, {
      type: 'message_updated',
      message: updatedMessage,
    });

    // Re-resolve embeds asynchronously
    setImmediate(() => {
      reResolveEmbeds(messageId, content.trim(), message.channelId, false, spaceId).catch(() => {});
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

  const spaceId = getChannelSpaceId(message.channelId);
  if (!spaceId) return;

  // Allow author or MANAGE_MESSAGES permission holder to delete
  const isAuthor = message.userId === userId;
  const canManageMessages = hasPermission(userId, spaceId, PermissionBits.MANAGE_MESSAGES, message.channelId);

  if (!isAuthor && !canManageMessages) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'You cannot delete this message' });
    return;
  }

  // Collect attachment filenames before deletion
  const attachmentRows = db.select({ filename: schema.attachments.filename })
    .from(schema.attachments).where(eq(schema.attachments.messageId, messageId)).all();

  // Delete attachments + message atomically, file cleanup outside transaction
  db.transaction((tx) => {
    tx.delete(schema.attachments).where(eq(schema.attachments.messageId, messageId)).run();
    tx.delete(schema.messages).where(eq(schema.messages.id, messageId)).run();
  });

  // Clean up files from disk (outside transaction — file I/O)
  deleteAttachmentFiles(attachmentRows);

  connectionManager.sendToChannel(spaceId, message.channelId, {
    type: 'message_deleted',
    messageId,
    channelId: message.channelId,
  });
}

function handleTypingStart(event: Record<string, unknown>, userId: string, username: string): void {
  const channelId = event.channelId as string;

  if (!channelId || typeof channelId !== 'string') return;

  const spaceId = getChannelSpaceId(channelId);
  if (!spaceId) return;

  if (!hasPermission(userId, spaceId, PermissionBits.SEND_MESSAGES, channelId)) return;

  // Clear previous typing timeout for this user+channel
  const key = `${userId}:${channelId}`;
  const existing = typingTimeouts.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  // Broadcast typing event to channel viewers (exclude sender)
  connectionManager.sendToChannel(spaceId, channelId, {
    type: 'typing',
    channelId,
    userId,
    username,
  }, userId);

  // Safety cap: skip if Map is at max capacity (auto-expiry handles normal cleanup)
  if (!existing && typingTimeouts.size >= MAX_TYPING_ENTRIES) return;

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

  // Broadcast to all spaces user is in
  const userSpaces = connectionManager.getUserSpaces(userId);
  for (const spaceId of userSpaces) {
    connectionManager.sendToSpace(spaceId, {
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
  if (room.roomType === 'space') {
    const meta = room.metadata as SpaceRoomMeta;
    connectionManager.sendToSpace(meta.spaceId, {
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

  const spaceId = getChannelSpaceId(channelId);
  if (!spaceId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Channel not found' });
    return;
  }

  if (!hasPermission(userId, spaceId, PermissionBits.CONNECT, channelId)) {
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

    // Re-broadcast persistent restrictions (covers page reload while in voice)
    const db = getDb();
    const restrictions = db.select()
      .from(schema.voiceRestrictions)
      .where(and(
        eq(schema.voiceRestrictions.spaceId, spaceId),
        eq(schema.voiceRestrictions.userId, userId),
      ))
      .all();
    for (const r of restrictions) {
      if (r.restrictionType === 'mute') {
        connectionManager.setSpaceMuted(spaceId, userId, true);
        connectionManager.sendToUser(userId, {
          type: 'voice_space_muted',
          userId,
          channelId,
          spaceId,
          muted: true,
        });
      } else if (r.restrictionType === 'deafen') {
        connectionManager.setSpaceDeafened(spaceId, userId, true);
        connectionManager.sendToUser(userId, {
          type: 'voice_space_deafened',
          userId,
          channelId,
          spaceId,
          deafened: true,
        });
      }
    }

    // Re-check permission mute on re-registration
    {
      const perms = computePermissions(userId, spaceId, channelId);
      const canSpeak = (perms & PermissionBits.SPEAK) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
      const shouldPermMute = !canSpeak;
      connectionManager.setPermissionMuted(spaceId, userId, shouldPermMute);
      if (shouldPermMute) {
        connectionManager.sendToUser(userId, {
          type: 'voice_permission_muted',
          userId,
          spaceId,
          muted: true,
        });
      }
    }
    return;
  }

  // Leave current room (space OR DM)
  const left = connectionManager.leaveCurrentRoom(userId);
  if (left) {
    broadcastRoomLeave(left.roomId, left.room, userId);

    // Notify all of the user's tabs so the displaced tab tears down LiveKit
    connectionManager.sendToUser(userId, {
      type: 'voice_disconnected',
      userId,
      channelId: left.roomId,
      reason: 'displaced',
    });
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

  // Lazy-create space room
  connectionManager.createRoom(channelId, 'space', { type: 'space', spaceId });

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

  // Load persistent voice restrictions for this user in this space
  const db = getDb();
  const restrictions = db.select()
    .from(schema.voiceRestrictions)
    .where(and(
      eq(schema.voiceRestrictions.spaceId, spaceId),
      eq(schema.voiceRestrictions.userId, userId),
    ))
    .all();

  for (const r of restrictions) {
    if (r.restrictionType === 'mute') {
      connectionManager.setSpaceMuted(spaceId, userId, true);
      connectionManager.sendToSpace(spaceId, {
        type: 'voice_space_muted',
        userId,
        channelId,
        spaceId,
        muted: true,
      });
    } else if (r.restrictionType === 'deafen') {
      connectionManager.setSpaceDeafened(spaceId, userId, true);
      connectionManager.sendToSpace(spaceId, {
        type: 'voice_space_deafened',
        userId,
        channelId,
        spaceId,
        deafened: true,
      });
    }
  }

  // Check SPEAK permission and apply permission mute if needed
  {
    const perms = computePermissions(userId, spaceId, channelId);
    const canSpeak = (perms & PermissionBits.SPEAK) !== 0n || (perms & PermissionBits.ADMINISTRATOR) !== 0n;
    if (!canSpeak) {
      connectionManager.setPermissionMuted(spaceId, userId, true);
      connectionManager.sendToSpace(spaceId, {
        type: 'voice_permission_muted',
        userId,
        spaceId,
        muted: true,
      });
    }
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

  let isSpaceMuted = false;
  let isSpaceDeafened = false;
  let isPermMuted = false;
  if (userRoom.room.roomType === 'space') {
    const meta = userRoom.room.metadata as SpaceRoomMeta;
    isSpaceMuted = connectionManager.isSpaceMuted(meta.spaceId, userId);
    isSpaceDeafened = connectionManager.isSpaceDeafened(meta.spaceId, userId);
    isPermMuted = connectionManager.isPermissionMuted(meta.spaceId, userId);
  }

  // Server-side enforcement: prevent clients from bypassing server mute/deafen/permission mute
  const effectiveMuted = (isSpaceMuted || isPermMuted) ? true : isMuted;
  const effectiveDeafened = isSpaceDeafened ? true : isDeafened;

  connectionManager.setVoiceUserStatus(userId, effectiveMuted, effectiveDeafened, isCameraOn, isScreenSharing);

  // sendToRoom routes to sendToSpace for space rooms, sendToDmMembers for DM rooms
  connectionManager.sendToRoom(userRoom.roomId, {
    type: 'voice_status_update',
    userId,
    channelId: userRoom.roomId,
    isMuted: effectiveMuted,
    isDeafened: effectiveDeafened,
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

  if (hasContent && content!.length > MAX_MESSAGE_LENGTH) {
    connectionManager.sendToUser(userId, { type: 'error', message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less` });
    return;
  }

  if (!isDmMember(dmChannelId, userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Not a member of this DM channel' });
    return;
  }

  const db = getDb();

  // Verify attachment ownership before linking
  if (hasAttachments) {
    for (const attId of attachmentIds) {
      const att = db.select().from(schema.attachments).where(eq(schema.attachments.id, attId)).get();
      if (!att || att.messageId || att.dmMessageId) {
        connectionManager.sendToUser(userId, { type: 'error', message: 'Invalid or already-used attachment' });
        return;
      }
      if (att.uploaderId && att.uploaderId !== userId) {
        connectionManager.sendToUser(userId, { type: 'error', message: 'You do not own this attachment' });
        return;
      }
    }
  }

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

  // Resolve embeds asynchronously
  setImmediate(() => {
    resolveEmbeds(messageId, hasContent ? content!.trim() : null, dmChannelId, true, null).catch(() => {});
  });
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

  if (content.length > MAX_MESSAGE_LENGTH) {
    connectionManager.sendToUser(userId, { type: 'error', message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or less` });
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

  // Re-resolve embeds asynchronously
  setImmediate(() => {
    reResolveEmbeds(messageId, content.trim(), msg.dmChannelId, true, null).catch(() => {});
  });
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

  // Collect attachment filenames before deletion
  const dmAttachmentRows = db.select({ filename: schema.attachments.filename })
    .from(schema.attachments).where(eq(schema.attachments.dmMessageId, messageId)).all();

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

  // Clean up files from disk
  deleteAttachmentFiles(dmAttachmentRows);

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

  // Try space message first
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (message) {
    const spaceId = getChannelSpaceId(message.channelId);
    if (!spaceId || !isMember(spaceId, userId)) return;

    if (!hasPermission(userId, spaceId, PermissionBits.ADD_REACTIONS, message.channelId)) {
      connectionManager.sendToUser(userId, { type: 'error', message: 'Missing ADD_REACTIONS permission' });
      return;
    }

    const reactionId = generateSnowflake();
    const now = Date.now();
    try {
      db.insert(schema.reactions).values({
        id: reactionId,
        messageId,
        userId,
        emoji,
        createdAt: now,
      }).run();

      // Include user object so remote clients can use isSelf() for identity resolution
      const reactionUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
      const userObj = reactionUser ? sanitizeUser(reactionUser) : undefined;

      connectionManager.sendToChannel(spaceId, message.channelId, {
        type: 'reaction_added',
        messageId,
        reaction: { id: reactionId, messageId, userId, emoji, createdAt: now, user: userObj },
      });
    } catch (err) {
      // Unique constraint violation (already reacted)
    }
    return;
  }

  // Fall through to DM message
  const dmMsg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!dmMsg || !isDmMember(dmMsg.dmChannelId, userId)) return;

  const reactionId = generateSnowflake();
  const now = Date.now();
  try {
    db.insert(schema.dmReactions).values({
      id: reactionId,
      dmMessageId: messageId,
      userId,
      emoji,
      createdAt: now,
    }).run();

    // Include user object so remote clients can use isSelf() for identity resolution
    const reactionUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    const userObj = reactionUser ? sanitizeUser(reactionUser) : undefined;

    connectionManager.sendToDmMembers(dmMsg.dmChannelId, {
      type: 'reaction_added',
      messageId,
      reaction: { id: reactionId, messageId, userId, emoji, createdAt: now, user: userObj },
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

  // Try space message first
  const message = db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
  if (message) {
    const spaceId = getChannelSpaceId(message.channelId);
    if (!spaceId || !isMember(spaceId, userId)) return;

    const result = db.delete(schema.reactions)
      .where(and(
        eq(schema.reactions.messageId, messageId),
        eq(schema.reactions.userId, userId),
        eq(schema.reactions.emoji, emoji)
      ))
      .run();

    if (result.changes > 0) {
      connectionManager.sendToChannel(spaceId, message.channelId, {
        type: 'reaction_removed',
        messageId,
        userId,
        emoji,
      });
    }
    return;
  }

  // Fall through to DM message
  const dmMsg = db.select().from(schema.dmMessages).where(eq(schema.dmMessages.id, messageId)).get();
  if (!dmMsg || !isDmMember(dmMsg.dmChannelId, userId)) return;

  const result = db.delete(schema.dmReactions)
    .where(and(
      eq(schema.dmReactions.dmMessageId, messageId),
      eq(schema.dmReactions.userId, userId),
      eq(schema.dmReactions.emoji, emoji)
    ))
    .run();

  if (result.changes > 0) {
    connectionManager.sendToDmMembers(dmMsg.dmChannelId, {
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
  // Validate messageId is a valid snowflake (numeric string) — reject temp/garbage IDs
  if (!/^\d+$/.test(messageId)) return;

  // Validate channel membership — reject acks for channels the user doesn't belong to
  const spaceId = getChannelSpaceId(channelId);
  if (spaceId) {
    if (!isMember(spaceId, userId)) return;
  } else {
    if (!isDmMember(channelId, userId)) return;
  }

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

function handleMarkUnread(event: Record<string, unknown>, userId: string): void {
  const channelId = event.channelId as string;
  const messageId = event.messageId as string;
  if (!channelId || !messageId) return;
  if (!/^\d+$/.test(messageId)) return;

  // Validate channel membership
  const spaceId = getChannelSpaceId(channelId);
  if (spaceId) {
    if (!isMember(spaceId, userId)) return;
  } else {
    if (!isDmMember(channelId, userId)) return;
  }

  const db = getDb();
  const now = Date.now();

  if (messageId === '0') {
    // '0' sentinel: delete the read state entirely → channel appears fully unread
    db.delete(schema.readStates)
      .where(and(
        eq(schema.readStates.userId, userId),
        eq(schema.readStates.channelId, channelId),
      ))
      .run();
  } else {
    // Set read state to the specified message (allows backward writes)
    const existing = db.select()
      .from(schema.readStates)
      .where(and(
        eq(schema.readStates.userId, userId),
        eq(schema.readStates.channelId, channelId),
      ))
      .get();

    if (existing) {
      db.update(schema.readStates)
        .set({ lastReadMessageId: messageId, updatedAt: now })
        .where(and(
          eq(schema.readStates.userId, userId),
          eq(schema.readStates.channelId, channelId),
        ))
        .run();
    } else {
      db.insert(schema.readStates).values({
        userId,
        channelId,
        lastReadMessageId: messageId,
        updatedAt: now,
      }).run();
    }
  }

  // Broadcast to all of this user's connections (multi-tab sync)
  connectionManager.sendToUser(userId, {
    type: 'mark_unread',
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

// ─── Voice Moderation Handlers ──────────────────────────────────────────────

function handleVoiceSpaceMute(event: Record<string, unknown>, userId: string): void {
  const targetUserId = event.userId as string;
  const muted = event.muted === true;

  if (!targetUserId || typeof targetUserId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'userId is required' });
    return;
  }

  // Find the target user's current room
  const targetRoom = connectionManager.getUserRoom(targetUserId);
  if (!targetRoom || targetRoom.room.roomType !== 'space') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target user is not in a voice channel' });
    return;
  }

  const meta = targetRoom.room.metadata as SpaceRoomMeta;
  if (!hasPermission(userId, meta.spaceId, PermissionBits.MUTE_MEMBERS, targetRoom.roomId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing MUTE_MEMBERS permission' });
    return;
  }

  // Cannot space-mute yourself
  if (targetUserId === userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Cannot space-mute yourself' });
    return;
  }

  connectionManager.setSpaceMuted(meta.spaceId, targetUserId, muted);

  // Persist to DB
  const db = getDb();
  if (muted) {
    db.insert(schema.voiceRestrictions).values({
      spaceId: meta.spaceId,
      userId: targetUserId,
      restrictionType: 'mute',
      moderatorId: userId,
      createdAt: Date.now(),
    }).onConflictDoNothing().run();
  } else {
    db.delete(schema.voiceRestrictions).where(
      and(
        eq(schema.voiceRestrictions.spaceId, meta.spaceId),
        eq(schema.voiceRestrictions.userId, targetUserId),
        eq(schema.voiceRestrictions.restrictionType, 'mute'),
      )
    ).run();
  }

  // Broadcast to all space members
  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_space_muted',
    userId: targetUserId,
    channelId: targetRoom.roomId,
    spaceId: meta.spaceId,
    muted,
  });
}

function handleVoiceSpaceDeafen(event: Record<string, unknown>, userId: string): void {
  const targetUserId = event.userId as string;
  const deafened = event.deafened === true;

  if (!targetUserId || typeof targetUserId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'userId is required' });
    return;
  }

  const targetRoom = connectionManager.getUserRoom(targetUserId);
  if (!targetRoom || targetRoom.room.roomType !== 'space') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target user is not in a voice channel' });
    return;
  }

  const meta = targetRoom.room.metadata as SpaceRoomMeta;
  if (!hasPermission(userId, meta.spaceId, PermissionBits.DEAFEN_MEMBERS, targetRoom.roomId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing DEAFEN_MEMBERS permission' });
    return;
  }

  if (targetUserId === userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Cannot space-deafen yourself' });
    return;
  }

  connectionManager.setSpaceDeafened(meta.spaceId, targetUserId, deafened);

  // Persist to DB
  const db = getDb();
  if (deafened) {
    db.insert(schema.voiceRestrictions).values({
      spaceId: meta.spaceId,
      userId: targetUserId,
      restrictionType: 'deafen',
      moderatorId: userId,
      createdAt: Date.now(),
    }).onConflictDoNothing().run();
  } else {
    db.delete(schema.voiceRestrictions).where(
      and(
        eq(schema.voiceRestrictions.spaceId, meta.spaceId),
        eq(schema.voiceRestrictions.userId, targetUserId),
        eq(schema.voiceRestrictions.restrictionType, 'deafen'),
      )
    ).run();
  }

  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_space_deafened',
    userId: targetUserId,
    channelId: targetRoom.roomId,
    spaceId: meta.spaceId,
    deafened,
  });
}

function handleVoiceMove(event: Record<string, unknown>, userId: string): void {
  const targetUserId = event.userId as string;
  const targetChannelId = event.targetChannelId as string;

  if (!targetUserId || typeof targetUserId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'userId is required' });
    return;
  }
  if (!targetChannelId || typeof targetChannelId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'targetChannelId is required' });
    return;
  }

  // Find the target user's current room
  const currentRoom = connectionManager.getUserRoom(targetUserId);
  if (!currentRoom || currentRoom.room.roomType !== 'space') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target user is not in a voice channel' });
    return;
  }

  const meta = currentRoom.room.metadata as SpaceRoomMeta;
  if (!hasPermission(userId, meta.spaceId, PermissionBits.MOVE_MEMBERS, currentRoom.roomId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing MOVE_MEMBERS permission' });
    return;
  }

  // Verify target channel exists and is a voice/video channel in the same space
  const db = getDb();
  const targetChannel = db.select().from(schema.channels).where(eq(schema.channels.id, targetChannelId)).get();
  if (!targetChannel || targetChannel.spaceId !== meta.spaceId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target channel not found in this space' });
    return;
  }
  if (targetChannel.type !== 'voice') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target channel is not a voice channel' });
    return;
  }
  if (targetChannelId === currentRoom.roomId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'User is already in that channel' });
    return;
  }

  const oldChannelId = currentRoom.roomId;

  // Leave current room
  connectionManager.leaveRoom(oldChannelId, targetUserId);

  // Broadcast leave from old channel
  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_state_update',
    channelId: oldChannelId,
    userId: targetUserId,
    action: 'leave',
  });

  // Lazy-create target room and join
  connectionManager.createRoom(targetChannelId, 'space', { type: 'space', spaceId: meta.spaceId });
  connectionManager.joinRoom(targetChannelId, targetUserId);

  // Broadcast join to new channel
  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_state_update',
    channelId: targetChannelId,
    userId: targetUserId,
    action: 'join',
  });

  // Notify the moved user so they reconnect to LiveKit
  connectionManager.sendToUser(targetUserId, {
    type: 'voice_moved',
    userId: targetUserId,
    oldChannelId,
    newChannelId: targetChannelId,
  });

  // Preserve voice user status during move
  const status = connectionManager.getVoiceUserStatus(targetUserId);
  if (status) {
    connectionManager.sendToRoom(targetChannelId, {
      type: 'voice_status_update',
      userId: targetUserId,
      channelId: targetChannelId,
      isMuted: status.isMuted,
      isDeafened: status.isDeafened,
      isCameraOn: status.isCameraOn,
      isScreenSharing: status.isScreenSharing,
    });
  }
}

function handleVoiceDisconnect(event: Record<string, unknown>, userId: string): void {
  const targetUserId = event.userId as string;

  if (!targetUserId || typeof targetUserId !== 'string') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'userId is required' });
    return;
  }

  if (targetUserId === userId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Cannot disconnect yourself' });
    return;
  }

  // Find the target user's current room
  const currentRoom = connectionManager.getUserRoom(targetUserId);
  if (!currentRoom || currentRoom.room.roomType !== 'space') {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Target user is not in a voice channel' });
    return;
  }

  const meta = currentRoom.room.metadata as SpaceRoomMeta;
  if (!hasPermission(userId, meta.spaceId, PermissionBits.DISCONNECT_MEMBERS, currentRoom.roomId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Missing DISCONNECT_MEMBERS permission' });
    return;
  }

  const channelId = currentRoom.roomId;

  // Remove from voice room
  connectionManager.leaveRoom(channelId, targetUserId);

  // Clear ephemeral voice status (mute/camera/etc)
  connectionManager.clearVoiceUserStatus(targetUserId);

  // Broadcast leave to all space members
  connectionManager.sendToSpace(meta.spaceId, {
    type: 'voice_state_update',
    channelId,
    userId: targetUserId,
    action: 'leave',
  });

  // Notify the disconnected user so they clean up client-side
  connectionManager.sendToUser(targetUserId, {
    type: 'voice_disconnected',
    userId: targetUserId,
    channelId,
  });
}
