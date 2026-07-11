import path from 'node:path';
import { getDb, schema } from '../../../db/index.js';
import { computeFederatedId } from '../../../utils/federationOutbox.js';
import { deleteAttachmentFiles } from '../../../utils/fileCleanup.js';
import { sanitizeUser } from '../../../utils/sanitize.js';
import { generateSnowflake } from '../../../utils/snowflake.js';
import { connectionManager } from '../../../ws/handler.js';
import { getDmMessageWithUser } from '../../dm.js';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';
import { buildDmChannelPayload, buildDmMessagePayload, findOrCreateDmChannel, isUrlFromPeer, resolveLocalDmMessage } from '../dmChannels.js';
import { extractDomain, resolveLocalUser, resolveOrCreateReplicatedUser, verifyAttribution } from '../identity.js';
import { hydrateReplicatedUserProfile } from '../profile.js';

export async function processCreateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.message) {
    rejected.push({ messageId: event.messageId, reason: 'missing_message_payload' });
    return;
  }

  if (!event.participants || event.participants.length < 2) {
    rejected.push({ messageId: event.messageId, reason: 'missing_participants' });
    return;
  }

  // Attribution: message author must belong to source instance (FED-010)
  if (!verifyAttribution(event.message.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in create: message homeInstance=${extractDomain(event.message.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Dedup: check for existing message with same source
  const existingMsg = db
    .select()
    .from(schema.dmMessages)
    .where(
      and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, event.messageId),
      ),
    )
    .get();

  if (existingMsg) {
    rejected.push({ messageId: event.messageId, reason: 'duplicate' });
    return;
  }

  // Resolve ALL participants to local users, auto-creating replicated stubs
  // for remote users that don't have a local record yet. This ensures 1-on-1
  // federated DMs work even when the remote user hasn't connected or friended.
  const resolvedParticipants: Array<{
    localUser: typeof schema.users.$inferSelect;
    homeUserId: string;
  }> = [];

  for (const p of event.participants) {
    let localUser = resolveOrCreateReplicatedUser(p.homeUserId, p.homeInstance, db, { username: p.profile?.username, status: p.profile?.status, deleted: p.profile?.deleted });
    // Skip deleted identities — don't include tombstoned users in the DM
    if (!localUser) continue;
    // Hydrate with profile data from the relay event (displayName, avatar, etc.)
    if (p.profile) {
      localUser = await hydrateReplicatedUserProfile(localUser, p.profile, db);
    }
    resolvedParticipants.push({ localUser, homeUserId: p.homeUserId });
  }

  if (resolvedParticipants.length < 2) {
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  // Find the author among the resolved participants
  const authorEntry = resolvedParticipants.find(
    p => p.homeUserId === event.message!.homeUserId,
  );
  if (!authorEntry) {
    rejected.push({ messageId: event.messageId, reason: 'author_not_found' });
    return;
  }
  const authorUser = authorEntry.localUser;

  // Resolve local DM channel: group DMs carry a federatedId and the channel
  // must already exist (bootstrapped by a prior member_add event); 1-on-1 DMs
  // are computed from the pair of home user IDs and created on demand.
  let localDmChannelId: string;

  if (event.federatedId) {
    // Group DM: look up by federated_id (channel must already exist from member_add bootstrap)
    const channel = db
      .select()
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
    localDmChannelId = channel.id;
  } else {
    // 1-on-1 DM: compute federated_id from pair and find/create channel
    const federatedId = computeFederatedId(
      resolvedParticipants[0]!.homeUserId,
      resolvedParticipants[1]!.homeUserId,
    );
    localDmChannelId = findOrCreateDmChannel(
      federatedId,
      [resolvedParticipants[0]!.localUser.id, resolvedParticipants[1]!.localUser.id],
      db,
    );
  }

  // Insert the message
  const localMessageId = generateSnowflake();
  db.insert(schema.dmMessages)
    .values({
      id: localMessageId,
      dmChannelId: localDmChannelId,
      userId: authorUser.id,
      content: event.message.content,
      type: event.message.type === 'system' ? 'system' : 'user',
      replyToId: null,
      createdAt: event.message.createdAt,
      editedAt: null,
      sourceInstance,
      sourceMessageId: event.messageId,
      encryptionVersion: 0,
    })
    .run();

  // Create attachment rows and queue file downloads (SSRF-validated).
  // Attachment rows are created immediately with filename = sourceUrl so the
  // initial WebSocket broadcast includes working remote URLs. The background
  // file worker will UPDATE the filename to the local path after download.
  if (event.message.attachments && event.message.attachments.length > 0) {
    const now = Date.now();
    for (const attachment of event.message.attachments) {
      if (!isUrlFromPeer(attachment.sourceUrl, peerOrigin)) {
        console.warn(
          `[federation-relay] Rejecting attachment URL ${attachment.sourceUrl} — hostname does not match peer ${peerOrigin}`,
        );
        continue;
      }

      // Create the attachment row with sourceUrl as the interim filename.
      // AttachmentRenderer already handles filenames starting with 'http' —
      // it uses them as direct URLs. When the file worker downloads the file,
      // it updates this row's filename to the local path.
      const attachmentId = generateSnowflake();
      db.insert(schema.attachments)
        .values({
          id: attachmentId,
          dmMessageId: localMessageId,
          uploaderId: null,
          filename: attachment.sourceUrl,
          originalName: attachment.originalName,
          mimetype: attachment.mimetype,
          size: attachment.size,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          duration: attachment.duration ?? null,
          playable: attachment.playable ?? null,
          thumbnailFilename: null,  // Don't copy source thumbnail — it doesn't exist locally
          sourceUrl: attachment.sourceUrl,
          createdAt: now,
        })
        .run();

      // Queue the background file download
      db.insert(schema.federationFileQueue)
        .values({
          id: generateSnowflake(),
          peerOrigin,
          dmMessageId: localMessageId,
          sourceUrl: attachment.sourceUrl,
          originalName: attachment.originalName,
          mimetype: attachment.mimetype,
          size: attachment.size,
          status: 'pending',
          nextRetryAt: now,
          expiresAt: now + 30 * 86_400_000,
          createdAt: now,
        })
        .run();
    }
  }

  // Broadcast to local WebSocket clients, but skip members whose home instance
  // is the source instance — they already have the original message via their
  // home instance's WebSocket connection.
  const fullMessage = getDmMessageWithUser(localMessageId);
  if (fullMessage) {
    const dmMembers = db.select()
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, localDmChannelId))
      .all();

    for (const member of dmMembers) {
      // If the member closed this DM, reopen it and send dm_channel_created
      // so the sidebar resurfaces before the message arrives.
      if (member.closed === 1) {
        db.update(schema.dmMembers)
          .set({ closed: 0 })
          .where(and(
            eq(schema.dmMembers.dmChannelId, localDmChannelId),
            eq(schema.dmMembers.userId, member.userId),
          ))
          .run();

        const payload = buildDmChannelPayload(localDmChannelId, db, fullMessage);
        if (payload) {
          connectionManager.sendToUser(member.userId, {
            type: 'dm_channel_created',
            dmChannel: payload,
          });
        }
      }

      connectionManager.sendToUser(member.userId, {
        type: 'dm_message_created',
        message: fullMessage,
      });
    }
  }

  // Belt-and-suspenders: clear typing indicator for the author on inbound relay.
  // This catches the case where the explicit dm_typing_stop relay was lost.
  const relayDmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, localDmChannelId))
    .all();

  for (const member of relayDmMembers) {
    if (member.userId !== authorUser.id) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_typing_stop',
        dmChannelId: localDmChannelId,
        userId: authorUser.id,
      });
    }
  }

  accepted.push(event.messageId);
}


export function processUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  // Attribution: if homeInstance present, verify it matches source (FED-010)
  if (event.message?.homeInstance && !verifyAttribution(event.message.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in update: message homeInstance=${extractDomain(event.message.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const localMsg = db
    .select()
    .from(schema.dmMessages)
    .where(
      and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, event.messageId),
      ),
    )
    .get();

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'unknown_message' });
    return;
  }

  const content = event.message?.content ?? null;
  const editedAt = event.message?.editedAt ?? Date.now();

  db.update(schema.dmMessages)
    .set({ content, editedAt })
    .where(eq(schema.dmMessages.id, localMsg.id))
    .run();

  // Broadcast update to local clients
  const authorUser = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, localMsg.userId))
    .get();

  if (authorUser) {
    const updatedPayload = buildDmMessagePayload(
      {
        id: localMsg.id,
        dmChannelId: localMsg.dmChannelId,
        userId: localMsg.userId,
        content,
        replyToId: localMsg.replyToId,
        editedAt,
        createdAt: localMsg.createdAt,
      },
      authorUser,
    );

    // Re-fetch reactions and attachments for the complete payload
    const reactions = db
      .select()
      .from(schema.dmReactions)
      .where(eq(schema.dmReactions.dmMessageId, localMsg.id))
      .all();

    const attachments = db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.dmMessageId, localMsg.id))
      .all();

    updatedPayload.reactions = reactions.map(r => ({
      id: r.id,
      messageId: r.dmMessageId,
      userId: r.userId,
      emoji: r.emoji,
      createdAt: r.createdAt,
    }));

    updatedPayload.attachments = attachments.map(a => ({
      id: a.id,
      messageId: a.dmMessageId ?? a.messageId ?? '',
      filename: a.filename,
      originalName: a.originalName,
      mimetype: a.mimetype,
      size: a.size,
      thumbnailFilename: a.thumbnailFilename,
      width: a.width,
      height: a.height,
      duration: a.duration,
      playable: a.playable ?? null,
      createdAt: a.createdAt,
    }));

    connectionManager.sendToDmMembers(localMsg.dmChannelId, {
      type: 'dm_message_updated',
      message: updatedPayload,
    });
  }

  accepted.push(event.messageId);
}


export function processDeleteEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  // FED-010: delete is safe by design — lookup scoped to sourceInstance+sourceMessageId
  const localMsg = db
    .select()
    .from(schema.dmMessages)
    .where(
      and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, event.messageId),
      ),
    )
    .get();

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'unknown_message' });
    return;
  }

  // Collect attachment filenames before deletion for disk cleanup
  const attachmentRows = db
    .select({ filename: schema.attachments.filename })
    .from(schema.attachments)
    .where(eq(schema.attachments.dmMessageId, localMsg.id))
    .all();

  // Delete attachments, reactions, and message atomically
  db.transaction((tx) => {
    tx.delete(schema.attachments)
      .where(eq(schema.attachments.dmMessageId, localMsg.id))
      .run();
    tx.delete(schema.dmReactions)
      .where(eq(schema.dmReactions.dmMessageId, localMsg.id))
      .run();
    tx.delete(schema.dmMessages)
      .where(eq(schema.dmMessages.id, localMsg.id))
      .run();
  });

  // Clean up files from disk
  deleteAttachmentFiles(attachmentRows);

  // Broadcast deletion to local clients
  connectionManager.sendToDmMembers(localMsg.dmChannelId, {
    type: 'dm_message_deleted',
    messageId: localMsg.id,
    dmChannelId: localMsg.dmChannelId,
  });

  accepted.push(event.messageId);
}


export function processReactionAddEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.reaction) {
    rejected.push({ messageId: event.messageId, reason: 'missing_reaction_payload' });
    return;
  }

  // Attribution: reacting user must belong to source instance (FED-010)
  if (!event.reaction.homeInstance || !verifyAttribution(event.reaction.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in reaction_add: reaction homeInstance=${event.reaction.homeInstance ? extractDomain(event.reaction.homeInstance) : 'missing'} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const canonicalMessageId = event.reaction.messageId ?? event.messageId;
  const localMsg = resolveLocalDmMessage(
    canonicalMessageId,
    event.reaction.messageHomeInstance,
    sourceInstance,
    db,
  );

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'unknown_message' });
    return;
  }

  // Resolve the reacting user
  const reactingUser = resolveLocalUser(event.reaction.homeUserId, db);
  if (!reactingUser) {
    rejected.push({ messageId: event.messageId, reason: 'user_not_found' });
    return;
  }

  // Dedup: check if this user already reacted with this emoji
  const existingReaction = db
    .select()
    .from(schema.dmReactions)
    .where(
      and(
        eq(schema.dmReactions.dmMessageId, localMsg.id),
        eq(schema.dmReactions.userId, reactingUser.id),
        eq(schema.dmReactions.emoji, event.reaction.emoji),
      ),
    )
    .get();

  if (existingReaction) {
    // Already exists — treat as accepted (idempotent)
    accepted.push(event.messageId);
    return;
  }

  const reactionId = generateSnowflake();
  const now = event.reaction.createdAt || Date.now();

  db.insert(schema.dmReactions)
    .values({
      id: reactionId,
      dmMessageId: localMsg.id,
      userId: reactingUser.id,
      emoji: event.reaction.emoji,
      createdAt: now,
    })
    .run();

  // Broadcast to local clients
  connectionManager.sendToDmMembers(localMsg.dmChannelId, {
    type: 'reaction_added',
    messageId: localMsg.id,
    reaction: {
      id: reactionId,
      messageId: localMsg.id,
      userId: reactingUser.id,
      emoji: event.reaction.emoji,
      createdAt: now,
      user: sanitizeUser(reactingUser),
    },
  });

  accepted.push(event.messageId);
}


export function processReactionRemoveEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.reaction) {
    rejected.push({ messageId: event.messageId, reason: 'missing_reaction_payload' });
    return;
  }

  // Attribution: reacting user must belong to source instance (FED-010)
  if (!event.reaction.homeInstance || !verifyAttribution(event.reaction.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in reaction_remove: reaction homeInstance=${event.reaction.homeInstance ? extractDomain(event.reaction.homeInstance) : 'missing'} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const canonicalMessageId = event.reaction.messageId ?? event.messageId;
  const localMsg = resolveLocalDmMessage(
    canonicalMessageId,
    event.reaction.messageHomeInstance,
    sourceInstance,
    db,
  );

  if (!localMsg) {
    rejected.push({ messageId: event.messageId, reason: 'unknown_message' });
    return;
  }

  // Resolve the reacting user
  const reactingUser = resolveLocalUser(event.reaction.homeUserId, db);
  if (!reactingUser) {
    rejected.push({ messageId: event.messageId, reason: 'user_not_found' });
    return;
  }

  const result = db
    .delete(schema.dmReactions)
    .where(
      and(
        eq(schema.dmReactions.dmMessageId, localMsg.id),
        eq(schema.dmReactions.userId, reactingUser.id),
        eq(schema.dmReactions.emoji, event.reaction.emoji),
      ),
    )
    .run();

  if (result.changes > 0) {
    connectionManager.sendToDmMembers(localMsg.dmChannelId, {
      type: 'reaction_removed',
      messageId: localMsg.id,
      userId: reactingUser.id,
      emoji: event.reaction.emoji,
    });
  }

  accepted.push(event.messageId);
}

// ─── Membership mutation processors ──────────────────────────────────────────
