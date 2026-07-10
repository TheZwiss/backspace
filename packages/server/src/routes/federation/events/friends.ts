import { getDb, schema } from '../../../db/index.js';
import { getOurOrigin, normalizeOriginForCompare } from '../../../utils/federationAuth.js';
import { sanitizeUser } from '../../../utils/sanitize.js';
import { generateSnowflake } from '../../../utils/snowflake.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, eq, or } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';
import { extractDomain, resolveLocalUser, resolveOrCreateReplicatedUser, verifyAttribution } from '../identity.js';
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
  if (!verifyAttribution(from.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_request_create: from homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
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

  // Resolve the recipient — must be a local user on this instance
  const toUser = resolveLocalUser(to.homeUserId, db);
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
  if (!verifyAttribution(to.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_request_update: to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve the sender — must be a local user (the one who sent the original request)
  const fromUser = resolveLocalUser(from.homeUserId, db);
  if (!fromUser) {
    rejected.push({ messageId: event.messageId, reason: 'sender_not_found' });
    return;
  }

  // Resolve the recipient (create stub if needed — they're on the remote instance)
  const toUser = resolveOrCreateReplicatedUser(to.homeUserId, to.homeInstance, db, { username: event.friendship.toProfile?.username, status: event.friendship.toProfile?.status, deleted: event.friendship.toProfile?.deleted });
  if (!toUser) {
    // Recipient's identity has been deleted — accept idempotently to drop the event
    accepted.push(event.messageId);
    return;
  }

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

  // Update request status
  db.update(schema.friendRequests)
    .set({ status: status as string })
    .where(eq(schema.friendRequests.id, pendingRequest.id))
    .run();

  if (status === 'accepted') {
    const now = event.friendship.createdAt || Date.now();
    connectionManager.sendToUser(fromUser.id, {
      type: 'friend_request_accepted',
      friend: {
        ...sanitizeUser(toUser),
        addedAt: now,
      },
      requestId: pendingRequest.id,
    });
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
  if (!verifyAttribution(from.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_request_cancel: from homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve both users — must both exist locally for there to be a pending request
  const fromUser = resolveLocalUser(from.homeUserId, db);
  const toUser = resolveLocalUser(to.homeUserId, db);

  if (!fromUser || !toUser) {
    // Accept idempotently — if either user doesn't exist, there's nothing to cancel
    accepted.push(event.messageId);
    return;
  }

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
  if (!verifyAttribution(to.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_add: to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve both users (create stubs if needed) and hydrate with profile data
  const fromUserResolved = resolveOrCreateReplicatedUser(from.homeUserId, from.homeInstance, db, { username: event.friendship.fromProfile?.username, status: event.friendship.fromProfile?.status, deleted: event.friendship.fromProfile?.deleted });
  if (!fromUserResolved) {
    // One party's identity is deleted — accept idempotently to drop the event
    accepted.push(event.messageId);
    return;
  }
  let fromUser = await hydrateReplicatedUserProfile(fromUserResolved, event.friendship.fromProfile, db);
  const toUserResolved = resolveOrCreateReplicatedUser(to.homeUserId, to.homeInstance, db, { username: event.friendship.toProfile?.username, status: event.friendship.toProfile?.status, deleted: event.friendship.toProfile?.deleted });
  if (!toUserResolved) {
    accepted.push(event.messageId);
    return;
  }
  let toUser = await hydrateReplicatedUserProfile(toUserResolved, event.friendship.toProfile, db);

  // Idempotency: if friendship already exists, accept as no-op
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

  // Insert friendship row
  const now = event.friendship.createdAt || Date.now();
  db.insert(schema.friends)
    .values({
      userId: fromUser.id,
      friendId: toUser.id,
      createdAt: now,
    })
    .run();

  // Auto-resolve any pending friend request between these users to 'accepted'
  // (handles friend_add arriving before friend_request_update)
  db.update(schema.friendRequests)
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
    // Use empty string for requestId since the request may not exist locally yet
    requestId: '',
  });

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
  if (!verifyAttribution(from.homeInstance, sourceInstance) && !verifyAttribution(to.homeInstance, sourceInstance)) {
    console.warn(`[federation] Attribution mismatch in friend_remove: from homeInstance=${extractDomain(from.homeInstance)} to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve both users — must both exist locally for there to be a friendship
  const fromUser = resolveLocalUser(from.homeUserId, db);
  const toUser = resolveLocalUser(to.homeUserId, db);

  if (!fromUser || !toUser) {
    // Accept idempotently — if either user doesn't exist locally, nothing to remove
    accepted.push(event.messageId);
    return;
  }

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
