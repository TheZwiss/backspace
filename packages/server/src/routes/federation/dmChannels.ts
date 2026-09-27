import { getDb, schema } from '../../db/index.js';
import { getOurOrigin } from '../../utils/federationAuth.js';
import { relayTargetOrigins } from '../../utils/federationOutbox.js';
import { sanitizeUser } from '../../utils/sanitize.js';
import { generateSnowflake } from '../../utils/snowflake.js';
import { connectionManager } from '../../ws/handler.js';
import { getDmMessageWithUser } from '../dm.js';
import { extractDomain, relayActorOfUser, sameRelayActor, type RelayActor } from './identity.js';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FederatedCallEntry } from '../../ws/handler.js';
import type { DmChannel, DmMessageWithUser, FederationMessageRef } from '@backspace/shared';

/**
 * Build the full DM channel payload used by `dm_channel_created` events.
 * Hydrates members, fetches the last message, and returns a `DmChannel`-shaped
 * object — or `null` when the channel row doesn't exist / is deleted.
 *
 * An optional `lastMessageOverride` lets callers supply the message object
 * directly (e.g. the just-relayed message) instead of querying the DB.
 */
export function buildDmChannelPayload(
  channelId: string,
  db: ReturnType<typeof getDb>,
  lastMessageOverride?: DmMessageWithUser | null,
): DmChannel | null {
  const dmChannel = db.select()
    .from(schema.dmChannels)
    .where(and(eq(schema.dmChannels.id, channelId), isNull(schema.dmChannels.deletedAt)))
    .get();
  if (!dmChannel) return null;

  const allMemberRows = db.select()
    .from(schema.dmMembers)
    .where(eq(schema.dmMembers.dmChannelId, channelId))
    .all();
  const memberUserIds = allMemberRows.map(m => m.userId);
  const users = memberUserIds.length > 0
    ? db.select().from(schema.users).where(inArray(schema.users.id, memberUserIds)).all()
    : [];

  let lastMessage: DmMessageWithUser | null = lastMessageOverride ?? null;
  if (!lastMessageOverride) {
    const lastMsgRow = db.select({ id: schema.dmMessages.id })
      .from(schema.dmMessages)
      .where(eq(schema.dmMessages.dmChannelId, channelId))
      .orderBy(desc(schema.dmMessages.createdAt))
      .limit(1)
      .get();
    if (lastMsgRow) {
      lastMessage = getDmMessageWithUser(lastMsgRow.id);
    }
  }

  return {
    id: dmChannel.id,
    ownerId: dmChannel.ownerId ?? null,
    federatedId: dmChannel.federatedId ?? null,
    createdAt: dmChannel.createdAt,
    members: users.map(u => sanitizeUser(u)),
    lastMessage,
  };
}

// ─── Relay Event Processors ──────────────────────────────────────────────────


/**
 * Find or create a local DM channel for a federated DM.
 * Uses federated_id for deterministic cross-instance lookup.
 */
export function findOrCreateDmChannel(
  federatedId: string,
  localUserIds: string[],
  db: ReturnType<typeof getDb>,
): string {
  // Try to find existing channel by federated ID
  const existing = db
    .select()
    .from(schema.dmChannels)
    .where(eq(schema.dmChannels.federatedId, federatedId))
    .get();

  if (existing) {
    // Ensure all users are members (they might have been removed)
    for (const userId of localUserIds) {
      const member = db
        .select()
        .from(schema.dmMembers)
        .where(
          and(
            eq(schema.dmMembers.dmChannelId, existing.id),
            eq(schema.dmMembers.userId, userId),
          ),
        )
        .get();

      if (!member) {
        db.insert(schema.dmMembers)
          .values({
            dmChannelId: existing.id,
            userId,
            closed: 0,
          })
          .run();
      }
    }
    // Late-bind: if a FederatedCallEntry exists for this federatedId with null dmChannelId,
    // update it now that we have a local channel
    connectionManager.lateBindFederatedCall(federatedId, existing.id);
    return existing.id;
  }

  // Create new DM channel with federated ID
  const channelId = generateSnowflake();
  const now = Date.now();

  db.insert(schema.dmChannels)
    .values({
      id: channelId,
      federatedId,
      createdAt: now,
    })
    .run();

  for (const userId of localUserIds) {
    db.insert(schema.dmMembers)
      .values({
        dmChannelId: channelId,
        userId,
        closed: 0,
      })
      .run();
  }

  // Late-bind: if a FederatedCallEntry exists for this federatedId with null dmChannelId,
  // update it now that we have a local channel
  connectionManager.lateBindFederatedCall(federatedId, channelId);

  return channelId;
}


/**
 * Build a DmMessageWithUser payload for WebSocket broadcasting.
 */
export function buildDmMessagePayload(
  messageRow: {
    id: string;
    dmChannelId: string;
    userId: string;
    content: string | null;
    replyToId: string | null;
    editedAt: number | null;
    createdAt: number;
  },
  userRow: typeof schema.users.$inferSelect,
): DmMessageWithUser {
  return {
    id: messageRow.id,
    dmChannelId: messageRow.dmChannelId,
    channelId: messageRow.dmChannelId,
    userId: messageRow.userId,
    content: messageRow.content,
    replyToId: messageRow.replyToId,
    editedAt: messageRow.editedAt,
    createdAt: messageRow.createdAt,
    user: sanitizeUser(userRow),
    attachments: [],
    embeds: [],
    reactions: [],
  };
}


/**
 * Validate that a URL's hostname matches the peer origin's hostname (SSRF protection).
 */
export function isUrlFromPeer(sourceUrl: string, peerOrigin: string): boolean {
  try {
    const sourceHost = new URL(sourceUrl).hostname;
    const peerHost = new URL(peerOrigin).hostname;
    return sourceHost === peerHost;
  } catch {
    return false;
  }
}


/**
 * Resolve a local DM message from a federation relay event's canonical identity.
 * Uses messageHomeInstance to branch the lookup:
 * - If the message originated on THIS instance → find by local ID
 * - Otherwise → find by sourceInstance + sourceMessageId tracking
 * Falls back to relay sender origin when messageHomeInstance is absent (backward compat).
 */
export function resolveLocalDmMessage(
  canonicalMessageId: string,
  messageHomeInstance: string | undefined,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
): typeof schema.dmMessages.$inferSelect | undefined {
  if (messageHomeInstance && messageHomeInstance === getOurOrigin()) {
    return db
      .select()
      .from(schema.dmMessages)
      .where(
        and(
          eq(schema.dmMessages.id, canonicalMessageId),
          isNull(schema.dmMessages.sourceInstance),
        ),
      )
      .get();
  }
  const originInstance = messageHomeInstance || sourceInstance;
  return db
    .select()
    .from(schema.dmMessages)
    .where(
      and(
        eq(schema.dmMessages.sourceInstance, originInstance),
        eq(schema.dmMessages.sourceMessageId, canonicalMessageId),
      ),
    )
    .get();
}


/**
 * The local reply target for a relayed message's `replyTo` reference, or null.
 *
 * The reference names the replied-to message in federation coordinates and is
 * resolved like a reaction target. It is only adopted when it resolves to a
 * message in `dmChannelId`, the conversation the reply is being stored in, so
 * a relay can never point a local reply at another conversation. A target not
 * held here (yet) leaves the reply without a quote rather than rejecting it.
 */
export function resolveRelayedReplyTarget(
  ref: FederationMessageRef | null | undefined,
  sourceInstance: string,
  dmChannelId: string,
  db: ReturnType<typeof getDb>,
): string | null {
  if (!ref || typeof ref.messageId !== 'string' || typeof ref.messageHomeInstance !== 'string') {
    return null;
  }
  const target = resolveLocalDmMessage(ref.messageId, ref.messageHomeInstance, sourceInstance, db);
  return target && target.dmChannelId === dmChannelId ? target.id : null;
}


/** A DM channel member as the local user row it is: id and home identity. */
export interface DmChannelMember {
  id: string;
  homeUserId: string | null;
  homeInstance: string | null;
}

/** The members of a DM channel as local user rows. */
export function dmChannelMembers(
  dmChannelId: string,
  db: ReturnType<typeof getDb>,
): DmChannelMember[] {
  return db
    .select({ id: schema.users.id, homeUserId: schema.users.homeUserId, homeInstance: schema.users.homeInstance })
    .from(schema.dmMembers)
    .innerJoin(schema.users, eq(schema.dmMembers.userId, schema.users.id))
    .where(eq(schema.dmMembers.dmChannelId, dmChannelId))
    .all();
}


/**
 * The member of `members` who is the federated identity `actor` (same home
 * user id on the same home domain, `sameRelayActor`), or undefined.
 */
export function memberWithIdentity(
  members: readonly DmChannelMember[],
  actor: RelayActor,
): DmChannelMember | undefined {
  return members.find(m => {
    const identity = relayActorOfUser(m);
    return identity !== null && sameRelayActor(identity, actor);
  });
}


/**
 * Whether `sourceInstance` is one of `origins`. Compared by domain, the way
 * `attributionRefusal` compares instances: the origins are built from stored
 * `homeInstance` values, which are bare domains, while the signed source is a
 * full URL.
 */
export function isRelayTarget(origins: readonly string[], sourceInstance: string): boolean {
  const source = extractDomain(sourceInstance).toLowerCase();
  if (!source) return false;
  return origins.some(origin => extractDomain(origin).toLowerCase() === source);
}


/**
 * Whether `sourceInstance` may act as `actorId` in the conversation among
 * `members` (local user rows): the actor must be one of the members, and the
 * signing peer one of the origins this instance relays the conversation to
 * (`relayTargetOrigins`). Only those instances hold a copy of the conversation
 * that the action could have been taken in. Used for relayed message creates
 * and member adds; the rules are documented in docs/systems/dm-system.md,
 * "Relayed message creates" and "Relayed member adds".
 */
export function mayRelayInto(
  members: ReadonlyArray<{ id: string; homeInstance: string | null }>,
  actorId: string,
  sourceInstance: string,
): boolean {
  if (!members.some(m => m.id === actorId)) return false;
  return isRelayTarget(relayTargetOrigins(members), sourceInstance);
}


/**
 * The refusal for a relayed action by someone who is not a member of this
 * instance's copy of a conversation (or from a sender that copy is not
 * relayed to). A group's roster here changes through relayed member adds, and
 * an add made through a third instance can land after the new member's first
 * action, so a group refusal is `unauthorized_source`, which senders retry. A
 * 1-on-1 (no owner) is its fixed pair: `invalid_target`, terminal.
 */
export function nonMemberRefusal(channel: { ownerId: string | null }): 'unauthorized_source' | 'invalid_target' {
  return channel.ownerId ? 'unauthorized_source' : 'invalid_target';
}
