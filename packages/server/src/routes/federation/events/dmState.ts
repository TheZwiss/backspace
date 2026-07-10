import { getDb, schema } from '../../../db/index.js';
import { getOurOrigin } from '../../../utils/federationAuth.js';
import { collectProfileBroadcastTargetIds } from '../../../utils/userDeletion.js';
import { connectionManager } from '../../../ws/handler.js';
import { getDmMessageWithUser } from '../../dm.js';
import { and, eq, isNull } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';
import { buildDmChannelPayload } from '../dmChannels.js';
import { extractDomain, resolveLocalUser } from '../identity.js';

export function processFileRejectedEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  // FED-010: file_rejected is a system event from the rejecting peer — no user attribution to verify
  if (!event.attachmentId || !event.rejectionReason) {
    rejected.push({ messageId: event.messageId, reason: 'missing_file_rejected_payload' });
    return;
  }

  // event.messageId is the original local message ID on THIS (sender) instance
  const localMsg = db.select()
    .from(schema.dmMessages)
    .where(eq(schema.dmMessages.id, event.messageId))
    .get();

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'message_not_found' });
    return;
  }

  // Find the attachment — try by sourceUrl matching, then by checking all attachments on the message
  const messageAttachments = db.select()
    .from(schema.attachments)
    .where(eq(schema.attachments.dmMessageId, localMsg.id))
    .all();

  // Match by filename from the sourceUrl — the remote sends the filename portion
  // (e.g., "12345.png") which matches our local attachment's filename.
  let matchedAttachment = event.sourceFilename
    ? messageAttachments.find(a => a.filename === event.sourceFilename)
    : undefined;

  // Fallback: if only one attachment, use it directly
  if (!matchedAttachment && messageAttachments.length === 1) {
    matchedAttachment = messageAttachments[0];
  }

  if (!matchedAttachment) {
    rejected.push({ messageId: event.messageId, reason: 'attachment_not_found' });
    return;
  }

  // Resolve affected user IDs to local usernames
  const affectedUsers: Array<{ userId: string; username: string; limit: number }> = [];
  for (const remoteUserId of (event.affectedUserIds ?? [])) {
    // These are homeUserIds — find the replicated user stub
    const user = db.select()
      .from(schema.users)
      .where(eq(schema.users.homeUserId, remoteUserId))
      .get();
    if (user) {
      affectedUsers.push({
        userId: user.id,
        username: user.displayName || user.username,
        limit: event.rejectionLimit ?? 0,
      });
    }
  }

  if (affectedUsers.length === 0) {
    // Fallback: if we can't resolve usernames, still accept the event
    // but skip the UI update since we can't show meaningful info
    accepted.push(event.messageId);
    return;
  }

  // Merge into federation_meta — accumulate rejections from multiple peers
  let existingMeta: Array<{ userId: string; username: string; limit: number }> = [];
  if (matchedAttachment.federationMeta) {
    try {
      const parsed = JSON.parse(matchedAttachment.federationMeta);
      existingMeta = Array.isArray(parsed) ? parsed : [];
    } catch { /* ignore parse errors */ }
  }

  // Add new affected users, avoiding duplicates by userId
  const existingUserIds = new Set(existingMeta.map(u => u.userId));
  for (const user of affectedUsers) {
    if (!existingUserIds.has(user.userId)) {
      existingMeta.push(user);
    }
  }

  // Update attachment
  db.update(schema.attachments)
    .set({
      federationStatus: 'remote_partial',
      federationMeta: JSON.stringify(existingMeta),
    })
    .where(eq(schema.attachments.id, matchedAttachment.id))
    .run();

  // Broadcast dm_message_updated to all DM members (persistent indicator)
  const updatedMsg = getDmMessageWithUser(localMsg.id);
  if (updatedMsg) {
    connectionManager.sendToDmMembers(updatedMsg.dmChannelId, {
      type: 'dm_message_updated',
      message: updatedMsg,
    });

    // Send targeted toast event to the message author only
    connectionManager.sendToUser(localMsg.userId, {
      type: 'federation_file_rejected',
      messageId: localMsg.id,
      dmChannelId: localMsg.dmChannelId,
      attachmentId: matchedAttachment.id,
      affectedUsers,
    });
  }

  accepted.push(event.messageId);
}

// ─── DM Call Relay Processors ─────────────────────────────────────────────────


/**
 * Inbound presence_update relay handler.
 *
 * Authority: home instance is exclusive. payload.homeInstance domain MUST equal
 * the source peer's domain (attribution check, mirrors profile_update).
 *
 * Effect on success:
 *   1. Update the local stub's status column.
 *   2. Broadcast a WS presence_update to local users via collectProfileBroadcastTargetIds
 *      (friends + DM members + space co-members), so the green dot updates without a
 *      page refresh on every connected client that knows this user.
 *
 * Edge cases:
 *   - No local replica → silently accept (peer broadcasts presence to all peers,
 *     not all peers have a stub).
 *   - homeInstance domain mismatch on the existing stub → ignore (collision against
 *     a stub of a different identity).
 *   - Invalid status string → reject; sender is buggy, surface for diagnosis.
 */
export function processPresenceUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  const payload = event.presenceUpdate;
  if (!payload) {
    rejected.push({ messageId: event.messageId, reason: 'missing_presence_update_payload' });
    return;
  }

  const payloadDomain = extractDomain(payload.homeInstance);
  const sourceDomain = extractDomain(sourceInstance);
  if (payloadDomain !== sourceDomain) {
    console.warn(`[federation] Attribution mismatch in presence_update: homeInstance=${payloadDomain} source=${sourceDomain}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  if (!payload.status || !['online', 'idle', 'dnd', 'offline'].includes(payload.status)) {
    rejected.push({ messageId: event.messageId, reason: 'invalid_status' });
    return;
  }

  const localUser = db
    .select()
    .from(schema.users)
    .where(and(
      eq(schema.users.homeUserId, payload.homeUserId),
      eq(schema.users.isDeleted, 0),
    ))
    .get();

  if (!localUser) {
    accepted.push(event.messageId);
    return;
  }

  if (localUser.homeInstance && extractDomain(localUser.homeInstance) !== payloadDomain) {
    accepted.push(event.messageId);
    return;
  }

  // Detached accounts are sovereign: the domain now belongs to a different
  // incarnation, which must never flip the established account's presence by
  // replaying its old homeUserId. Ack (not reject) — the sender considers this
  // identity theirs to update; from our side the update simply no-ops.
  if (localUser.federationHomeOrphaned === 1) {
    console.log(`[federation] Skipping presence_update for detached account ${localUser.id} (home-orphaned)`);
    accepted.push(event.messageId);
    return;
  }

  db.update(schema.users)
    .set({ status: payload.status })
    .where(eq(schema.users.id, localUser.id))
    .run();

  // Broadcast presence_update WS event to local users who care.
  const targetUserIds = collectProfileBroadcastTargetIds(localUser.id);
  const wsPayload = {
    type: 'presence_update' as const,
    userId: localUser.id,
    status: payload.status,
    ...(payload.activities && payload.activities.length > 0 ? { activities: payload.activities } : {}),
  };
  for (const uid of targetUserIds) {
    connectionManager.sendToUser(uid, wsPayload);
  }

  accepted.push(event.messageId);
}

// ─── Dead-Incarnation Startup Sweep ─────────────────────────────────────────


export function processReadStateUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.readState) {
    rejected.push({ messageId: event.messageId, reason: 'missing_read_state_payload' });
    return;
  }

  // Find the local DM channel by federatedId
  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
    return;
  }

  // Resolve the user locally
  const localUser = resolveLocalUser(event.readState.user.homeUserId, db);
  if (!localUser) {
    rejected.push({ messageId: event.messageId, reason: 'user_not_found' });
    return;
  }

  // Translate messageRef to a local message ID
  const { sourceInstance: refSource, sourceMessageId: refId } = event.readState.messageRef;
  let localMessageId: string;

  const ourOrigin = getOurOrigin();
  if (extractDomain(refSource) === extractDomain(ourOrigin)) {
    // The message originated on this instance — refId IS our local ID
    localMessageId = refId;
  } else {
    // Look up the relayed copy by source coordinates
    const localMsg = db.select({ id: schema.dmMessages.id })
      .from(schema.dmMessages)
      .where(and(
        eq(schema.dmMessages.sourceInstance, refSource),
        eq(schema.dmMessages.sourceMessageId, refId),
      ))
      .get();

    if (!localMsg) {
      // Message relay hasn't arrived yet — silently discard
      accepted.push(event.messageId);
      return;
    }
    localMessageId = localMsg.id;
  }

  // Write/update read state using timestamp-only LWW
  const existing = db.select()
    .from(schema.readStates)
    .where(and(
      eq(schema.readStates.userId, localUser.id),
      eq(schema.readStates.channelId, channel.id),
    ))
    .get();

  if (existing) {
    if (event.timestamp > existing.updatedAt) {
      db.update(schema.readStates)
        .set({ lastReadMessageId: localMessageId, updatedAt: event.timestamp })
        .where(and(
          eq(schema.readStates.userId, localUser.id),
          eq(schema.readStates.channelId, channel.id),
        ))
        .run();
    }
  } else {
    db.insert(schema.readStates).values({
      userId: localUser.id,
      channelId: channel.id,
      lastReadMessageId: localMessageId,
      updatedAt: event.timestamp,
    }).run();
  }

  // Echo channel_ack to the user's local WebSocket connections (multi-tab sync)
  connectionManager.sendToUser(localUser.id, {
    type: 'channel_ack',
    channelId: channel.id,
    messageId: localMessageId,
  });

  accepted.push(event.messageId);
}


export function processDmCloseEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.dmCloseReopen) {
    rejected.push({ messageId: event.messageId, reason: 'missing_dm_close_payload' });
    return;
  }

  // Find the local DM channel by federatedId
  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    // Channel doesn't exist locally — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Resolve the user locally
  const localUser = resolveLocalUser(event.dmCloseReopen.homeUserId, db);
  if (!localUser) {
    // User not found locally — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Verify user is a DM member
  const membership = db.select()
    .from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .get();

  if (!membership) {
    // Not a member — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Set closed = 1
  db.update(schema.dmMembers)
    .set({ closed: 1 })
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .run();

  // Broadcast dm_channel_closed to local connections of this user
  connectionManager.sendToUser(localUser.id, {
    type: 'dm_channel_closed',
    dmChannelId: channel.id,
  });

  accepted.push(event.messageId);
}


export function processDmReopenEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.dmCloseReopen) {
    rejected.push({ messageId: event.messageId, reason: 'missing_dm_reopen_payload' });
    return;
  }

  // Find the local DM channel by federatedId
  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    // Channel doesn't exist locally — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Resolve the user locally
  const localUser = resolveLocalUser(event.dmCloseReopen.homeUserId, db);
  if (!localUser) {
    // User not found locally — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Verify user is a DM member
  const membership = db.select()
    .from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .get();

  if (!membership) {
    // Not a member — silently accept
    accepted.push(event.messageId);
    return;
  }

  // Set closed = 0
  db.update(schema.dmMembers)
    .set({ closed: 0 })
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .run();

  // Build full DM channel payload and broadcast dm_channel_created
  const payload = buildDmChannelPayload(channel.id, db);
  if (payload) {
    connectionManager.sendToUser(localUser.id, {
      type: 'dm_channel_created',
      dmChannel: payload,
    });
  }

  accepted.push(event.messageId);
}
