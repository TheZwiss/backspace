import { getDb, schema } from '../../../db/index.js';
import { getOurOrigin, normalizeOriginForCompare } from '../../../utils/federationAuth.js';
import { sanitizeUser } from '../../../utils/sanitize.js';
import { generateSnowflake } from '../../../utils/snowflake.js';
import { connectionManager } from '../../../ws/handler.js';
import { exchangeFriendPresence } from '../../../ws/presence.js';
import { and, eq, or } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';
import { extractDomain, resolveOrCreateReplicatedUser, resolveRelayActor, attributionRefusal } from '../identity.js';
import { hydrateReplicatedUserProfile } from '../profile.js';

export async function processFriendRequestCreateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: sender must belong to source instance (FED-010)
  const refusal = attributionRefusal(from, sourceInstance, db);
  if (refusal) {
    console.warn(`[federation] Attribution refused (${refusal}) in friend_request_create: from homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // Self-target guard (defense-in-depth): from-identity must not equal to-identity.
  // Sender's local cannot_friend_self check should catch this, but the receiver must not trust it.
  if (
    from.homeUserId === to.homeUserId &&
    normalizeOriginForCompare(from.homeInstance) === normalizeOriginForCompare(to.homeInstance)
  ) {
    console.warn(`[federation] Self-target friend_request_create rejected: homeUserId=${from.homeUserId} homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'self_target_invalid' });
    return;
  }

  // Resolve the sender (create stub if needed — they're on a remote instance)
  const fromUserResolved = resolveOrCreateReplicatedUser(from.homeUserId, from.homeInstance, db, { username: event.friendship.fromProfile?.username, status: event.friendship.fromProfile?.status, deleted: event.friendship.fromProfile?.deleted });
  if (!fromUserResolved) {
    // Sender's identity has been deleted — silently accept to drop the event
    accepted.push(event.messageId);
    return;
  }
  let fromUser = await hydrateReplicatedUserProfile(fromUserResolved, event.friendship.fromProfile, db);

  // The recipient is the local user that IS the `to` identity, never a row
  // that only shares its homeUserId (such as the sender resolved just above).
  const recipient = resolveRelayActor(to, db);
  const toUser = recipient.kind === 'found' ? recipient.user : undefined;
  if (!toUser) {
    rejected.push({ messageId: event.messageId, reason: 'recipient_not_found' });
    return;
  }

  // Idempotency: if already friends, accept as no-op
  const existingFriend = db
    .select()
    .from(schema.friends)
    .where(
      or(
        and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
        and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
      ),
    )
    .get();

  if (existingFriend) {
    accepted.push(event.messageId);
    return;
  }

  // Idempotency: a pending request in EITHER direction makes this event a no-op.
  //   Forward (from→to): re-delivery of an event we've already processed.
  //   Reverse (to→from): the local user has already sent a request TO this remote sender.
  //     Race window: both sides click "add friend" near-simultaneously. Each sender's both-direction
  //     check passes locally (no rows yet anywhere). When the events cross, each receiver must
  //     treat the reverse-direction collision as idempotent — otherwise both instances end up
  //     with two opposite-direction pending rows for the same logical pair. Mirror the
  //     sender-side both-direction check (`incoming_request_exists` in social.ts).
  const existingRequest = db
    .select()
    .from(schema.friendRequests)
    .where(
      and(
        or(
          and(eq(schema.friendRequests.fromId, fromUser.id), eq(schema.friendRequests.toId, toUser.id)),
          and(eq(schema.friendRequests.fromId, toUser.id), eq(schema.friendRequests.toId, fromUser.id)),
        ),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (existingRequest) {
    accepted.push(event.messageId);
    return;
  }

  // Create the friend request
  const id = generateSnowflake();
  const now = event.friendship.createdAt || Date.now();

  db.insert(schema.friendRequests)
    .values({
      id,
      fromId: fromUser.id,
      toId: toUser.id,
      status: 'pending',
      createdAt: now,
    })
    .run();

  // Broadcast to the recipient
  connectionManager.sendToUser(toUser.id, {
    type: 'friend_request_received',
    request: {
      id,
      fromId: fromUser.id,
      toId: toUser.id,
      status: 'pending' as const,
      createdAt: now,
      user: sanitizeUser(fromUser),
    },
  });

  accepted.push(event.messageId);
}


export function processFriendRequestUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.friendship || !event.friendship.status) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to, status } = event.friendship;

  // Attribution: recipient (acceptor/decliner) must belong to source instance (FED-010)
  const refusal = attributionRefusal(to, sourceInstance, db);
  if (refusal) {
    console.warn(`[federation] Attribution refused (${refusal}) in friend_request_update: to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // Both sides are the users that ARE the event's identities here, found by
  // pair (homeUserId + homeInstance), never by homeUserId alone: an acceptance
  // forms a friendship, so it must land on the requester the pending request
  // belongs to, judged the same way friend_add judges it. Nothing is created.
  //
  // The sender sent the original request from here, so it must exist.
  const fromResolved = resolveRelayActor(from, db);
  if (fromResolved.kind !== 'found') {
    rejected.push({ messageId: event.messageId, reason: 'sender_not_found' });
    return;
  }
  const fromUser = fromResolved.user;

  // A recipient this instance does not hold has no pending request here to
  // answer: accept without effect.
  const toResolved = resolveRelayActor(to, db);
  if (toResolved.kind !== 'found') {
    accepted.push(event.messageId);
    return;
  }
  const toUser = toResolved.user;

  // Find the pending request
  const pendingRequest = db
    .select()
    .from(schema.friendRequests)
    .where(
      and(
        eq(schema.friendRequests.fromId, fromUser.id),
        eq(schema.friendRequests.toId, toUser.id),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (!pendingRequest) {
    // Accept idempotently — friend_add may have arrived first
    accepted.push(event.messageId);
    return;
  }

  // Update request status. An acceptance answers our user's pending request,
  // so it also forms the friendship here, in the same transaction: the
  // friend_add that follows it then finds the friendship and is a no-op (it
  // finds no pending request to answer any more).
  const now = event.friendship.createdAt || Date.now();
  db.transaction((tx) => {
    tx.update(schema.friendRequests)
      .set({ status: status as string })
      .where(eq(schema.friendRequests.id, pendingRequest.id))
      .run();
    if (status === 'accepted') {
      const existingFriend = tx
        .select({ userId: schema.friends.userId })
        .from(schema.friends)
        .where(
          or(
            and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
            and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
          ),
        )
        .get();
      if (!existingFriend) {
        tx.insert(schema.friends).values({ userId: fromUser.id, friendId: toUser.id, createdAt: now }).run();
      }
    }
  });

  if (status === 'accepted') {
    connectionManager.sendToUser(fromUser.id, {
      type: 'friend_request_accepted',
      friend: {
        ...sanitizeUser(toUser),
        addedAt: now,
      },
      requestId: pendingRequest.id,
    });
    // Each side sees the other's current status and activity now (#340).
    exchangeFriendPresence(fromUser.id, toUser.id);
  } else if (status === 'declined') {
    connectionManager.sendToUser(fromUser.id, {
      type: 'friend_request_declined',
      requestId: pendingRequest.id,
      userId: toUser.id,
    });
  }

  accepted.push(event.messageId);
}


export function processFriendRequestCancelEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: sender must belong to source instance (FED-010)
  const refusal = attributionRefusal(from, sourceInstance, db);
  if (refusal) {
    console.warn(`[federation] Attribution refused (${refusal}) in friend_request_cancel: from homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // Resolve both users by homeUserId + homeInstance; they must both exist
  // locally for there to be a pending request. The sender is the attributed
  // actor, so a sender id that names a local user of another identity is refused.
  const fromResolved = resolveRelayActor(from, db);
  if (fromResolved.kind === 'mismatch') {
    console.warn('[federation] Refused friend_request_cancel: the sender homeUserId names a local user of another identity');
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }
  const toResolved = resolveRelayActor(to, db);

  if (fromResolved.kind !== 'found' || toResolved.kind !== 'found') {
    // Accept idempotently — if either user doesn't exist, there's nothing to cancel
    accepted.push(event.messageId);
    return;
  }
  const fromUser = fromResolved.user;
  const toUser = toResolved.user;

  // Find the pending request
  const pendingRequest = db
    .select()
    .from(schema.friendRequests)
    .where(
      and(
        eq(schema.friendRequests.fromId, fromUser.id),
        eq(schema.friendRequests.toId, toUser.id),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (!pendingRequest) {
    // Accept idempotently — already cancelled or never existed
    accepted.push(event.messageId);
    return;
  }

  // Delete the request
  db.delete(schema.friendRequests)
    .where(eq(schema.friendRequests.id, pendingRequest.id))
    .run();

  // Broadcast to the recipient
  connectionManager.sendToUser(toUser.id, {
    type: 'friend_request_cancelled',
    requestId: pendingRequest.id,
    userId: fromUser.id,
  });

  accepted.push(event.messageId);
}


export async function processFriendAddEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: acceptor must belong to source instance (FED-010)
  const refusal = attributionRefusal(to, sourceInstance, db);
  if (refusal) {
    console.warn(`[federation] Attribution refused (${refusal}) in friend_add: to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // A friend_add is the recipient's answer to a request: it forms a friendship
  // only for a pair this instance holds a pending request for, from `from` (the
  // requester) to `to` (the acceptor), or for one that already exists. The
  // requester's home created that row when the request was made, in the same
  // transaction that queued friend_request_create, so it is there before any
  // answer can arrive. Both users therefore already exist here, and nothing is
  // created for a pair that never had a request.
  const fromResolved = resolveRelayActor(from, db);
  const toResolved = resolveRelayActor(to, db);
  const pair = fromResolved.kind === 'found' && toResolved.kind === 'found'
    ? { fromUser: fromResolved.user, toUser: toResolved.user }
    : null;

  // Idempotency: if friendship already exists, accept as no-op
  const existingFriend = pair && db
    .select()
    .from(schema.friends)
    .where(
      or(
        and(eq(schema.friends.userId, pair.fromUser.id), eq(schema.friends.friendId, pair.toUser.id)),
        and(eq(schema.friends.userId, pair.toUser.id), eq(schema.friends.friendId, pair.fromUser.id)),
      ),
    )
    .get();

  if (existingFriend) {
    accepted.push(event.messageId);
    return;
  }

  const pendingRequest = pair && db
    .select({ id: schema.friendRequests.id })
    .from(schema.friendRequests)
    .where(
      and(
        eq(schema.friendRequests.fromId, pair.fromUser.id),
        eq(schema.friendRequests.toId, pair.toUser.id),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (!pair || !pendingRequest) {
    console.warn(`[federation] Refused friend_add from ${extractDomain(sourceInstance)}: no pending request from the requester to the acceptor here`);
    rejected.push({ messageId: event.messageId, reason: 'invalid_target' });
    return;
  }

  const fromUser = await hydrateReplicatedUserProfile(pair.fromUser, event.friendship.fromProfile, db);
  const toUser = await hydrateReplicatedUserProfile(pair.toUser, event.friendship.toProfile, db);

  // Insert the friendship and resolve the request it answers (and a crossed
  // one the other way, if any) to 'accepted', together. The friend_request_update
  // that may still follow then finds no pending request and is a no-op.
  const now = event.friendship.createdAt || Date.now();
  db.transaction((tx) => {
    tx.insert(schema.friends)
      .values({
        userId: fromUser.id,
        friendId: toUser.id,
        createdAt: now,
      })
      .run();
    tx.update(schema.friendRequests)
      .set({ status: 'accepted' })
      .where(
        and(
          or(
            and(eq(schema.friendRequests.fromId, fromUser.id), eq(schema.friendRequests.toId, toUser.id)),
            and(eq(schema.friendRequests.fromId, toUser.id), eq(schema.friendRequests.toId, fromUser.id)),
          ),
          eq(schema.friendRequests.status, 'pending'),
        ),
      )
      .run();
  });

  // Determine which user is local and broadcast to them
  const ourOrigin = getOurOrigin();
  const localUser = from.homeInstance === ourOrigin ? fromUser : toUser;
  const remoteUser = from.homeInstance === ourOrigin ? toUser : fromUser;

  connectionManager.sendToUser(localUser.id, {
    type: 'friend_request_accepted',
    friend: {
      ...sanitizeUser(remoteUser),
      addedAt: now,
    },
    // The pending request this friend_add answered (the acceptance check above)
    requestId: pendingRequest.id,
  });
  // Each side sees the other's current status and activity now (#340).
  exchangeFriendPresence(fromUser.id, toUser.id);

  accepted.push(event.messageId);
}


export function processFriendRemoveEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: at least one side must belong to source instance (FED-010)
  // Either side may end the friendship, so the peer only has to be able to
  // speak for one of them. When neither is attributable, the refusal is only
  // permanent if both are: a side whose proof is still on its way may yet pass.
  const fromRefusal = attributionRefusal(from, sourceInstance, db);
  const toRefusal = fromRefusal ? attributionRefusal(to, sourceInstance, db) : null;
  if (fromRefusal && toRefusal) {
    const refusal = fromRefusal === 'attribution_unproven' || toRefusal === 'attribution_unproven'
      ? 'attribution_unproven'
      : 'attribution_mismatch';
    console.warn(`[federation] Attribution refused (${refusal}) in friend_remove: from homeInstance=${extractDomain(from.homeInstance)} to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: refusal });
    return;
  }

  // Resolve both users by homeUserId + homeInstance; they must both exist
  // locally for there to be a friendship. The side attribution accepted is the
  // actor, so an actor id that names a local user of another identity is refused.
  const fromResolved = resolveRelayActor(from, db);
  const toResolved = resolveRelayActor(to, db);
  const actorResolved = fromRefusal ? toResolved : fromResolved;
  if (actorResolved.kind === 'mismatch') {
    console.warn('[federation] Refused friend_remove: the actor homeUserId names a local user of another identity');
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  if (fromResolved.kind !== 'found' || toResolved.kind !== 'found') {
    // Accept idempotently — if either user doesn't exist locally, nothing to remove
    accepted.push(event.messageId);
    return;
  }
  const fromUser = fromResolved.user;
  const toUser = toResolved.user;

  // Delete friendship in both directions
  db.delete(schema.friends)
    .where(
      or(
        and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
        and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
      ),
    )
    .run();

  // Determine which user is local (the one whose home instance is NOT the source)
  // The removing user is on the source instance; broadcast to the other user
  const ourOrigin = getOurOrigin();
  const localUser = from.homeInstance === ourOrigin ? fromUser : toUser;
  const removingUser = from.homeInstance === ourOrigin ? toUser : fromUser;

  connectionManager.sendToUser(localUser.id, {
    type: 'friend_removed',
    userId: removingUser.id,
  });

  accepted.push(event.messageId);
}
