import path from 'node:path';
import { getDb, schema } from '../../../db/index.js';
import { insertDmMember } from '../../../utils/dmMemberClosed.js';
import { canonicalizeHomeInstance, getOurOrigin, normalizeOriginForCompare } from '../../../utils/federationAuth.js';
import { deleteUploadFile } from '../../../utils/fileCleanup.js';
import { sanitizeUser } from '../../../utils/sanitize.js';
import { loadDmChannelWire } from '../../../utils/dmChannelWire.js';
import { generateSnowflake } from '../../../utils/snowflake.js';
import { connectionManager } from '../../../ws/handler.js';
import { GROUP_DM_NAME_MAX_LENGTH, GROUP_DM_NAME_MIN_LENGTH } from '@backspace/shared/src/constants.js';
import { and, eq, or } from 'drizzle-orm';
import type { DmMessageWithUser, FederationRelayEvent } from '@backspace/shared';
import { extractDomain, resolveOrCreateReplicatedUser, resolveRelayActor, attributionRefusal } from '../identity.js';
import { downloadProfileAsset, processProfileUpdateEvent } from '../profile.js';
import { dmChannelMembers, mayRelayInto, memberWithIdentity } from '../dmChannels.js';
import { dmSystemContent, dmSystemName } from '../../../utils/dmSystemMessages.js';

export async function processMemberAddEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.federatedId || !event.membership?.user) {
    rejected.push({ messageId: event.messageId, reason: 'missing_membership_payload' });
    return;
  }

  // Idempotency: a prior delivery of this exact event has already been processed.
  // The system message we persist below carries `(source_instance, source_message_id)`
  // and is guarded by `idx_dm_messages_source_unique`, so presence of a row here is
  // proof the event's side-effects are already in place. Accept silently to prevent
  // outbox retries and initial-sync replay from creating duplicate system messages.
  const existingSysMsg = db
    .select({ id: schema.dmMessages.id })
    .from(schema.dmMessages)
    .where(and(
      eq(schema.dmMessages.sourceInstance, sourceInstance),
      eq(schema.dmMessages.sourceMessageId, event.messageId),
    ))
    .get();
  if (existingSysMsg) {
    accepted.push(event.messageId);
    return;
  }

  // Look up local channel by federated_id
  let channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  let bootstrapped = false;

  // Bootstrap: channel doesn't exist yet — create from group metadata.
  // The sender speaks for the group's owner (FED-010), the owner is in the
  // roster, and the sender is one of the instances the roster lives on
  // ("Relayed member adds" in dm-system.md). The roster and owner arrive in
  // this event, so a refusal here is terminal.
  if (!channel && event.group) {
    const owner = event.group.owner;
    if (!owner) {
      console.warn(`[federation] Refused member_add bootstrap of ${event.federatedId}: the group names no owner`);
      rejected.push({ messageId: event.messageId, reason: 'invalid_target' });
      return;
    }
    const refusal = attributionRefusal(owner, sourceInstance, db);
    if (refusal) {
      console.warn(`[federation] Attribution refused (${refusal}) in member_add bootstrap: owner homeInstance=${extractDomain(owner.homeInstance)} source=${extractDomain(sourceInstance)}`);
      rejected.push({ messageId: event.messageId, reason: refusal });
      return;
    }

    // Resolve owner and roster, creating replicated stubs for users not seen
    // before. Tombstoned identities are skipped: they can't be added to a DM.
    const ownerLocal = resolveOrCreateReplicatedUser(owner.homeUserId, owner.homeInstance, db, { username: owner.profile?.username, status: owner.profile?.status, deleted: owner.profile?.deleted });
    const roster: Array<typeof schema.users.$inferSelect> = [];
    for (const member of event.group.members) {
      const rosterUser = resolveOrCreateReplicatedUser(member.homeUserId, member.homeInstance, db, { username: member.profile?.username, status: member.profile?.status, deleted: member.profile?.deleted });
      if (rosterUser && !roster.some(r => r.id === rosterUser.id)) roster.push(rosterUser);
    }
    if (!ownerLocal || !mayRelayInto(roster, ownerLocal.id, sourceInstance)) {
      console.warn(`[federation] Refused member_add bootstrap of ${event.federatedId}: the owner is not in the roster, or ${extractDomain(sourceInstance)} is not one of its instances`);
      rejected.push({ messageId: event.messageId, reason: 'invalid_target' });
      return;
    }

    const channelId = generateSnowflake();
    const now = Date.now();

    // Group metadata snapshot. Older peers omit these fields — fall back
    // to safe defaults (null name/icon, metadataUpdatedAt=0). When an icon
    // URL is present, mirror processGroupMetadataUpdateEvent and try to
    // download a local copy; on failure, persist the absolute URL.
    const bootstrapName = event.group.name ?? null;
    const bootstrapIconUrl = event.group.icon ?? null;
    const bootstrapMetadataUpdatedAt = event.group.metadataUpdatedAt ?? 0;
    let bootstrapResolvedIcon: string | null = bootstrapIconUrl;
    if (bootstrapIconUrl !== null) {
      const localFile = await downloadProfileAsset(bootstrapIconUrl, sourceInstance);
      bootstrapResolvedIcon = localFile ?? bootstrapIconUrl;
    }

    db.insert(schema.dmChannels)
      .values({
        id: channelId,
        federatedId: event.federatedId,
        ownerId: ownerLocal.id,
        ownerHomeUserId: owner.homeUserId,
        // Canonicalize on storage so future authority comparisons against
        // `sourceInstance` (always a full URL) match cleanly. Defensive: older
        // peers may have sent a bare host on the wire.
        ownerHomeInstance: canonicalizeHomeInstance(owner.homeInstance) ?? null,
        createdAt: now,
        name: bootstrapName,
        icon: bootstrapResolvedIcon,
        metadataUpdatedAt: bootstrapMetadataUpdatedAt,
      })
      .run();

    for (const rosterUser of roster) {
      insertDmMember(db.$client, channelId, rosterUser.id);
    }

    channel = db.select().from(schema.dmChannels)
      .where(eq(schema.dmChannels.id, channelId)).get();

    console.log(`[federation] Bootstrapped group DM channel ${channelId} (federated_id: ${event.federatedId})`);

    bootstrapped = true;
  }

  if (!channel) {
    rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
    return;
  }

  // Authority note: any HMAC-verified peer can relay member_add events.
  // The HMAC signature proves the event came from a trusted peer.
  // The attribution check below still validates that addedBy belongs to the source instance.

  // Attribution: adder must belong to source instance (FED-010)
  if (event.membership.addedBy) {
    const refusal = attributionRefusal(event.membership.addedBy, sourceInstance, db);
    if (refusal) {
      console.warn(`[federation] Attribution refused (${refusal}) in member_add: addedBy homeInstance=${extractDomain(event.membership.addedBy.homeInstance)} source=${extractDomain(sourceInstance)}`);
      rejected.push({ messageId: event.messageId, reason: refusal });
      return;
    }
  }

  // Incremental add: this instance already holds the group, so the add is
  // judged against its copy ("Relayed member adds" in dm-system.md). A 1-on-1
  // has a fixed pair; otherwise, like the local add route, the adder must be a
  // current member, and the signing peer one of the origins this copy is
  // relayed to before the add. A bootstrap is authorized above instead, by the
  // owner's attribution.
  if (!bootstrapped) {
    if (!channel.ownerId) {
      console.warn(`[federation] Refused member_add into 1-on-1 ${channel.id}`);
      rejected.push({ messageId: event.messageId, reason: 'invalid_target' });
      return;
    }
    const members = dmChannelMembers(channel.id, db);
    const adder = event.membership.addedBy ? memberWithIdentity(members, event.membership.addedBy) : undefined;
    if (!adder || !mayRelayInto(members, adder.id, sourceInstance)) {
      console.warn(`[federation] Refused member_add in group DM ${channel.id}: the adder is not a member, or ${extractDomain(sourceInstance)} is not a peer of the conversation`);
      rejected.push({ messageId: event.messageId, reason: 'unauthorized_source' });
      return;
    }
  }

  // Cancel soft-delete if channel was pending GC
  if (channel.deletedAt) {
    db.update(schema.dmChannels)
      .set({ deletedAt: null })
      .where(eq(schema.dmChannels.id, channel.id))
      .run();
  }

  // Resolve the added user — create a replicated stub if unknown
  const localUser = resolveOrCreateReplicatedUser(
    event.membership.user.homeUserId,
    event.membership.user.homeInstance,
    db,
    { username: event.membership.user.profile?.username, status: event.membership.user.profile?.status, deleted: event.membership.user.profile?.deleted },
  );
  if (!localUser) {
    // The user's identity has been deleted — don't add a tombstoned user to the DM
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  // Enforce max 10 members
  const memberCount = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channel.id))
    .all().length;
  if (memberCount >= 10) {
    rejected.push({ messageId: event.messageId, reason: 'max_members_exceeded' });
    return;
  }

  // Add member (idempotent)
  const existingMember = db.select().from(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    )).get();

  if (!existingMember) {
    insertDmMember(db.$client, channel.id, localUser.id);
  }

  // Insert system message for member addition — tagged with (sourceInstance, sourceMessageId)
  // so subsequent deliveries of the same event are deduplicated at the top of this function.
  // The tag is applied in both the bootstrap and incremental paths, because bootstrap replays
  // would otherwise find the channel already present and fall through to the incremental path,
  // creating spurious system messages (the exact bug this fixes).
  const actorUser = event.membership.addedBy
    ? resolveOrCreateReplicatedUser(event.membership.addedBy.homeUserId, event.membership.addedBy.homeInstance, db, { username: event.membership.addedBy.profile?.username, status: event.membership.addedBy.profile?.status, deleted: event.membership.addedBy.profile?.deleted })
    : null;
  const actorId = actorUser?.id ?? localUser.id;
  const addSysMsgId = generateSnowflake();
  const addSysCreatedAt = Date.now();
  const addSysContent = dmSystemContent({
    event: 'member_added',
    targetUserId: localUser.id,
    targetDisplayName: dmSystemName(localUser),
  });

  db.insert(schema.dmMessages).values({
    id: addSysMsgId,
    dmChannelId: channel.id,
    userId: actorId,
    content: addSysContent,
    type: 'system',
    createdAt: addSysCreatedAt,
    sourceInstance,
    sourceMessageId: event.messageId,
  }).run();

  const systemMessagePayload: DmMessageWithUser = {
    id: addSysMsgId,
    dmChannelId: channel.id,
    userId: actorId,
    content: addSysContent,
    type: 'system' as const,
    createdAt: addSysCreatedAt,
    sourceInstance,
    sourceMessageId: event.messageId,
    editedAt: null,
    replyToId: null,
    user: actorUser ? sanitizeUser(actorUser) : sanitizeUser(localUser),
    attachments: [],
    embeds: [],
    reactions: [],
  };

  if (bootstrapped) {
    // Bootstrap: send dm_channel_created to home-local members only (prevents
    // duplicate sidebar entries for users connected to multiple instances).
    // Include the system message we just persisted as lastMessage so the sidebar
    // preview and unread calculation use the same anchor as future messages.
    const bootstrapResult = loadDmChannelWire(db, channel.id, systemMessagePayload);
    if (bootstrapResult) {
      const bootstrapOrigin = getOurOrigin();
      for (const mu of bootstrapResult.members) {
        const muHome = mu.homeInstance
          ? (mu.homeInstance.startsWith('http') ? mu.homeInstance : `https://${mu.homeInstance}`)
          : bootstrapOrigin;  // null homeInstance = native local user
        if (muHome !== bootstrapOrigin) continue;
        connectionManager.sendToUser(mu.id, {
          type: 'dm_channel_created',
          dmChannel: bootstrapResult,
        });
      }
    }
  } else {
    // Incremental: channel already exists for local members, so broadcast the
    // structural change (dm_member_added) and the chat message.
    connectionManager.sendToDmMembers(channel.id, {
      type: 'dm_message_created',
      message: systemMessagePayload,
    });
    connectionManager.sendToDmMembers(channel.id, {
      type: 'dm_member_added',
      dmChannelId: channel.id,
      user: sanitizeUser(localUser),
    });
  }

  accepted.push(event.messageId);
}


export function processMemberRemoveEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.membership?.user) {
    rejected.push({ messageId: event.messageId, reason: 'missing_membership_payload' });
    return;
  }

  // Attribution: for self-leave, user must belong to source instance (FED-010)
  const refusal = event.membership.reason === 'leave' ? attributionRefusal(event.membership.user, sourceInstance, db) : null;
  if (refusal) {
    console.warn(`[federation] Attribution refused (${refusal}) in member_remove: user homeInstance=${extractDomain(event.membership.user.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // Idempotency: skip if this exact event has already been processed.
  // See `processMemberAddEvent` for the rationale — deduplicates retries and
  // initial-sync replay so we don't insert duplicate leave/kick system messages
  // or re-trigger broadcast and soft-delete side-effects.
  const existingSysMsg = db
    .select({ id: schema.dmMessages.id })
    .from(schema.dmMessages)
    .where(and(
      eq(schema.dmMessages.sourceInstance, sourceInstance),
      eq(schema.dmMessages.sourceMessageId, event.messageId),
    ))
    .get();
  if (existingSysMsg) {
    accepted.push(event.messageId);
    return;
  }

  const channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // A kick is a group operation: a 1-on-1 has no owner and a fixed pair.
  if (event.membership.reason !== 'leave' && !channel.ownerId) {
    console.warn(`[federation] Refused member_remove kick in 1-on-1 ${channel.id}`);
    rejected.push({ messageId: event.messageId, reason: 'invalid_target' });
    return;
  }

  // Validate authority: owner's instance for kicks, any instance for self-leave.
  //
  // `sourceInstance` arrives as a full URL from `federationWorker.ts` (always
  // `getOurOrigin()` on the sender). `channel.ownerHomeInstance`, however, can be
  // stored either as a bare host (from `users.homeInstance`, written by
  // `resolveOrCreateReplicatedUser` and by group DM ownership transfers to a
  // federated user) OR as a full URL (group DM creation / transfers to a local
  // user, which fall back to `domainOrigin = getOurOrigin()`). Strict equality
  // here mis-fires for the bare-vs-full mismatch — see the historical bug entry
  // in `docs/systems/dm-system.md`. Always compare through
  // `normalizeOriginForCompare`, matching the established pattern for federation
  // authority checks.
  if (event.membership.reason !== 'leave' && channel.ownerHomeInstance &&
      normalizeOriginForCompare(sourceInstance) !== normalizeOriginForCompare(channel.ownerHomeInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'unauthorized_source' });
    return;
  }

  // The leaving or kicked user, matched on homeUserId + homeInstance. For a
  // leave that user is the attributed actor, so an id that names a local user
  // of another identity is refused; a kick target that is not held here has
  // nothing to remove.
  const removed = resolveRelayActor(event.membership.user, db);
  if (removed.kind === 'mismatch' && event.membership.reason === 'leave') {
    console.warn('[federation] Refused member_remove: the leaving homeUserId names a local user of another identity');
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }
  if (removed.kind !== 'found') {
    accepted.push(event.messageId);
    return;
  }
  const localUser = removed.user;

  // Insert system message for member leaving (before deletion so the broadcast
  // still reaches the departing user's connections). Tagged with source for dedup.
  const leaveSysMsgId = generateSnowflake();
  const leaveSysCreatedAt = Date.now();
  const leaveSysContent = dmSystemContent({
    event: 'member_removed',
    targetUserId: localUser.id,
    targetDisplayName: dmSystemName(localUser),
    reason: event.membership?.reason === 'kick' ? 'kick' : 'leave',
  });
  db.insert(schema.dmMessages).values({
    id: leaveSysMsgId,
    dmChannelId: channel.id,
    userId: localUser.id,
    content: leaveSysContent,
    type: 'system',
    createdAt: leaveSysCreatedAt,
    sourceInstance,
    sourceMessageId: event.messageId,
  }).run();

  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_message_created',
    message: {
      id: leaveSysMsgId,
      dmChannelId: channel.id,
      userId: localUser.id,
      content: leaveSysContent,
      type: 'system',
      createdAt: leaveSysCreatedAt,
      sourceInstance,
      sourceMessageId: event.messageId,
      editedAt: null,
      replyToId: null,
      user: sanitizeUser(localUser),
      attachments: [],
      embeds: [],
      reactions: [],
    } as unknown as DmMessageWithUser,
  });

  // Remove member (idempotent)
  db.delete(schema.dmMembers)
    .where(and(
      eq(schema.dmMembers.dmChannelId, channel.id),
      eq(schema.dmMembers.userId, localUser.id),
    ))
    .run();

  // Clean up read states
  db.delete(schema.readStates)
    .where(and(
      eq(schema.readStates.userId, localUser.id),
      eq(schema.readStates.channelId, channel.id),
    ))
    .run();

  // Broadcast to local WebSocket clients
  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_member_removed',
    dmChannelId: channel.id,
    userId: localUser.id,
  });

  // Check if zero local members remain — begin soft-delete GC
  const remaining = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channel.id))
    .all();

  if (remaining.length === 0) {
    db.update(schema.dmChannels)
      .set({ deletedAt: Date.now() })
      .where(eq(schema.dmChannels.id, channel.id))
      .run();
    console.log(`[federation] Group DM ${channel.id} has no local members, soft-deleted for GC`);
  }

  accepted.push(event.messageId);
}


export function processOwnershipTransferEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.federatedId || !event.ownership) {
    rejected.push({ messageId: event.messageId, reason: 'missing_ownership_payload' });
    return;
  }

  // Attribution: previous owner must belong to source instance (FED-010)
  const refusal = event.ownership.previousOwner ? attributionRefusal(event.ownership.previousOwner, sourceInstance, db) : null;
  if (refusal) {
    console.warn(`[federation] Attribution refused (${refusal}) in ownership_transfer: previousOwner homeInstance=${extractDomain(event.ownership.previousOwner.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // Idempotency: reject replay of a transfer we've already processed. Critical here
  // because a stale replay could otherwise overwrite a newer owner (e.g. A->B then
  // B->A, then A->B arrives again and clobbers). See `processMemberAddEvent`.
  const existingSysMsg = db
    .select({ id: schema.dmMessages.id })
    .from(schema.dmMessages)
    .where(and(
      eq(schema.dmMessages.sourceInstance, sourceInstance),
      eq(schema.dmMessages.sourceMessageId, event.messageId),
    ))
    .get();
  if (existingSysMsg) {
    accepted.push(event.messageId);
    return;
  }

  const channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // Ownership is a group's: a 1-on-1 has no owner to transfer.
  if (!channel.ownerId) {
    console.warn(`[federation] Refused ownership_transfer of 1-on-1 ${channel.id}`);
    rejected.push({ messageId: event.messageId, reason: 'invalid_target' });
    return;
  }

  // Validate authority: only the current owner's instance can transfer ownership.
  //
  // See the matching note in `processMemberRemoveEvent`: `sourceInstance` is
  // always a full URL but `channel.ownerHomeInstance` can be bare or full.
  // Normalize both sides through `normalizeOriginForCompare` so we don't reject
  // legitimate back-and-forth transfers that wrote a bare host into the column.
  if (channel.ownerHomeInstance &&
      normalizeOriginForCompare(sourceInstance) !== normalizeOriginForCompare(channel.ownerHomeInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'unauthorized_source' });
    return;
  }

  // The previous owner is the attributed actor, matched on homeUserId +
  // homeInstance. Resolved before anything changes, so an id that names a local
  // user of another identity refuses the whole transfer. One not held here
  // leaves the system message to the channel's recorded owner.
  const prevOwner = event.ownership.previousOwner
    ? resolveRelayActor(event.ownership.previousOwner, db)
    : null;
  if (prevOwner?.kind === 'mismatch') {
    console.warn('[federation] Refused ownership_transfer: the previous owner homeUserId names a local user of another identity');
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }
  const prevOwnerLocal = prevOwner?.kind === 'found' ? prevOwner.user : null;

  // Resolve new owner to local user. If the new owner's identity has been
  // deleted, we cannot complete the transfer — reject so the event can be
  // retried or dropped by the sender.
  const newOwnerLocal = resolveOrCreateReplicatedUser(
    event.ownership.newOwner.homeUserId,
    event.ownership.newOwner.homeInstance,
    db,
    { username: event.ownership.newOwner.profile?.username, status: event.ownership.newOwner.profile?.status, deleted: event.ownership.newOwner.profile?.deleted },
  );
  if (!newOwnerLocal) {
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  // Canonicalize to a full origin URL on storage so future authority checks
  // can compare cleanly against `sourceInstance` (also a full URL). Mirrors
  // the canonicalization performed in `transferGroupDmOwnership` on the
  // sender side. Falls back to the wire value if normalization yields null
  // (shouldn't happen for valid events; defensive).
  const canonicalOwnerHome =
    canonicalizeHomeInstance(event.ownership.newOwner.homeInstance) ?? event.ownership.newOwner.homeInstance;

  db.update(schema.dmChannels)
    .set({
      ownerId: newOwnerLocal.id,
      ownerHomeUserId: event.ownership.newOwner.homeUserId,
      ownerHomeInstance: canonicalOwnerHome,
    })
    .where(eq(schema.dmChannels.id, channel.id))
    .run();

  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_owner_updated',
    dmChannelId: channel.id,
    newOwnerId: newOwnerLocal.id,
    newOwnerHomeUserId: event.ownership.newOwner.homeUserId,
    newOwnerHomeInstance: canonicalOwnerHome,
  });

  const ownerSysMsgId = generateSnowflake();
  const ownerSysCreatedAt = Date.now();
  const prevOwnerId = prevOwnerLocal?.id ?? channel.ownerId ?? 'system';
  const ownerSysContent = dmSystemContent({
    event: 'owner_changed',
    newOwnerId: newOwnerLocal.id,
    newOwnerDisplayName: dmSystemName(newOwnerLocal),
  });

  db.insert(schema.dmMessages).values({
    id: ownerSysMsgId,
    dmChannelId: channel.id,
    userId: prevOwnerId,
    content: ownerSysContent,
    type: 'system',
    createdAt: ownerSysCreatedAt,
    sourceInstance,
    sourceMessageId: event.messageId,
  }).run();

  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_message_created',
    message: {
      id: ownerSysMsgId,
      dmChannelId: channel.id,
      userId: prevOwnerId,
      content: ownerSysContent,
      type: 'system',
      createdAt: ownerSysCreatedAt,
      sourceInstance,
      sourceMessageId: event.messageId,
      editedAt: null,
      replyToId: null,
      user: prevOwnerLocal ? sanitizeUser(prevOwnerLocal) : undefined,
      attachments: [],
      embeds: [],
      reactions: [],
    } as unknown as DmMessageWithUser,
  });

  accepted.push(event.messageId);
}

// ─── Friend Event Processors ─────────────────────────────────────────────────


/**
 * Inbound group_metadata_update relay handler.
 *
 * Authority: only the group's owner instance may mutate name/icon. We compare
 * `extractDomain(sourceInstance)` with `extractDomain(channel.ownerHomeInstance)`;
 * any other peer relaying this event is treated as an attribution mismatch
 * (mirrors the strict check in processProfileUpdateEvent).
 *
 * Receiver hardening: never trust the wire payload's bounds — re-validate name
 * length and icon URL scheme. A malicious or buggy peer cannot push us past
 * the same constraints we enforce in PATCH /api/dm/:id.
 *
 * Side-effects on success:
 *   1. dm_channels.{name,icon,metadataUpdatedAt} updated in a single tx.
 *   2. One or two `dm_messages` system rows inserted (name_changed / icon_changed),
 *      each tagged with `(sourceInstance, sourceMessageId)` using the dedup-suffix
 *      scheme `${event.messageId}:name` / `${event.messageId}:icon`. This mirrors
 *      processMemberAddEvent's idempotency contract — a retry of the same wire
 *      event must not insert a second row.
 *   3. dm_channel_updated WS broadcast to local members.
 *   4. dm_message_created WS broadcast for each new system message.
 *   5. Old local icon file is unlinked from disk if it changed away from a local
 *      filename (same precedent as the local PATCH endpoint).
 */
export async function processGroupMetadataUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_federated_id' });
    return;
  }

  // Lookup channel by federated_id. Missing → idempotent accept (this peer has
  // no replica of the channel, nothing to update).
  const channel = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // Authority: only the owner's home instance can mutate group metadata.
  if (extractDomain(sourceInstance) !== extractDomain(channel.ownerHomeInstance ?? '')) {
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Receiver hardening — payload validation. Don't trust remote peers to
  // respect our bounds; a peer bug or malicious actor must not be able to
  // push values our local PATCH endpoint would have rejected.
  const metadata = event.metadata;
  if (!metadata) {
    rejected.push({ messageId: event.messageId, reason: 'missing_metadata_payload' });
    return;
  }

  if (metadata.name !== null) {
    const trimmedLength = metadata.name.trim().length;
    if (trimmedLength < GROUP_DM_NAME_MIN_LENGTH || trimmedLength > GROUP_DM_NAME_MAX_LENGTH) {
      rejected.push({ messageId: event.messageId, reason: 'invalid_payload' });
      return;
    }
  }

  if (metadata.icon !== null && !(metadata.icon.startsWith('http://') || metadata.icon.startsWith('https://'))) {
    rejected.push({ messageId: event.messageId, reason: 'invalid_payload' });
    return;
  }

  // Version check: stale or duplicate timestamp → silent accept.
  if (metadata.metadataUpdatedAt <= (channel.metadataUpdatedAt ?? 0)) {
    accepted.push(event.messageId);
    return;
  }

  // Diff against stored row — if neither field actually changed, no-op.
  const nameChanged = metadata.name !== channel.name;
  const iconChanged = metadata.icon !== channel.icon;
  if (!nameChanged && !iconChanged) {
    accepted.push(event.messageId);
    return;
  }

  // Idempotency pre-check: if either system message already exists under
  // `(sourceInstance, sourceMessageId)`, this event was already processed.
  // Mirrors processMemberAddEvent's dedup contract — outbox retries and
  // initial-sync replay must not double-insert.
  const nameMessageId = `${event.messageId}:name`;
  const iconMessageId = `${event.messageId}:icon`;
  const existingNameRow = nameChanged
    ? db
      .select({ id: schema.dmMessages.id })
      .from(schema.dmMessages)
      .where(and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, nameMessageId),
      ))
      .get()
    : null;
  const existingIconRow = iconChanged
    ? db
      .select({ id: schema.dmMessages.id })
      .from(schema.dmMessages)
      .where(and(
        eq(schema.dmMessages.sourceInstance, sourceInstance),
        eq(schema.dmMessages.sourceMessageId, iconMessageId),
      ))
      .get()
    : null;
  // If every changed field already has its corresponding system row, the
  // entire event has been applied — accept silently.
  if (
    (!nameChanged || existingNameRow)
    && (!iconChanged || existingIconRow)
  ) {
    accepted.push(event.messageId);
    return;
  }

  // ── Resolve icon: download to local upload dir, fall back to absolute URL ──
  let resolvedIcon: string | null = metadata.icon;
  if (iconChanged && metadata.icon !== null) {
    const localFile = await downloadProfileAsset(metadata.icon, sourceInstance);
    resolvedIcon = localFile ?? metadata.icon;
  }

  // Resolve actor → local user id for the system-message foreign key.
  // Falls back to channel.ownerId if the actor stub can't be created (e.g.
  // tombstoned identity); the system message still has to render somewhere.
  const actorParticipant = metadata.actor;
  let actorUserId: string | null = null;
  if (actorParticipant) {
    const actorUser = resolveOrCreateReplicatedUser(
      actorParticipant.homeUserId,
      actorParticipant.homeInstance,
      db,
      { username: actorParticipant.profile?.username, status: actorParticipant.profile?.status, deleted: actorParticipant.profile?.deleted },
    );
    actorUserId = actorUser?.id ?? null;
  }
  if (!actorUserId) {
    actorUserId = channel.ownerId;
  }
  if (!actorUserId) {
    // No owner user row to attach a system message to — extremely unusual,
    // bail out cleanly without persisting anything.
    rejected.push({ messageId: event.messageId, reason: 'actor_not_found' });
    return;
  }

  const oldName = channel.name;
  const oldIcon = channel.icon;

  type SystemMessageRow = { id: string; sourceMessageId: string; content: string; createdAt: number };
  const sysMessageRows: SystemMessageRow[] = [];

  // Single transaction: channel update + system message insert(s).
  db.transaction((tx) => {
    tx.update(schema.dmChannels)
      .set({
        name: metadata.name,
        icon: resolvedIcon,
        metadataUpdatedAt: metadata.metadataUpdatedAt,
      })
      .where(eq(schema.dmChannels.id, channel.id))
      .run();

    if (nameChanged && !existingNameRow) {
      const sysId = generateSnowflake();
      const content = dmSystemContent({ event: 'name_changed', oldName, newName: metadata.name });
      tx.insert(schema.dmMessages).values({
        id: sysId,
        dmChannelId: channel.id,
        userId: actorUserId,
        content,
        type: 'system',
        sourceInstance,
        sourceMessageId: nameMessageId,
        createdAt: metadata.metadataUpdatedAt,
      }).run();
      sysMessageRows.push({
        id: sysId,
        sourceMessageId: nameMessageId,
        content,
        createdAt: metadata.metadataUpdatedAt,
      });
    }

    if (iconChanged && !existingIconRow) {
      const sysId = generateSnowflake();
      const content = dmSystemContent({ event: 'icon_changed' });
      tx.insert(schema.dmMessages).values({
        id: sysId,
        dmChannelId: channel.id,
        userId: actorUserId,
        content,
        type: 'system',
        sourceInstance,
        sourceMessageId: iconMessageId,
        createdAt: metadata.metadataUpdatedAt,
      }).run();
      sysMessageRows.push({
        id: sysId,
        sourceMessageId: iconMessageId,
        content,
        createdAt: metadata.metadataUpdatedAt,
      });
    }
  });

  // ── Broadcast channel update to local members ──
  connectionManager.sendToDmMembers(channel.id, {
    type: 'dm_channel_updated',
    dmChannelId: channel.id,
    name: metadata.name,
    icon: resolvedIcon,
  });

  // ── Broadcast each new system message ──
  const actorRow = db.select().from(schema.users).where(eq(schema.users.id, actorUserId)).get();
  const sanitizedActor = actorRow ? sanitizeUser(actorRow) : undefined;
  for (const sys of sysMessageRows) {
    connectionManager.sendToDmMembers(channel.id, {
      type: 'dm_message_created',
      message: {
        id: sys.id,
        dmChannelId: channel.id,
        userId: actorUserId,
        content: sys.content,
        type: 'system',
        createdAt: sys.createdAt,
        sourceInstance,
        sourceMessageId: sys.sourceMessageId,
        editedAt: null,
        replyToId: null,
        user: sanitizedActor,
        attachments: [],
        embeds: [],
        reactions: [],
      } as DmMessageWithUser,
    });
  }

  // ── Cleanup old local icon file ──
  // Mirrors the local PATCH precedent (dm.ts:1595): only unlink when the
  // previous icon was a bare local filename (i.e. we own the file on disk).
  // Absolute URLs point at remote files we never owned.
  if (iconChanged && oldIcon && !oldIcon.startsWith('http://') && !oldIcon.startsWith('https://') && oldIcon !== resolvedIcon) {
    deleteUploadFile(oldIcon);
  }

  accepted.push(event.messageId);
}
