import path from 'node:path';
import { getDb, schema } from '../../../db/index.js';
import { getOurOrigin } from '../../../utils/federationAuth.js';
import { fanOutCallEvent } from '../../../utils/callFanout.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { CallFanoutFailure } from '../../../utils/federationOutbox.js';
import type { DmRoomMeta, FederatedCallEntry } from '../../../ws/handler.js';
import type { DmCallUndeliverableFailure, FederationCallPayload, FederationRelayEvent, ServerEvent } from '@backspace/shared';
import { extractDomain, resolveOrCreateReplicatedUser, resolveRelayActor, attributionRefusal, type RelayActor } from '../identity.js';
import { isGroupConversation } from '../../../utils/dmConversation.js';
import { isDmMember } from '../../../utils/permissions.js';

/**
 * The call's tokens by the local user each is for. A token names its holder
 * by federated identity (`memberTokens`), resolved here with
 * `resolveRelayActor`. From an older sender, which keys `tokens` by home user
 * id alone and only for members the receiving instance homes, each key is a
 * user homed here. A holder that resolves to no local user gets nothing.
 */
function callTokensByLocalUser(
  call: FederationCallPayload,
  db: ReturnType<typeof getDb>,
): Map<string, string> {
  const holders = call.memberTokens
    ?? Object.entries(call.tokens ?? {}).map(([homeUserId, token]) => ({ homeUserId, homeInstance: getOurOrigin(), token }));
  const byLocalUser = new Map<string, string>();
  for (const holder of holders) {
    if (typeof holder?.homeUserId !== 'string' || typeof holder.homeInstance !== 'string' || typeof holder.token !== 'string') continue;
    const resolved = resolveRelayActor({ homeUserId: holder.homeUserId, homeInstance: holder.homeInstance }, db);
    if (resolved.kind === 'found') byLocalUser.set(resolved.user.id, holder.token);
  }
  return byLocalUser;
}

/**
 * The local row of a relayed call event's actor, or '' when it resolves to
 * none. A fan-out from here names the actor only when a peer would accept it
 * from this instance (`callRelayActor`); otherwise it names the caller.
 */
function localActorId(actor: RelayActor | undefined, db: ReturnType<typeof getDb>): string {
  if (!actor) return '';
  const resolved = resolveRelayActor(actor, db);
  return resolved.kind === 'found' ? resolved.user.id : '';
}

/**
 * Apply a relayed end or decline to the group call hosted here for
 * `localDmId`, and return whether the call ended. Local only: the caller
 * relays the end.
 *
 * With `perMember` the sending instance keeps the call for its other members,
 * so only the actor leaves (end) or stops ringing (decline). Without it the
 * sender is a peer up to 1.8.0, which ended the call for all of its own
 * members when one of them hung up or declined, so every participant it
 * relayed in leaves too. An actor who is not a member of the conversation,
 * or not in the call, changes nothing beyond that.
 */
function applyRelayedGroupLeave(
  kind: 'end' | 'decline',
  localDmId: string,
  actor: RelayActor | undefined,
  perMember: boolean,
  sourceOrigin: string,
  db: ReturnType<typeof getDb>,
): boolean {
  if (!perMember && connectionManager.leavePeerParticipants(localDmId, sourceOrigin).ended) return true;
  if (!actor) return false;
  const resolved = resolveRelayActor(actor, db);
  if (resolved.kind !== 'found' || !isDmMember(localDmId, resolved.user.id)) return false;
  const outcome = kind === 'end'
    ? connectionManager.leaveGroupDmCall(localDmId, resolved.user.id)
    : connectionManager.declineGroupDmCall(localDmId, resolved.user.id);
  return outcome === 'ended';
}

export function processDmCallStartEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
  undeliverable: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.call?.caller || !event.call.livekitUrl || !event.call.tokens || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_call_payload' });
    return;
  }

  // Attribution: caller must belong to source instance
  const refusal = attributionRefusal(event.call.caller, sourceInstance, db);
  if (refusal) {
    console.warn(`[federation] Attribution refused (${refusal}) in dm_call_start: caller=${extractDomain(event.call.caller.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // Find local DM channel by federatedId
  const channel = db.select({ id: schema.dmChannels.id, ownerId: schema.dmChannels.ownerId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();
  // Without a local copy the key alone tells a group from a 1-on-1. The
  // group rules hold only when the host applies them too (`perMember`); a
  // host up to 1.8.0 ends the call on any member's end or decline and never
  // tells the instance that sent it, so its calls keep the 1-on-1 rules here.
  const group = isGroupConversation({ owner_id: channel?.ownerId ?? null, federated_id: event.federatedId })
    && event.call.perMember === true;

  // Resolve caller to local stub. The call payload carries only a display
  // name, which is not a handle, so no username hint: a caller met here first
  // gets the `<homeUserId>@<domain>` name until a real username arrives.
  const callerStub = resolveOrCreateReplicatedUser(
    event.call.caller.homeUserId,
    event.call.caller.homeInstance,
    db,
  );
  if (!callerStub) {
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  const ringedUserIds: string[] = [];
  const tokens = callTokensByLocalUser(event.call, db);

  if (channel) {
    // ── Path A: DM exists locally ──
    const localDmChannelId = channel.id;

    const localMembers = db.select({ userId: schema.dmMembers.userId })
      .from(schema.dmMembers)
      .where(eq(schema.dmMembers.dmChannelId, localDmChannelId))
      .all();

    for (const member of localMembers) {
      // Don't ring the caller on this instance.
      if (member.userId === callerStub.id) continue;

      // #18: skip offline members. Entry-vs-no-entry decision uses the same
      // connection-count signal Path B has always used — keeps the two paths
      // symmetric in what counts as "ringed."
      if (connectionManager.getUserConnections(member.userId).size === 0) continue;

      // The host mints a token only for the members IT considers ours. A local
      // member homed on a third instance (client-federation) is rung by their
      // own home instance, not by us — without a token there is nothing to ring
      // them with, so skip rather than dispatch an unusable `dm_call_incoming`.
      // Mirrors the same guard on Path B below.
      const token = tokens.get(member.userId);
      if (!token) continue;

      connectionManager.sendToUser(member.userId, {
        type: 'dm_call_incoming',
        dmChannelId: localDmChannelId,
        federatedCallId: event.federatedId,
        callerId: callerStub.id,
        callerName: callerStub.displayName ?? callerStub.username,
        livekitUrl: event.call!.livekitUrl,
        livekitToken: token,
        callOrigin: event.call!.caller.homeInstance,
      });
      ringedUserIds.push(member.userId);
    }

    if (ringedUserIds.length === 0) {
      // #18: no local member was reachable. Do not create a FederatedCallEntry
      // (it would strand with no accept/reject path); surface to the caller
      // via undeliverable so it can tear down its ring room instead of hanging.
      undeliverable.push({ messageId: event.messageId, reason: 'no_recipient' });
      return;
    }

    const entry: FederatedCallEntry = {
      dmChannelId: localDmChannelId,
      federatedId: event.federatedId,
      callerId: callerStub.id,
      callerHomeUserId: event.call.caller.homeUserId,
      federatedCallHost: sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`,
      livekitUrl: event.call.livekitUrl,
      tokens,
      ringedUserIds,
      joinedUserIds: [],
      group,
      state: 'ringing',
      startedAt: Date.now(),
    };
    connectionManager.createFederatedCall(entry);

  } else {
    // ── Path B: DM doesn't exist locally — match by participant identity ──
    if (!event.call.participants || !Array.isArray(event.call.participants)) {
      // Old-format relay without participants — backwards-compatible rejection
      rejected.push({ messageId: event.messageId, reason: 'channel_not_found' });
      return;
    }

    const ourDomain = extractDomain(getOurOrigin());

    for (const p of event.call.participants) {
      const participantDomain = extractDomain(p.homeInstance);
      // Skip the caller — strict match on BOTH homeUserId AND homeInstance
      if (p.homeUserId === event.call.caller.homeUserId
          && participantDomain === extractDomain(event.call.caller.homeInstance)) {
        continue;
      }

      // Strict identity resolution: homeUserId is only unique within its homeInstance
      const localUser = db.select({ id: schema.users.id })
        .from(schema.users)
        .where(
          or(
            // Replicated stub or federated account from the participant's home instance
            and(
              eq(schema.users.homeUserId, p.homeUserId),
              sql`replace(replace(coalesce(${schema.users.homeInstance}, ''), 'https://', ''), 'http://', '') = ${participantDomain}`,
            ),
            // Native user whose ID matches and participant's home matches our domain
            and(
              eq(schema.users.id, p.homeUserId),
              isNull(schema.users.homeInstance),
              sql`${participantDomain} = ${ourDomain}`,
            ),
          ),
        )
        .get();

      if (!localUser) continue;

      // Check if user has an active WS connection
      const connections = connectionManager.getUserConnections(localUser.id);
      if (connections.size === 0) continue;

      const token = tokens.get(localUser.id);
      if (!token) continue;

      connectionManager.sendToUser(localUser.id, {
        type: 'dm_call_incoming',
        dmChannelId: null,
        federatedCallId: event.federatedId,
        callerId: callerStub.id,
        callerName: callerStub.displayName ?? callerStub.username,
        livekitUrl: event.call!.livekitUrl,
        livekitToken: token,
        callOrigin: event.call!.caller.homeInstance,
      });
      ringedUserIds.push(localUser.id);
    }

    if (ringedUserIds.length === 0) {
      // No recipient reachable — signal to caller via third ack bucket (#18).
      // The remote processed the event cleanly; this is not a data error, but
      // the caller must learn that nobody was rung so it can tear down its
      // local ring room instead of hanging 60s waiting for an accept.
      undeliverable.push({ messageId: event.messageId, reason: 'no_recipient' });
      return;
    }

    const entry: FederatedCallEntry = {
      dmChannelId: null,
      federatedId: event.federatedId,
      callerId: callerStub.id,
      callerHomeUserId: event.call.caller.homeUserId,
      federatedCallHost: sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`,
      livekitUrl: event.call.livekitUrl,
      tokens,
      ringedUserIds,
      joinedUserIds: [],
      group,
      state: 'ringing',
      startedAt: Date.now(),
    };
    connectionManager.createFederatedCall(entry);
  }

  accepted.push(event.messageId);
}


export function processDmCallAcceptEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.call?.acceptor || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_call_payload' });
    return;
  }

  const refusal = attributionRefusal(event.call.acceptor, sourceInstance, db);
  if (refusal) {
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();
  const dmChannelId = channel?.id;

  // Check if we're the HOST (have a VoiceRoom)
  const room = dmChannelId ? connectionManager.getRoom(dmChannelId) : undefined;
  if (room && room.roomType === 'dm') {
    const meta = room.metadata as DmRoomMeta;

    if (meta.state === 'ringing') {
      connectionManager.activateDmRoom(dmChannelId!);

      // Join caller to room. Whatever room they sat in is left first, and
      // told: a call they leave empty ends there and then.
      connectionManager.leaveCurrentRoomAnnounced(meta.callerId, dmChannelId!);
      connectionManager.joinRoom(dmChannelId!, meta.callerId);

      connectionManager.sendToDmMembers(dmChannelId!, {
        type: 'voice_state_update',
        channelId: dmChannelId!,
        userId: meta.callerId,
        action: 'join',
      });
    }

    // Seat the acceptor of a group call in the room, so the call knows it
    // still has a participant while they are in it and their leave, relayed
    // later, is the one that can end it. Only a sender that says it applies
    // the group rules (`perMember`) relays that leave, also when the member
    // just goes away; an acceptor from a peer up to 1.8.0, or in a 1-on-1,
    // is not seated, so the call ends with its last seated participant as
    // in 1.8.0.
    const acceptor = meta.group && event.call.perMember === true
      ? resolveRelayActor(event.call.acceptor, db)
      : undefined;
    if (acceptor?.kind === 'found' && isDmMember(dmChannelId!, acceptor.user.id)) {
      const acceptorId = acceptor.user.id;
      // A seat in another room here (another call this peer's member sat in)
      // is left first, and told, so that room does not keep them.
      connectionManager.leaveCurrentRoomAnnounced(acceptorId, dmChannelId!);
      connectionManager.joinRoom(dmChannelId!, acceptorId);
      meta.remoteParticipants.set(acceptorId, sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`);
      meta.declinedUserIds.delete(acceptorId);
      connectionManager.sendToDmMembers(dmChannelId!, {
        type: 'voice_state_update',
        channelId: dmChannelId!,
        userId: acceptorId,
        action: 'join',
      });
    }

    // Broadcast accepted locally — include federatedCallId so all clients can match
    connectionManager.sendToDmMembers(dmChannelId!, {
      type: 'dm_call_accepted',
      dmChannelId: dmChannelId!,
      federatedCallId: event.federatedId,
    } as ServerEvent);

    // Fan out to ALL other remote instances (exclude the one that sent the accept)
    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    const hostCallerId = (room.metadata as DmRoomMeta).callerId;
    const localDmId = dmChannelId!;
    void fanOutCallEvent(localDmId, 'dm_call_accept', [localActorId(event.call.acceptor, db), hostCallerId], normalizedSource, db).then(failures => {
      emitHostFanoutUndeliverable(hostCallerId, localDmId, event.federatedId!, 'accept', failures);
    }).catch(err =>
      console.error('[federation] Fan-out dm_call_accept threw:', err),
    );
  } else {
    // We're a REMOTE instance receiving fan-out — transition local state
    const fedCall = connectionManager.getFederatedCall(event.federatedId);
    if (fedCall) {
      // Only broadcast if transitioning from ringing → active.
      // If already active (e.g., we initiated the accept and the host is fanning out back),
      // skip the duplicate broadcast to avoid state conflicts on the client.
      const wasRinging = fedCall.state === 'ringing';
      connectionManager.activateFederatedCall(event.federatedId);
      if (wasRinging) {
        connectionManager.sendToFederatedCallUsers(event.federatedId, {
          type: 'dm_call_accepted',
          dmChannelId: fedCall.dmChannelId,
          federatedCallId: event.federatedId,
        } as ServerEvent);
      }
    }
  }

  accepted.push(event.messageId);
}


export function processDmCallRejectEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.call?.rejector || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_call_payload' });
    return;
  }

  const refusal = attributionRefusal(event.call.rejector, sourceInstance, db);
  if (refusal) {
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();
  const dmChannelId = channel?.id;

  const room = dmChannelId ? connectionManager.getRoom(dmChannelId) : undefined;
  if (room && room.roomType === 'dm') {
    const meta = room.metadata as DmRoomMeta;
    const hostCallerId = meta.callerId;
    const localDmId = dmChannelId!;
    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    // In a group the decline only removes the decliner. When that leaves
    // nobody to answer, the call ends for every peer, the sender too, whose
    // other members may still be ringing; the end goes out in the caller's
    // name, since a peer refuses an end attributed to a user homed elsewhere.
    if (meta.group) {
      if (applyRelayedGroupLeave('decline', localDmId, event.call.rejector, event.call.perMember === true, normalizedSource, db)) {
        connectionManager.fanOutCallEnd(localDmId, hostCallerId);
      }
      accepted.push(event.messageId);
      return;
    }

    // In a 1-on-1 the decline ends the call, and the instance that sent it
    // already knows.
    connectionManager.endDmRoom(localDmId, 'dm_call_rejected');
    void fanOutCallEvent(localDmId, 'dm_call_end', [localActorId(event.call.rejector, db), hostCallerId], normalizedSource, db).then(failures => {
      emitHostFanoutUndeliverable(hostCallerId, localDmId, event.federatedId!, 'reject', failures);
    }).catch(err =>
      console.error('[federation] Fan-out dm_call_end (reject) threw:', err),
    );
  } else {
    const fedCall = connectionManager.getFederatedCall(event.federatedId);
    if (fedCall) {
      connectionManager.sendToFederatedCallUsers(event.federatedId, {
        type: 'dm_call_rejected',
        dmChannelId: fedCall.dmChannelId,
        federatedCallId: event.federatedId,
      } as ServerEvent);
      connectionManager.clearFederatedCall(event.federatedId);
    }
  }

  accepted.push(event.messageId);
}


export function processDmCallEndEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.call?.endedBy || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_call_payload' });
    return;
  }

  const refusal = attributionRefusal(event.call.endedBy, sourceInstance, db);
  if (refusal) {
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();
  const dmChannelId = channel?.id;

  const room = dmChannelId ? connectionManager.getRoom(dmChannelId) : undefined;
  if (room && room.roomType === 'dm') {
    const meta = room.metadata as DmRoomMeta;
    const hostCallerId = meta.callerId;
    const localDmId = dmChannelId!;
    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    // In a group the end takes only that member out. When they were the last
    // one in, the call ends for every peer, the sender too, whose other
    // members may still be ringing; the end goes out in the caller's name,
    // since a peer refuses an end attributed to a user homed elsewhere.
    if (meta.group) {
      if (applyRelayedGroupLeave('end', localDmId, event.call.endedBy, event.call.perMember === true, normalizedSource, db)) {
        connectionManager.fanOutCallEnd(localDmId, hostCallerId);
      }
      accepted.push(event.messageId);
      return;
    }

    // In a 1-on-1 either side's end ends the call, and the instance that
    // sent it already knows.
    connectionManager.endDmRoom(localDmId, 'dm_call_ended');
    void fanOutCallEvent(localDmId, 'dm_call_end', [localActorId(event.call.endedBy, db), hostCallerId], normalizedSource, db).then(failures => {
      emitHostFanoutUndeliverable(hostCallerId, localDmId, event.federatedId!, 'end', failures);
    }).catch(err =>
      console.error('[federation] Fan-out dm_call_end threw:', err),
    );
  } else {
    const fedCall = connectionManager.getFederatedCall(event.federatedId);
    if (fedCall) {
      connectionManager.sendToFederatedCallUsers(event.federatedId, {
        type: 'dm_call_ended',
        dmChannelId: fedCall.dmChannelId,
        federatedCallId: event.federatedId,
      } as ServerEvent);
      connectionManager.clearFederatedCall(event.federatedId);
    }
  }

  accepted.push(event.messageId);
}


export function processDmTypingStartEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.typing || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_typing_payload' });
    return;
  }

  // Attribution: the peer must be entitled to speak for the typing identity.
  const refusal = attributionRefusal(event.typing, sourceInstance, db);
  if (refusal) {
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // Look up local channel by federatedId
  const channel = db.select()
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    // Channel not bootstrapped yet — discard silently
    accepted.push(event.messageId);
    return;
  }

  // Resolve the typing user (read-only, no stubs for ephemeral events).
  // Matched on homeUserId + homeInstance; see `resolveRelayActor`.
  const typer = resolveRelayActor(event.typing, db);
  if (typer.kind === 'mismatch') {
    console.warn('[federation] Refused dm_typing_start: the typing homeUserId names a local user of another identity');
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }
  if (typer.kind === 'unknown') {
    // User stub doesn't exist — discard silently
    accepted.push(event.messageId);
    return;
  }
  const typingUser = typer.user;

  // Broadcast dm_typing to local DM members (excluding the typer)
  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channel.id))
    .all();

  for (const member of dmMembers) {
    if (member.userId !== typingUser.id) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_typing',
        dmChannelId: channel.id,
        userId: typingUser.id,
        username: typingUser.username ?? event.typing.username,
      });
    }
  }

  accepted.push(event.messageId);
}


export function processDmTypingStopEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.typing || !event.federatedId) {
    rejected.push({ messageId: event.messageId, reason: 'missing_typing_payload' });
    return;
  }

  // Attribution: the peer must be entitled to speak for the typing identity.
  const refusal = attributionRefusal(event.typing, sourceInstance, db);
  if (refusal) {
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // Look up local channel by federatedId
  const channel = db.select()
    .from(schema.dmChannels)
    .where(and(
      eq(schema.dmChannels.federatedId, event.federatedId),
      isNull(schema.dmChannels.deletedAt),
    ))
    .get();

  if (!channel) {
    accepted.push(event.messageId);
    return;
  }

  // Resolve the typing user (read-only), matched on homeUserId + homeInstance
  const typer = resolveRelayActor(event.typing, db);
  if (typer.kind === 'mismatch') {
    console.warn('[federation] Refused dm_typing_stop: the typing homeUserId names a local user of another identity');
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }
  if (typer.kind === 'unknown') {
    accepted.push(event.messageId);
    return;
  }
  const typingUser = typer.user;

  // Broadcast dm_typing_stop to local DM members
  const dmMembers = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channel.id))
    .all();

  for (const member of dmMembers) {
    if (member.userId !== typingUser.id) {
      connectionManager.sendToUser(member.userId, {
        type: 'dm_typing_stop',
        dmChannelId: channel.id,
        userId: typingUser.id,
      });
    }
  }

  accepted.push(event.messageId);
}


/** Emit a non-terminal dm_call_undeliverable for a host-side fan-out failure. */
export function emitHostFanoutUndeliverable(
  userId: string,
  dmChannelId: string,
  federatedId: string,
  phase: 'accept' | 'reject' | 'end',
  fanoutFailures: CallFanoutFailure[],
): void {
  if (fanoutFailures.length === 0) return;
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
