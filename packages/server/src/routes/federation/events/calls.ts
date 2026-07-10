import path from 'node:path';
import { getDb, schema } from '../../../db/index.js';
import { getOurOrigin } from '../../../utils/federationAuth.js';
import { mapCallReasonToEventReason, sendCallRelay } from '../../../utils/federationOutbox.js';
import { generateSnowflake } from '../../../utils/snowflake.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { CallFanoutFailure } from '../../../utils/federationOutbox.js';
import type { DmRoomMeta, FederatedCallEntry } from '../../../ws/handler.js';
import type { DmCallUndeliverableFailure, FederationRelayEvent, ServerEvent } from '@backspace/shared';
import { extractDomain, resolveLocalUser, resolveOrCreateReplicatedUser, verifyAttribution } from '../identity.js';

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
  if (!verifyAttribution(event.call.caller.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in dm_call_start: caller=${extractDomain(event.call.caller.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Find local DM channel by federatedId
  const channel = db.select({ id: schema.dmChannels.id })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, event.federatedId))
    .get();

  // Resolve caller to local stub
  const callerStub = resolveOrCreateReplicatedUser(
    event.call.caller.homeUserId,
    event.call.caller.homeInstance,
    db,
    { username: event.call.caller.displayName },
  );
  if (!callerStub) {
    rejected.push({ messageId: event.messageId, reason: 'participant_not_found' });
    return;
  }

  const ringedUserIds: string[] = [];

  if (channel) {
    // ── Path A: DM exists locally ──
    const localDmChannelId = channel.id;

    const localMembers = db.select({
      userId: schema.dmMembers.userId,
      homeUserId: schema.users.homeUserId,
      homeInstance: schema.users.homeInstance,
    })
      .from(schema.dmMembers)
      .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
      .where(eq(schema.dmMembers.dmChannelId, localDmChannelId))
      .all();

    for (const member of localMembers) {
      const homeUserId = member.homeUserId || member.userId;
      // Bug 1 fix: don't ring the caller on this instance
      if (homeUserId === event.call.caller.homeUserId) continue;

      // #18: skip offline members. Entry-vs-no-entry decision uses the same
      // connection-count signal Path B has always used — keeps the two paths
      // symmetric in what counts as "ringed."
      if (connectionManager.getUserConnections(member.userId).size === 0) continue;

      const token = event.call!.tokens![homeUserId];
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
      tokens: new Map(Object.entries(event.call.tokens)),
      ringedUserIds,
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
      const localUser = db.select({ id: schema.users.id, homeUserId: schema.users.homeUserId })
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

      const homeUserId = localUser.homeUserId || localUser.id;
      const token = event.call!.tokens![homeUserId];
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
      tokens: new Map(Object.entries(event.call.tokens)),
      ringedUserIds,
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

  if (!verifyAttribution(event.call.acceptor.homeInstance, sourceInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
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

      // Join caller to room
      connectionManager.leaveCurrentRoom(meta.callerId);
      connectionManager.joinRoom(dmChannelId!, meta.callerId);

      connectionManager.sendToDmMembers(dmChannelId!, {
        type: 'voice_state_update',
        channelId: dmChannelId!,
        userId: meta.callerId,
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
    void fanOutCallEvent(localDmId, event.federatedId, 'dm_call_accept', {
      call: { acceptor: event.call.acceptor },
    }, normalizedSource, db).then(failures => {
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

  if (!verifyAttribution(event.call.rejector.homeInstance, sourceInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
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
    connectionManager.clearVoiceWs(meta.callerId);
    connectionManager.destroyRoom(localDmId);

    connectionManager.sendToDmMembers(localDmId, {
      type: 'dm_call_rejected',
      dmChannelId: localDmId,
    });

    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    void fanOutCallEvent(localDmId, event.federatedId, 'dm_call_end', {
      call: { endedBy: event.call.rejector },
    }, normalizedSource, db).then(failures => {
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

  if (!verifyAttribution(event.call.endedBy.homeInstance, sourceInstance)) {
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
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
    connectionManager.clearVoiceWs(meta.callerId);
    for (const pid of room.participants) {
      connectionManager.clearVoiceUserStatus(pid);
      connectionManager.clearVoiceWs(pid);
    }
    connectionManager.destroyRoom(localDmId);

    connectionManager.sendToDmMembers(localDmId, {
      type: 'dm_call_ended',
      dmChannelId: localDmId,
    });

    const normalizedSource = sourceInstance.startsWith('http') ? sourceInstance : `https://${sourceInstance}`;
    void fanOutCallEvent(localDmId, event.federatedId, 'dm_call_end', {
      call: { endedBy: event.call.endedBy },
    }, normalizedSource, db).then(failures => {
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

  // Resolve the typing user (read-only — don't create stubs for ephemeral events)
  const typingUser = resolveLocalUser(event.typing.homeUserId, db);
  if (!typingUser) {
    // User stub doesn't exist — discard silently
    accepted.push(event.messageId);
    return;
  }

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

  // Resolve the typing user (read-only)
  const typingUser = resolveLocalUser(event.typing.homeUserId, db);
  if (!typingUser) {
    accepted.push(event.messageId);
    return;
  }

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


/**
 * Fan out a call event to all remote instances with DM members,
 * optionally excluding the instance that triggered the event.
 */
export async function fanOutCallEvent(
  dmChannelId: string,
  federatedId: string,
  eventType: 'dm_call_accept' | 'dm_call_reject' | 'dm_call_end',
  extraFields: Partial<FederationRelayEvent>,
  excludeOrigin: string | undefined,
  db: ReturnType<typeof getDb>,
): Promise<CallFanoutFailure[]> {
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
      if (normalized !== ourOrigin && normalized !== excludeOrigin) {
        targets.add(normalized);
      }
    }
  }
  if (targets.size === 0) return [];

  const relayEvent: FederationRelayEvent = {
    eventType,
    messageId: generateSnowflake(),
    encryptionVersion: 0,
    timestamp: Date.now(),
    federatedId,
    ...extraFields,
  } as FederationRelayEvent;

  const labelByOrigin = new Map<string, string | null>();
  for (const r of db.select({ origin: schema.federationPeers.origin, instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .all()) {
    labelByOrigin.set(r.origin, r.instanceName ?? null);
  }

  const results = await Promise.all(
    Array.from(targets).map(async origin => ({ origin, result: await sendCallRelay(origin, [relayEvent]) })),
  );

  const failures: CallFanoutFailure[] = [];
  for (const { origin, result } of results) {
    if (!result.ok) {
      console.error(`[federation] Fan-out ${eventType} to ${origin} failed (${result.reason}): ${result.error}`);
      failures.push({
        origin,
        peerLabel: labelByOrigin.get(origin) ?? undefined,
        reason: mapCallReasonToEventReason(result.reason),
      });
    }
  }
  return failures;
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
