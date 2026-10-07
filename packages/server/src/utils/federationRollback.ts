/**
 * Permanent-failure callback registry for outbox events.
 *
 * When the federation worker observes a receiver-acknowledged terminal
 * rejection (4xx with a recognized reason like 'recipient_not_found'),
 * it invokes the registered callback for the eventType so the originating
 * instance can roll back any local state created at queue time.
 *
 * Callbacks are NEVER invoked on transient failures (5xx, network errors,
 * retry exhaustion). Only on receiver-acknowledged terminal rejections.
 *
 * Errors thrown by callbacks are logged but not re-thrown — rollback failure
 * must not prevent the outbox entry from being deleted.
 */
import { getDb } from '../db/index.js';
import * as schema from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { connectionManager } from '../ws/handler.js';

type PermanentFailureCallback = (messageId: string, reason: string) => void;

const callbacks = new Map<string, PermanentFailureCallback>();

export function registerPermanentFailureCallback(eventType: string, cb: PermanentFailureCallback): void {
  callbacks.set(eventType, cb);
}

export function invokePermanentFailureCallback(eventType: string, messageId: string, reason: string): void {
  const cb = callbacks.get(eventType);
  if (!cb) return;
  try {
    cb(messageId, reason);
    withdrawFromMutationLog(eventType, messageId);
  } catch (err) {
    console.error(
      '[federation-rollback] callback for %s (msg=%s, reason=%s) threw:',
      eventType,
      messageId,
      reason,
      err,
    );
  }
}

/**
 * An event whose local effect was just rolled back is withdrawn from the
 * mutation log too: `/api/federation/sync` must not keep serving an event
 * this instance took back, or a peer's later pull would apply what the
 * sender withdrew (a friend request the sender no longer has).
 */
function withdrawFromMutationLog(eventType: string, messageId: string): void {
  getDb()
    .delete(schema.federationMutationLog)
    .where(and(
      eq(schema.federationMutationLog.entityId, messageId),
      eq(schema.federationMutationLog.mutationType, eventType),
    ))
    .run();
}

/** Test-only: clear the registry between tests. */
export function _resetCallbacks(): void {
  callbacks.clear();
}

/**
 * Rollback handler for 'friend_request_create' outbox events.
 *
 * Deletes the pending friend request row whose relayMessageId matches the
 * failed outbox message, then notifies the sender via WebSocket so the client
 * can surface an appropriate error toast.
 */
export function rollbackFriendRequestCreate(messageId: string, receiverReason: string): void {
  const db = getDb();

  const row = db
    .select()
    .from(schema.friendRequests)
    .where(eq(schema.friendRequests.relayMessageId, messageId))
    .get();

  if (!row) return; // Idempotent — no row to roll back.

  // Look up recipient handle for the toast text BEFORE deleting.
  const recipient = db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, row.toId))
    .get();
  const targetHandle = recipient?.username ?? 'unknown';

  db.delete(schema.friendRequests).where(eq(schema.friendRequests.id, row.id)).run();

  // Reason mapping: receiver-side reason → client-facing reason.
  //   'recipient_not_found' → 'user_not_found' (the looked-up identity vanished)
  //   anything else         → 'peer_rejected' (catch-all)
  const reason: 'user_not_found' | 'peer_rejected' =
    receiverReason === 'recipient_not_found' ? 'user_not_found' : 'peer_rejected';

  const message =
    reason === 'user_not_found'
      ? `User ${targetHandle} no longer exists on the remote instance.`
      : `Friend request to ${targetHandle} was rejected by the remote instance.`;

  connectionManager.sendToUser(row.fromId, {
    type: 'friend_request_relay_failed',
    requestId: row.id,
    reason,
    message,
    targetHandle,
  });
}

// Register the callback at module-load time so the worker invokes it.
registerPermanentFailureCallback('friend_request_create', rollbackFriendRequestCreate);
