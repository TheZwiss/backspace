import type { WebSocket } from 'ws';
import { eq, inArray, and } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { generateSnowflake } from '../utils/snowflake.js';
import { connectionManager } from './handler.js';
import type { VoiceRoom, DmRoomMeta, SpaceRoomMeta } from './handler.js';
import { isMember, getChannelSpaceId, isDmMember, hasPermission, computePermissions, PermissionBits } from '../utils/permissions.js';
import { broadcastDmMessage, getDmMessageWithUser } from '../routes/dm.js';
import { MAX_MESSAGE_LENGTH, type MessageWithUser, type Attachment, type DmMessageWithUser, type Embed, type Activity, type ActivityType, type ActivityTimestamps, type ActivityAssets, type ServerEvent, type DmCallUndeliverableFailure, type DmCallUndeliverableReason } from '@backspace/shared';
import type { CallRelayResult, CallFanoutFailure } from '../utils/federationOutbox.js';
import { mapCallReasonToEventReason } from '../utils/federationOutbox.js';
import { ACTIVITY_LIMITS } from '@backspace/shared/src/activities.js';
import { sanitizeUser } from '../utils/sanitize.js';
import { deleteAttachmentFiles } from '../utils/fileCleanup.js';
import { resolveEmbeds, reResolveEmbeds, embedRowToEmbed } from '../utils/embedResolver.js';
import { appendMutationLog, queueOutboxEvent, queueDmRelay, getGroupDmTargetOrigins, sendCallRelay, computeFederatedId, sendTypingRelay, queueReadStateRelay } from '../utils/federationOutbox.js';
import { getOurOrigin } from '../utils/federationAuth.js';
import { generateFederatedCallToken } from '../routes/livekit.js';
import { config } from '../config.js';
import crypto from 'node:crypto';

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
    width: a.width ?? null,
    height: a.height ?? null,
    duration: a.duration ?? null,
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
  ws: WebSocket,
  isFederated: boolean,
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
      handleVoiceJoin(event, userId, ws);
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
      handleReactionAdd(event, userId, isFederated);
      break;
    case 'reaction_remove':
      handleReactionRemove(event, userId, isFederated);
      break;
    case 'channel_ack':
      handleChannelAck(event, userId, isFederated);
      break;
    case 'mark_unread':
      handleMarkUnread(event, userId, isFederated);
      break;
    case 'dm_call_start':
      handleDmCallStart(event, userId, username, ws);
      break;
    case 'dm_call_accept':
      handleDmCallAccept(event, userId, ws).catch(err =>
        console.error('[ws] handleDmCallAccept error:', err),
      );
      break;
    case 'dm_call_reject':
      handleDmCallReject(event, userId).catch(err =>
        console.error('[ws] handleDmCallReject error:', err),
      );
      break;
    case 'dm_call_end':
      handleDmCallEnd(event, userId).catch(err =>
        console.error('[ws] handleDmCallEnd error:', err),
      );
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
    case 'activity_update':
      handleActivityUpdate(event, userId);
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

  // Delete old embeds synchronously so the broadcast reflects the edit
  db.delete(schema.embeds).where(eq(schema.embeds.messageId, messageId)).run();

  const updatedMessage = getMessageWithUser(messageId);
  if (updatedMessage) {
    connectionManager.sendToChannel(spaceId, message.channelId, {
      type: 'message_updated',
      message: updatedMessage,
    });

    // Resolve new embeds asynchronously (old ones already deleted above)
    setImmediate(() => {
      resolveEmbeds(messageId, content.trim(), message.channelId, false, spaceId).catch(() => {});
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

// ─── Activity Validation ──────────────────────────────────────────────────

const VALID_ACTIVITY_TYPES = new Set<string>(['custom', 'playing', 'listening', 'watching', 'streaming']);
const MAX_TIMESTAMP = 4102444800000;

function validateActivities(raw: unknown): Activity[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > ACTIVITY_LIMITS.MAX_ACTIVITIES_PER_USER) return null;

  const validated: Activity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    if (!VALID_ACTIVITY_TYPES.has(obj.type as string)) return null;
    if (typeof obj.name !== 'string') return null;
    if (obj.name.length === 0 || obj.name.length > ACTIVITY_LIMITS.MAX_NAME_LENGTH) return null;

    const activity: Activity = { type: obj.type as ActivityType, name: (obj.name as string).trim() };

    if (typeof obj.details === 'string' && obj.details.length <= ACTIVITY_LIMITS.MAX_DETAILS_LENGTH) activity.details = obj.details.trim();
    if (typeof obj.state === 'string' && obj.state.length <= ACTIVITY_LIMITS.MAX_STATE_LENGTH) activity.state = obj.state.trim();
    if (typeof obj.url === 'string' && obj.url.length <= ACTIVITY_LIMITS.MAX_URL_LENGTH) {
      if (obj.url.startsWith('https://') || obj.url.startsWith('http://')) activity.url = obj.url;
    }

    if (obj.timestamps && typeof obj.timestamps === 'object') {
      const tsObj = obj.timestamps as Record<string, unknown>;
      const ts: ActivityTimestamps = {};
      if (typeof tsObj.start === 'number' && tsObj.start >= 0 && tsObj.start <= MAX_TIMESTAMP) ts.start = tsObj.start;
      if (typeof tsObj.end === 'number' && tsObj.end >= 0 && tsObj.end <= MAX_TIMESTAMP) ts.end = tsObj.end;
      if (ts.start !== undefined || ts.end !== undefined) activity.timestamps = ts;
    }

    if (obj.assets && typeof obj.assets === 'object') {
      const aObj = obj.assets as Record<string, unknown>;
      const assets: ActivityAssets = {};
      if (typeof aObj.largeImage === 'string' && aObj.largeImage.length <= ACTIVITY_LIMITS.MAX_URL_LENGTH) assets.largeImage = aObj.largeImage;
      if (typeof aObj.largeText === 'string' && aObj.largeText.length <= ACTIVITY_LIMITS.MAX_ASSET_TEXT_LENGTH) assets.largeText = aObj.largeText;
      if (typeof aObj.smallImage === 'string' && aObj.smallImage.length <= ACTIVITY_LIMITS.MAX_URL_LENGTH) assets.smallImage = aObj.smallImage;
      if (typeof aObj.smallText === 'string' && aObj.smallText.length <= ACTIVITY_LIMITS.MAX_ASSET_TEXT_LENGTH) assets.smallText = aObj.smallText;
      if (Object.keys(assets).length > 0) activity.assets = assets;
    }

    validated.push(activity);
  }
  return validated;
}

function handlePresenceUpdate(event: Record<string, unknown>, userId: string): void {
  const status = event.status as string;

  if (!status || !['online', 'idle', 'dnd'].includes(status)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Status must be "online", "idle", or "dnd"' });
    return;
  }

  const db = getDb();
  db.update(schema.users).set({ status }).where(eq(schema.users.id, userId)).run();

  connectionManager.setUserStatus(userId, status);
  const activities = connectionManager.getUserActivities(userId);

  // Broadcast to all spaces user is in
  const userSpaces = connectionManager.getUserSpaces(userId);
  const payload = {
    type: 'presence_update' as const,
    userId,
    status,
    ...(activities.length > 0 ? { activities } : {}),
  };
  for (const spaceId of userSpaces) {
    connectionManager.sendToSpace(spaceId, payload, userId);
  }

  // Also send to self (other tabs)
  connectionManager.sendToUser(userId, payload);

  // S2S: project to all active peers
  void import('../utils/federationPresence.js').then(({ queuePresenceRelay }) => {
    try { queuePresenceRelay(userId, status as 'online' | 'idle' | 'dnd', activities); } catch (e) { console.warn('[ws] queuePresenceRelay(manual) failed', e); }
  });
}

function handleActivityUpdate(event: Record<string, unknown>, userId: string): void {
  if (!connectionManager.getUserShowActivity(userId)) return;
  if (!connectionManager.checkActivityRateLimit(userId)) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Activity update rate limited' });
    return;
  }

  const activities = validateActivities(event.activities);
  if (!activities) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'Invalid activity payload' });
    return;
  }

  connectionManager.setUserActivities(userId, activities);
  const status = connectionManager.getUserStatus(userId);

  const userSpaces = connectionManager.getUserSpaces(userId);
  const payload = { type: 'presence_update' as const, userId, status, activities };
  for (const spaceId of userSpaces) {
    connectionManager.sendToSpace(spaceId, payload, userId);
  }
  connectionManager.sendToUser(userId, payload);

  // S2S: project to all active peers (activities + current status).
  void import('../utils/federationPresence.js').then(({ queuePresenceRelay }) => {
    try { queuePresenceRelay(userId, status as 'online' | 'idle' | 'dnd' | 'offline', activities); } catch (e) { console.warn('[ws] queuePresenceRelay(activity) failed', e); }
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

function handleVoiceJoin(event: Record<string, unknown>, userId: string, ws: WebSocket): void {
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

  // ── Device switch guardrail ──
  // If this user already has a voice session on a different socket,
  // notify that socket to tear down its LiveKit connection.
  {
    const oldVoiceWs = connectionManager.getVoiceWs(userId);
    if (oldVoiceWs && oldVoiceWs !== ws) {
      const oldRoom = connectionManager.getUserRoom(userId);
      connectionManager.sendToWs(oldVoiceWs, {
        type: 'voice_disconnected',
        userId,
        channelId: oldRoom?.roomId ?? channelId,
        reason: 'displaced',
      });
    }
    connectionManager.setVoiceWs(userId, ws);
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
  connectionManager.clearVoiceWs(userId);
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

  // Federation: queue for relay
  queueDmRelay(dmMessage, dmChannelId, 'create');

  // Clear any pending typing timeout for this user+channel
  const typingKey = `dm:${userId}:${dmChannelId}`;
  const existingTimeout = typingTimeouts.get(typingKey);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    typingTimeouts.delete(typingKey);
  }

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

  // Relay typing indicator to remote peers (fire-and-forget)
  sendTypingRelay(dmChannelId, 'dm_typing_start', userId);

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

  // Delete old embeds synchronously so the broadcast reflects the edit
  db.delete(schema.embeds).where(eq(schema.embeds.dmMessageId, messageId)).run();

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

  // Federation: queue for relay
  queueDmRelay(updated, msg.dmChannelId, 'update');

  // Resolve new embeds asynchronously (old ones already deleted above)
  setImmediate(() => {
    resolveEmbeds(messageId, content.trim(), msg.dmChannelId, true, null).catch(() => {});
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

  // Delete attachments, reactions, and message atomically
  db.transaction((tx) => {
    tx.delete(schema.attachments)
      .where(eq(schema.attachments.dmMessageId, messageId))
      .run();
    tx.delete(schema.dmReactions)
      .where(eq(schema.dmReactions.dmMessageId, messageId))
      .run();
    tx.delete(schema.dmMessages)
      .where(eq(schema.dmMessages.id, messageId))
      .run();
  });

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

  // Federation: log mutation and queue for relay
  appendMutationLog(messageId, msg.dmChannelId, 'delete');
  const targetOrigins = getGroupDmTargetOrigins(msg.dmChannelId);
  queueOutboxEvent(messageId, msg.dmChannelId, 'delete', JSON.stringify({ deleted: true }), targetOrigins);
}

// ─── Reaction Handlers ─────────────────────────────────────────────────────

function handleReactionAdd(event: Record<string, unknown>, userId: string, isFederated: boolean): void {
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
  if (isFederated) return;
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

    // Federation: log reaction mutation and queue for relay
    const canonicalMessageId = dmMsg.sourceMessageId || messageId;
    const messageHomeInstance = dmMsg.sourceInstance || getOurOrigin();
    appendMutationLog(messageId, dmMsg.dmChannelId, 'reaction_add', JSON.stringify({
      userId,
      homeUserId: reactionUser?.homeUserId || userId,
      homeInstance: reactionUser?.homeInstance || getOurOrigin(),
      emoji,
      createdAt: now,
    }));
    const reactionAddTargetOrigins = getGroupDmTargetOrigins(dmMsg.dmChannelId);
    queueOutboxEvent(reactionId, dmMsg.dmChannelId, 'reaction_add', JSON.stringify({
      reaction: {
        messageId: canonicalMessageId,
        messageHomeInstance,
        userId,
        homeUserId: reactionUser?.homeUserId || userId,
        homeInstance: reactionUser?.homeInstance || getOurOrigin(),
        emoji,
        createdAt: now,
      },
    }), reactionAddTargetOrigins);
  } catch (err) {
    // Unique constraint violation (already reacted)
  }
}

function handleReactionRemove(event: Record<string, unknown>, userId: string, isFederated: boolean): void {
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
  if (isFederated) return;
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

    // Federation: log reaction removal and queue for relay
    const removingUser = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    const canonicalMessageId = dmMsg.sourceMessageId || messageId;
    const messageHomeInstance = dmMsg.sourceInstance || getOurOrigin();
    appendMutationLog(messageId, dmMsg.dmChannelId, 'reaction_remove', JSON.stringify({
      userId,
      homeUserId: removingUser?.homeUserId || userId,
      homeInstance: removingUser?.homeInstance || getOurOrigin(),
      emoji,
    }));
    const reactionRemoveTargetOrigins = getGroupDmTargetOrigins(dmMsg.dmChannelId);
    queueOutboxEvent(
      `${messageId}:${userId}:${emoji}`,
      dmMsg.dmChannelId,
      'reaction_remove',
      JSON.stringify({
        reaction: {
          messageId: canonicalMessageId,
          messageHomeInstance,
          userId,
          homeUserId: removingUser?.homeUserId || userId,
          homeInstance: removingUser?.homeInstance || getOurOrigin(),
          emoji,
        },
      }),
      reactionRemoveTargetOrigins,
    );
  }
}

// ─── Read State Handler ────────────────────────────────────────────────────

function handleChannelAck(event: Record<string, unknown>, userId: string, isFederated: boolean): void {
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

  // Relay read state to federated peers for cross-instance sync
  queueReadStateRelay(channelId, messageId, userId);
}

function handleMarkUnread(event: Record<string, unknown>, userId: string, isFederated: boolean): void {
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

  // Relay mark-unread to federated peers for cross-instance sync
  // (skip the '0' sentinel — it deletes the read state and can't be mapped to a message)
  if (messageId !== '0') {
    queueReadStateRelay(channelId, messageId, userId);
  }
}

// ─── DM Call Handlers (Unified Room API) ───────────────────────────────────

function handleDmCallStart(event: Record<string, unknown>, userId: string, username: string, ws: WebSocket): void {
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

  // Bind voice session to this socket so removeConnection can clean up
  // if the caller closes the tab while the call is ringing
  connectionManager.setVoiceWs(userId, ws);

  // Ring other members
  connectionManager.sendToDmMembers(dmChannelId, {
    type: 'dm_call_incoming',
    dmChannelId,
    callerId: userId,
    callerName: username,
  }, userId);

  // Federation: notify remote instances (fire-and-forget)
  sendFederatedCallStart(dmChannelId, userId, username)
    .catch(err => console.error('[federation] sendFederatedCallStart error:', err));
}

async function handleDmCallAccept(event: Record<string, unknown>, userId: string, ws: WebSocket): Promise<void> {
  let dmChannelId = (event.dmChannelId as string) || null;
  const federatedCallId = (event.federatedCallId as string) || null;
  if (!dmChannelId && !federatedCallId) {
    connectionManager.sendToUser(userId, { type: 'error', message: 'dmChannelId or federatedCallId is required' });
    return;
  }

  // Resolve federatedCallId → dmChannelId when only federatedCallId is provided.
  // This happens when a remote instance accepts via callOrigin and the DM doesn't
  // exist there (Path B), but the HOST has the VoiceRoom keyed by dmChannelId.
  if (!dmChannelId && federatedCallId) {
    const db = getDb();
    const ch = db.select({ id: schema.dmChannels.id })
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, federatedCallId))
      .get();
    if (ch) {
      dmChannelId = ch.id;
    }
  }

  // Path 1: Local room (we're the host) — only possible with dmChannelId
  if (dmChannelId) {
    if (!isDmMember(dmChannelId, userId)) {
      connectionManager.sendToUser(userId, { type: 'error', message: 'You are not a member of this DM channel' });
      return;
    }

    const room = connectionManager.getRoom(dmChannelId);
    if (room && room.roomType === 'dm') {
      const meta = room.metadata as DmRoomMeta;

      if (meta.state === 'ringing') {
        connectionManager.activateDmRoom(dmChannelId);
        const callerLeft = connectionManager.leaveCurrentRoom(meta.callerId);
        if (callerLeft) broadcastRoomLeave(callerLeft.roomId, callerLeft.room, meta.callerId);
        connectionManager.joinRoom(dmChannelId, meta.callerId);
        connectionManager.sendToDmMembers(dmChannelId, {
          type: 'voice_state_update',
          channelId: dmChannelId,
          userId: meta.callerId,
          action: 'join',
        });
      }

      const acceptorLeft = connectionManager.leaveCurrentRoom(userId);
      if (acceptorLeft) broadcastRoomLeave(acceptorLeft.roomId, acceptorLeft.room, userId);
      connectionManager.joinRoom(dmChannelId, userId);
      connectionManager.setVoiceWs(userId, ws);
      // Look up federatedId for the broadcast so all clients (including remote) can match
      const fedIdRow = getDb().select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
      connectionManager.sendToDmMembers(dmChannelId, {
        type: 'dm_call_accepted',
        dmChannelId,
        federatedCallId: fedIdRow?.federatedId ?? undefined,
      } as ServerEvent);
      connectionManager.sendToDmMembers(dmChannelId, {
        type: 'voice_state_update',
        channelId: dmChannelId,
        userId,
        action: 'join',
      });
      const acceptFanoutFailures = await sendFederatedCallAccept(dmChannelId, userId);
      emitFanoutUndeliverable(
        userId,
        dmChannelId,
        fedIdRow?.federatedId ?? null,
        'accept',
        acceptFanoutFailures,
      );
      return;
    }
  }

  // Path 2: Federated call (we're a remote instance)
  const fedCall = federatedCallId
    ? connectionManager.getFederatedCall(federatedCallId)
    : dmChannelId
      ? connectionManager.getFederatedCallByDmChannel(dmChannelId)
      : undefined;

  if (fedCall) {
    // Optimistic transition so the acceptor's client flips to active immediately.
    // Rolled back below if the relay to host fails.
    connectionManager.activateFederatedCall(fedCall.federatedId);
    connectionManager.sendToFederatedCallUsers(fedCall.federatedId, {
      type: 'dm_call_accepted',
      dmChannelId: fedCall.dmChannelId,
      federatedCallId: fedCall.federatedId,
    } as ServerEvent);

    const db = getDb();
    const user = db.select({ homeUserId: schema.users.homeUserId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    const homeUserId = user?.homeUserId || userId;

    const result = await sendCallRelay(fedCall.federatedCallHost, [{
      eventType: 'dm_call_accept',
      messageId: generateSnowflake(),
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: fedCall.federatedId,
      call: {
        acceptor: { homeUserId, homeInstance: getOurOrigin() },
      },
    }]);

    if (!result.ok) {
      console.error(`[federation] dm_call_accept relay to ${fedCall.federatedCallHost} failed (${result.reason}): ${result.error}`);
      const failure = buildFailureFromResult(result, fedCall.federatedCallHost, db);
      // Clear first so a concurrent end-handler sees a cleared entry (idempotent).
      connectionManager.clearFederatedCall(fedCall.federatedId);
      // Terminal targets ONLY the acceptor — other ringed users (group DM) didn't
      // accept and should stay in their ring state; their own dm_call_end / timeout
      // paths govern their teardown.
      connectionManager.sendToUser(userId, {
        type: 'dm_call_undeliverable',
        dmChannelId: fedCall.dmChannelId,
        federatedCallId: fedCall.federatedId,
        terminal: true,
        phase: 'accept',
        failures: [failure],
      });
    }
    return;
  }

  connectionManager.sendToUser(userId, { type: 'error', message: 'No active call in this DM channel' });
}

async function handleDmCallReject(event: Record<string, unknown>, userId: string): Promise<void> {
  let dmChannelId = (event.dmChannelId as string) || null;
  const federatedCallId = (event.federatedCallId as string) || null;

  if (!dmChannelId && !federatedCallId) return;

  // Resolve federatedCallId → dmChannelId for host VoiceRoom lookup
  if (!dmChannelId && federatedCallId) {
    const db = getDb();
    const ch = db.select({ id: schema.dmChannels.id })
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, federatedCallId))
      .get();
    if (ch) dmChannelId = ch.id;
  }

  // Path 1: Local room (we're the host)
  if (dmChannelId) {
    if (!isDmMember(dmChannelId, userId)) return;

    const room = connectionManager.getRoom(dmChannelId);
    if (room) {
      const meta = room.metadata as DmRoomMeta;
      connectionManager.clearVoiceWs(meta.callerId);
      connectionManager.destroyRoom(dmChannelId);
      connectionManager.sendToDmMembers(dmChannelId, { type: 'dm_call_rejected', dmChannelId });
      const fedIdRejectRow = getDb().select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
      const rejectFanoutFailures = await sendFederatedCallEnd(dmChannelId, userId);
      emitFanoutUndeliverable(
        userId,
        dmChannelId,
        fedIdRejectRow?.federatedId ?? null,
        'reject',
        rejectFanoutFailures,
      );
      return;
    }
  }

  // Path 2: Federated call
  const fedCall = federatedCallId
    ? connectionManager.getFederatedCall(federatedCallId)
    : dmChannelId
      ? connectionManager.getFederatedCallByDmChannel(dmChannelId)
      : undefined;

  if (fedCall) {
    // Optimistic local clear — user intent is to reject.
    connectionManager.sendToFederatedCallUsers(fedCall.federatedId, {
      type: 'dm_call_rejected',
      dmChannelId: fedCall.dmChannelId,
      federatedCallId: fedCall.federatedId,
    } as ServerEvent, userId);
    const host = fedCall.federatedCallHost;
    const fedId = fedCall.federatedId;
    const dmId = fedCall.dmChannelId;
    connectionManager.clearFederatedCall(fedId);

    const db = getDb();
    const user = db.select({ homeUserId: schema.users.homeUserId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    const homeUserId = user?.homeUserId || userId;

    const result = await sendCallRelay(host, [{
      eventType: 'dm_call_reject',
      messageId: generateSnowflake(),
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: fedId,
      call: {
        rejector: { homeUserId, homeInstance: getOurOrigin() },
      },
    }]);

    if (!result.ok) {
      console.error(`[federation] dm_call_reject relay to ${host} failed (${result.reason}): ${result.error}`);
      const failure = buildFailureFromResult(result, host, db);
      connectionManager.sendToUser(userId, {
        type: 'dm_call_undeliverable',
        dmChannelId: dmId,
        federatedCallId: fedId,
        terminal: false,
        phase: 'reject',
        failures: [failure],
      });
    }
  }
}

async function handleDmCallEnd(event: Record<string, unknown>, userId: string): Promise<void> {
  let dmChannelId = (event.dmChannelId as string) || null;
  const federatedCallId = (event.federatedCallId as string) || null;

  if (!dmChannelId && !federatedCallId) return;

  // Resolve federatedCallId → dmChannelId for host VoiceRoom lookup
  if (!dmChannelId && federatedCallId) {
    const db = getDb();
    const ch = db.select({ id: schema.dmChannels.id })
      .from(schema.dmChannels)
      .where(eq(schema.dmChannels.federatedId, federatedCallId))
      .get();
    if (ch) dmChannelId = ch.id;
  }

  // Path 1: Local room (we're the host)
  if (dmChannelId) {
    if (!isDmMember(dmChannelId, userId)) return;

    const room = connectionManager.getRoom(dmChannelId);
    if (room) {
      const meta = room.metadata as DmRoomMeta;
      connectionManager.clearVoiceWs(meta.callerId);
      for (const participantId of room.participants) {
        connectionManager.clearVoiceUserStatus(participantId);
        connectionManager.clearVoiceWs(participantId);
      }
      const fedIdEndRow = getDb().select({ federatedId: schema.dmChannels.federatedId })
        .from(schema.dmChannels).where(eq(schema.dmChannels.id, dmChannelId)).get();
      connectionManager.destroyRoom(dmChannelId);
      connectionManager.sendToDmMembers(dmChannelId, { type: 'dm_call_ended', dmChannelId });
      const endFanoutFailures = await sendFederatedCallEnd(dmChannelId, userId);
      emitFanoutUndeliverable(
        userId,
        dmChannelId,
        fedIdEndRow?.federatedId ?? null,
        'end',
        endFanoutFailures,
      );
      return;
    }
  }

  // Path 2: Federated call
  const fedCall = federatedCallId
    ? connectionManager.getFederatedCall(federatedCallId)
    : dmChannelId
      ? connectionManager.getFederatedCallByDmChannel(dmChannelId)
      : undefined;

  if (fedCall) {
    // Exclude the user who ended the call — they already disconnected client-side.
    connectionManager.sendToFederatedCallUsers(fedCall.federatedId, {
      type: 'dm_call_ended',
      dmChannelId: fedCall.dmChannelId,
      federatedCallId: fedCall.federatedId,
    } as ServerEvent, userId);
    const host = fedCall.federatedCallHost;
    const fedId = fedCall.federatedId;
    const dmId = fedCall.dmChannelId;
    connectionManager.clearFederatedCall(fedId);

    const db = getDb();
    const user = db.select({ homeUserId: schema.users.homeUserId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get();
    const homeUserId = user?.homeUserId || userId;

    const result = await sendCallRelay(host, [{
      eventType: 'dm_call_end',
      messageId: generateSnowflake(),
      encryptionVersion: 0,
      timestamp: Date.now(),
      federatedId: fedId,
      call: {
        endedBy: { homeUserId, homeInstance: getOurOrigin() },
      },
    }]);

    if (!result.ok) {
      console.error(`[federation] dm_call_end relay to ${host} failed (${result.reason}): ${result.error}`);
      const failure = buildFailureFromResult(result, host, db);
      connectionManager.sendToUser(userId, {
        type: 'dm_call_undeliverable',
        dmChannelId: dmId,
        federatedCallId: fedId,
        terminal: false,
        phase: 'end',
        failures: [failure],
      });
    }
  }
}

/**
 * Send S2S dm_call_start to all remote instances with DM members.
 * Fire-and-forget per relay, but aggregates per-peer results to surface
 * undeliverable calls via `dm_call_undeliverable` to the caller.
 */
async function sendFederatedCallStart(
  dmChannelId: string,
  callerId: string,
  callerName: string,
): Promise<void> {
  const db = getDb();
  const ourOrigin = getOurOrigin();

  // Look up DM channel for federatedId
  const channel = db.select({
    federatedId: schema.dmChannels.federatedId,
    ownerId: schema.dmChannels.ownerId,
  })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();

  if (!channel) return;

  // Get all DM members with their user records
  const members = db.select({
    userId: schema.dmMembers.userId,
    homeUserId: schema.users.homeUserId,
    homeInstance: schema.users.homeInstance,
    username: schema.users.username,
    displayName: schema.users.displayName,
  })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  // Compute or reuse federatedId
  let federatedId = channel.federatedId;
  if (!federatedId) {
    if (!channel.ownerId) {
      const callerMember = members.find(m => m.userId === callerId);
      const otherMember = members.find(m => m.userId !== callerId);
      if (!callerMember || !otherMember) return;
      federatedId = computeFederatedId(
        callerMember.homeUserId || callerMember.userId,
        otherMember.homeUserId || otherMember.userId,
      );
    } else {
      federatedId = crypto.randomUUID();
    }
    db.update(schema.dmChannels)
      .set({ federatedId })
      .where(eq(schema.dmChannels.id, dmChannelId))
      .run();
  }

  // Classify members relative to this instance.
  const remoteMembers = members.filter(m => {
    if (!m.homeInstance) return false;
    const normalized = m.homeInstance.startsWith('http') ? m.homeInstance : `https://${m.homeInstance}`;
    return normalized !== ourOrigin;
  });
  const localNonCallerMembers = members.filter(m => {
    if (m.userId === callerId) return false;
    const home = m.homeInstance
      ? (m.homeInstance.startsWith('http') ? m.homeInstance : `https://${m.homeInstance}`)
      : ourOrigin;
    return home === ourOrigin;
  });
  const hasConnectedLocalRingee = localNonCallerMembers.some(m =>
    connectionManager.isUserOnline(m.userId),
  );

  // ─── LiveKit pre-flight ────────────────────────────────────────────────────
  if ((!config.livekit.apiKey || !config.livekit.apiSecret) && remoteMembers.length > 0) {
    console.warn('[federation] Cannot start federated call: LiveKit not configured');
    emitUndeliverableAndMaybeDestroy({
      callerId,
      dmChannelId,
      federatedId,
      terminal: !hasConnectedLocalRingee,
      failures: [{ reason: 'livekit_unavailable' }],
    });
    return;
  }

  // Use the configured LiveKit URL (wss://domain/livekit from .env).
  // Previously this was `https://${config.domain}/livekit` which fails because
  // the LiveKit SDK requires a wss:// WebSocket URL, not https://.
  const livekitUrl = config.livekit.url ?? `wss://${config.domain}/livekit`;

  // Build participants array (all member identities for Path B)
  const participants = members.map(m => ({
    homeUserId: m.homeUserId || m.userId,
    homeInstance: m.homeInstance || ourOrigin,
    displayName: m.displayName || m.username,
  }));

  // Generate tokens for ALL members upfront
  const allTokens: Record<string, string> = {};
  for (const m of members) {
    const homeUserId = m.homeUserId || m.userId;
    const name = m.displayName || m.username;
    allTokens[homeUserId] = await generateFederatedCallToken(federatedId, homeUserId, name);
  }

  const callerHomeUserId = members.find(m => m.userId === callerId)?.homeUserId || callerId;

  // Build the relay event template (reused for all peers)
  const buildRelayEvent = () => ({
    eventType: 'dm_call_start' as const,
    messageId: generateSnowflake(),
    encryptionVersion: 0 as const,
    timestamp: Date.now(),
    federatedId,
    call: {
      livekitUrl,
      tokens: allTokens,
      caller: {
        homeUserId: callerHomeUserId,
        homeInstance: ourOrigin,
        displayName: callerName,
      },
      participants,
    },
  });

  // Group remote members by home instance (targeted peers)
  const targetedPeers = new Map<string, string[]>();
  for (const m of remoteMembers) {
    const origin = m.homeInstance!.startsWith('http') ? m.homeInstance! : `https://${m.homeInstance!}`;
    const bucket = targetedPeers.get(origin) ?? [];
    bucket.push(m.userId);
    targetedPeers.set(origin, bucket);
  }

  // Single query for all peers — derives both active-peer list and label map
  const peerRows = db.select({
    origin: schema.federationPeers.origin,
    instanceName: schema.federationPeers.instanceName,
    status: schema.federationPeers.status,
  })
    .from(schema.federationPeers)
    .all();

  const allPeers = peerRows.filter(r => r.status === 'active');

  const peerLabelByOrigin = new Map<string, string>();
  for (const row of peerRows) {
    if (row.instanceName) peerLabelByOrigin.set(row.origin, row.instanceName);
  }

  // ─── Targeted relay: fan out in parallel, await results ────────────────────
  // Each peer's result has THREE possible classifications:
  //   ok=true, messageId NOT in undeliverable → delivered
  //   ok=true, messageId IN undeliverable     → new: no_recipient failure (#18)
  //   ok=false                                → existing failure reasons
  const targetedResults = await Promise.all(
    Array.from(targetedPeers.keys()).map(async peerOrigin => {
      const relayEvent = buildRelayEvent();
      const result = await sendCallRelay(peerOrigin, [relayEvent]);
      if (result.ok) {
        if (result.undeliverable.includes(relayEvent.messageId)) {
          console.warn(`[federation] dm_call_start to ${peerOrigin}: remote had no recipient`);
          return {
            origin: peerOrigin,
            ok: false as const,
            reason: 'no_recipient' as const satisfies DmCallUndeliverableReason,
            error: 'remote reported no_recipient',
          };
        }
        return { origin: peerOrigin, ok: true as const };
      }
      const reason = mapCallReasonToEventReason(result.reason);
      console.error(`[federation] dm_call_start to ${peerOrigin} failed (${result.reason}): ${result.error}`);
      return { origin: peerOrigin, ok: false as const, reason, error: result.error };
    }),
  );

  // ─── All-peers broadcast: fire-and-forget; failures NOT surfaced ───────────
  for (const peer of allPeers) {
    if (targetedPeers.has(peer.origin)) continue;
    if (peer.origin === ourOrigin) continue;
    sendCallRelay(peer.origin, [buildRelayEvent()]).then(result => {
      if (!result.ok) {
        console.debug(`[federation] All-peers dm_call_start to ${peer.origin}: ${result.reason} ${result.error}`);
      }
    }).catch(err => console.warn('[federation] all-peers broadcast threw:', err));
  }

  // ─── Aggregate failures → dm_call_undeliverable ───────────────────────────
  const failedTargeted = targetedResults.filter(
    (r): r is Extract<typeof r, { ok: false }> => !r.ok,
  );
  if (failedTargeted.length === 0) return;

  const anyTargetedSuccess = targetedResults.some(r => r.ok);
  const plausibleRecipientRemains = anyTargetedSuccess || hasConnectedLocalRingee;

  const failures: DmCallUndeliverableFailure[] = failedTargeted.map(r => {
    const affectedUserIds = targetedPeers.get(r.origin) ?? [];
    return {
      reason: r.reason,
      peerOrigin: r.origin,
      peerLabel: peerLabelByOrigin.get(r.origin),
      affectedUserIds,
    };
  });

  emitUndeliverableAndMaybeDestroy({
    callerId,
    dmChannelId,
    federatedId,
    terminal: !plausibleRecipientRemains,
    failures,
  });
}

/** Build a DmCallUndeliverableFailure from a failed CallRelayResult, enriching with peer label. */
function buildFailureFromResult(
  result: Extract<CallRelayResult, { ok: false }>,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
): DmCallUndeliverableFailure {
  const label = db.select({ instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, peerOrigin))
    .get()?.instanceName;
  return {
    reason: mapCallReasonToEventReason(result.reason),
    peerOrigin,
    peerLabel: label ?? undefined,
  };
}


/**
 * Emit dm_call_undeliverable to the caller. If terminal, also destroy the
 * local ring room (which clears the ringing timer and voice WS binding)
 * and broadcast dm_call_ended to non-caller DM members, mirroring the
 * 60s auto-timeout's cleanup semantics (handler.ts:414-424) so any
 * ringing client (e.g., a Connection WS from another instance) exits
 * the ring state instead of hanging.
 *
 * Guard: if the caller already cancelled mid-race, the room is already
 * gone — do NOT emit a phantom "could not reach" toast.
 */
function emitUndeliverableAndMaybeDestroy(args: {
  callerId: string;
  dmChannelId: string;
  federatedId: string;
  terminal: boolean;
  failures: DmCallUndeliverableFailure[];
}): void {
  const { callerId, dmChannelId, federatedId, terminal, failures } = args;

  // Caller may have cancelled mid-race. If the room is gone, move on silently.
  const room = connectionManager.getRoom(dmChannelId);
  if (!room) return;

  if (terminal) {
    connectionManager.clearVoiceWs(callerId);
    connectionManager.destroyRoom(dmChannelId);
    connectionManager.sendToDmMembers(dmChannelId, {
      type: 'dm_call_ended',
      dmChannelId,
    }, callerId);
  }

  connectionManager.sendToUser(callerId, {
    type: 'dm_call_undeliverable',
    dmChannelId,
    federatedCallId: federatedId,
    terminal,
    phase: 'start',
    failures,
  });
}

/**
 * Emit a non-terminal dm_call_undeliverable to the local user whose Path-1 action
 * (accept / reject / end) had one or more fan-out failures reach peers.
 * No-op when there were no failures or no federatedId to reference.
 */
function emitFanoutUndeliverable(
  userId: string,
  dmChannelId: string | null,
  federatedId: string | null | undefined,
  phase: 'accept' | 'reject' | 'end',
  fanoutFailures: CallFanoutFailure[],
): void {
  if (fanoutFailures.length === 0 || !federatedId) return;
  const failures: DmCallUndeliverableFailure[] = fanoutFailures.map(f => ({
    reason: f.reason,
    peerOrigin: f.origin,
    peerLabel: f.peerLabel,
  }));
  connectionManager.sendToUser(userId, {
    type: 'dm_call_undeliverable',
    dmChannelId,
    federatedCallId: federatedId,
    terminal: false,
    phase,
    failures,
  });
}

async function sendFederatedCallAccept(
  dmChannelId: string,
  acceptorUserId: string,
): Promise<CallFanoutFailure[]> {
  const db = getDb();
  const channel = db.select({ federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();
  if (!channel?.federatedId) return [];

  const members = db.select({ homeInstance: schema.users.homeInstance })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  const ourOrigin = getOurOrigin();
  const targets = new Set<string>();
  for (const m of members) {
    if (m.homeInstance) {
      const normalized = m.homeInstance.startsWith('http') ? m.homeInstance : `https://${m.homeInstance}`;
      if (normalized !== ourOrigin) targets.add(normalized);
    }
  }
  if (targets.size === 0) return [];

  const user = db.select({ homeUserId: schema.users.homeUserId })
    .from(schema.users)
    .where(eq(schema.users.id, acceptorUserId))
    .get();
  const homeUserId = user?.homeUserId || acceptorUserId;

  const event = {
    eventType: 'dm_call_accept' as const,
    messageId: generateSnowflake(),
    encryptionVersion: 0 as const,
    timestamp: Date.now(),
    federatedId: channel.federatedId,
    call: {
      acceptor: { homeUserId, homeInstance: ourOrigin },
    },
  };

  const labelByOrigin = new Map<string, string | null>();
  for (const r of db.select({ origin: schema.federationPeers.origin, instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .all()) {
    labelByOrigin.set(r.origin, r.instanceName ?? null);
  }

  const results = await Promise.all(
    Array.from(targets).map(async origin => ({ origin, result: await sendCallRelay(origin, [event]) })),
  );

  const failures: CallFanoutFailure[] = [];
  for (const { origin, result } of results) {
    if (!result.ok) {
      console.error(`[federation] dm_call_accept fanout to ${origin} failed (${result.reason}): ${result.error}`);
      failures.push({
        origin,
        peerLabel: labelByOrigin.get(origin) ?? undefined,
        reason: mapCallReasonToEventReason(result.reason),
      });
    }
  }
  return failures;
}

async function sendFederatedCallEnd(
  dmChannelId: string,
  endedByUserId: string,
): Promise<CallFanoutFailure[]> {
  const db = getDb();
  const channel = db.select({ federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();
  if (!channel?.federatedId) return [];

  const members = db.select({ homeInstance: schema.users.homeInstance })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();

  const ourOrigin = getOurOrigin();
  const targets = new Set<string>();
  for (const m of members) {
    if (m.homeInstance) {
      const normalized = m.homeInstance.startsWith('http') ? m.homeInstance : `https://${m.homeInstance}`;
      if (normalized !== ourOrigin) targets.add(normalized);
    }
  }
  if (targets.size === 0) return [];

  const endUser = db.select({ homeUserId: schema.users.homeUserId })
    .from(schema.users)
    .where(eq(schema.users.id, endedByUserId))
    .get();
  const resolvedHomeUserId = endUser?.homeUserId || endedByUserId;

  const event = {
    eventType: 'dm_call_end' as const,
    messageId: generateSnowflake(),
    encryptionVersion: 0 as const,
    timestamp: Date.now(),
    federatedId: channel.federatedId,
    call: {
      endedBy: { homeUserId: resolvedHomeUserId, homeInstance: ourOrigin },
    },
  };

  const labelByOrigin = new Map<string, string | null>();
  for (const r of db.select({ origin: schema.federationPeers.origin, instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .all()) {
    labelByOrigin.set(r.origin, r.instanceName ?? null);
  }

  const results = await Promise.all(
    Array.from(targets).map(async origin => ({ origin, result: await sendCallRelay(origin, [event]) })),
  );

  const failures: CallFanoutFailure[] = [];
  for (const { origin, result } of results) {
    if (!result.ok) {
      console.error(`[federation] dm_call_end fanout to ${origin} failed (${result.reason}): ${result.error}`);
      failures.push({
        origin,
        peerLabel: labelByOrigin.get(origin) ?? undefined,
        reason: mapCallReasonToEventReason(result.reason),
      });
    }
  }
  return failures;
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
  connectionManager.clearVoiceWs(targetUserId);

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

/**
 * Register the ring-timeout fan-out so a host-side 60s auto-clean notifies remote peers.
 * Called from server startup; split from module-load to keep test isolation clean
 * (tests that exercise ring timeouts can register their own stub via
 * `connectionManager.setRingTimeoutFanoutHook`).
 */
export function registerCallRelayHooks(): void {
  connectionManager.setRingTimeoutFanoutHook(async (dmChannelId, callerId) => {
    const failures = await sendFederatedCallEnd(dmChannelId, callerId);
    if (failures.length > 0) {
      console.warn('[federation] Ring-timeout fan-out had failures:', failures);
    }
  });
}

// ─── Test-only exports ──────────────────────────────────────────────────────
/** Direct export for unit tests — do not use in production code paths. */
export const handleDmCallAcceptForTest = handleDmCallAccept;
export const handleDmCallRejectForTest = handleDmCallReject;
export const handleDmCallEndForTest = handleDmCallEnd;
export const sendFederatedCallStartForTest = sendFederatedCallStart;
