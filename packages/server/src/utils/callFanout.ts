import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getOurOrigin, normalizeOriginForCompare } from './federationAuth.js';
import { mapCallReasonToEventReason, sendCallRelay, type CallFanoutFailure, type CallRelayResult } from './federationOutbox.js';
import { generateSnowflake } from './snowflake.js';
import { relayActorOfUser, type RelayActor } from '../routes/federation/identity.js';
import type { FederationRelayEvent } from '@backspace/shared';

type Db = ReturnType<typeof getDb>;

/** The payload field that names who acted, per call event type. */
const ACTOR_FIELD = {
  dm_call_accept: 'acceptor',
  dm_call_reject: 'rejector',
  dm_call_end: 'endedBy',
} as const;

export type CallRelayEventType = keyof typeof ACTOR_FIELD;

/**
 * The federated identity a call event this instance signs names as its actor
 * when it goes to `target`. A peer accepts an actor homed on the instance
 * that signs the event, or one homed on the peer itself coming home
 * (`attributionRefusal`), and refuses any other. So the first of the local
 * users `candidateUserIds` (in order: the user whose action it is, then the
 * call's caller) that is homed here or on `target` is named. When none is,
 * the first candidate's own identity is named, which the target refuses, as
 * it would any other way of saying it. Null when no candidate has an
 * identity at all.
 *
 * The identity is the user's own (`relayActorOfUser`): a federated account or
 * a replicated row is named by its home, never by this instance's address.
 */
export function callRelayActor(target: string, candidateUserIds: readonly string[], db: Db): RelayActor | null {
  const ids = candidateUserIds.filter((id, index) => id.length > 0 && candidateUserIds.indexOf(id) === index);
  if (ids.length === 0) return null;
  const rows = db.select({ id: schema.users.id, homeUserId: schema.users.homeUserId, homeInstance: schema.users.homeInstance })
    .from(schema.users)
    .where(inArray(schema.users.id, ids))
    .all();
  const identities = ids
    .map(id => rows.find(r => r.id === id))
    .map(row => (row ? relayActorOfUser(row) : null))
    .filter((identity): identity is RelayActor => identity !== null);
  const ourKey = normalizeOriginForCompare(getOurOrigin());
  const targetKey = normalizeOriginForCompare(target);
  const accepted = identities.find(identity => {
    const homeKey = normalizeOriginForCompare(identity.homeInstance);
    return homeKey !== null && (homeKey === ourKey || homeKey === targetKey);
  });
  return accepted ?? identities[0] ?? null;
}

/** The origins of the peers that home a member of `dmChannelId`, as URLs, without this instance. */
function memberHomeOrigins(dmChannelId: string, db: Db): string[] {
  const members = db.select({ homeInstance: schema.users.homeInstance })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();
  const ourKey = normalizeOriginForCompare(getOurOrigin());
  const targets = new Map<string, string>();
  for (const m of members) {
    if (!m.homeInstance) continue;
    const origin = m.homeInstance.startsWith('http') ? m.homeInstance : `https://${m.homeInstance}`;
    const key = normalizeOriginForCompare(origin);
    if (key === null || key === ourKey || targets.has(key)) continue;
    targets.set(key, origin);
  }
  return Array.from(targets.values());
}

/** Build one call relay event naming `actor` in the field `eventType` uses. */
export function buildCallRelayEvent(
  eventType: CallRelayEventType,
  federatedId: string,
  actor: RelayActor | null,
  perMember: boolean,
): FederationRelayEvent {
  return {
    eventType,
    messageId: generateSnowflake(),
    encryptionVersion: 0,
    timestamp: Date.now(),
    federatedId,
    call: {
      ...(actor ? { [ACTOR_FIELD[eventType]]: actor } : {}),
      ...(perMember ? { perMember: true } : {}),
    },
  };
}

/**
 * Relay a call event this instance signs to `target` alone, naming the first
 * of `actorUserIds` the target accepts (`callRelayActor`).
 */
export function relayCallEvent(
  target: string,
  eventType: CallRelayEventType,
  federatedId: string,
  actorUserIds: readonly string[],
  perMember: boolean,
  db: Db = getDb(),
): Promise<CallRelayResult> {
  const actor = callRelayActor(target, actorUserIds, db);
  return sendCallRelay(target, [buildCallRelayEvent(eventType, federatedId, actor, perMember)]);
}

/**
 * Relay a call event for the call hosted here in `dmChannelId` to every peer
 * that homes a member of it, except `excludeOrigin` (the peer the event came
 * from, which already knows). Each peer gets its own event, naming the actor
 * that peer accepts (`callRelayActor` over `actorUserIds`). Returns the peers
 * the relay did not reach.
 */
export async function fanOutCallEvent(
  dmChannelId: string,
  eventType: CallRelayEventType,
  actorUserIds: readonly string[],
  excludeOrigin: string | undefined,
  db: Db = getDb(),
): Promise<CallFanoutFailure[]> {
  const channel = db.select({ federatedId: schema.dmChannels.federatedId })
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.id, dmChannelId))
    .get();
  if (!channel?.federatedId) return [];
  const federatedId = channel.federatedId;

  const excludeKey = excludeOrigin ? normalizeOriginForCompare(excludeOrigin) : null;
  const targets = memberHomeOrigins(dmChannelId, db)
    .filter(origin => excludeKey === null || normalizeOriginForCompare(origin) !== excludeKey);
  if (targets.length === 0) return [];

  const labelByOrigin = new Map<string, string | null>();
  for (const r of db.select({ origin: schema.federationPeers.origin, instanceName: schema.federationPeers.instanceName })
    .from(schema.federationPeers)
    .all()) {
    labelByOrigin.set(r.origin, r.instanceName ?? null);
  }

  const results = await Promise.all(
    targets.map(async origin => ({
      origin,
      result: await relayCallEvent(origin, eventType, federatedId, actorUserIds, false, db),
    })),
  );

  const failures: CallFanoutFailure[] = [];
  for (const { origin, result } of results) {
    if (!result.ok) {
      console.error('[federation] %s fan-out to %s failed (%s): %s', eventType, origin, result.reason, result.error);
      failures.push({
        origin,
        peerLabel: labelByOrigin.get(origin) ?? undefined,
        reason: mapCallReasonToEventReason(result.reason),
      });
    }
  }
  return failures;
}
