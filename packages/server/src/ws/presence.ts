import { eq } from 'drizzle-orm';
import { ownsChosenStatus, type Activity, type ChosenUserStatus } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { connectionManager } from './handler.js';
import { collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';
import { presenceUpdateEvent, presenceUpdateFor, snapshotActivities } from './presenceEvent.js';

/**
 * The one path for a user changing their own status, shared by REST
 * `PATCH /api/users/@me` and the WS `presence_update` client event.
 *
 * - A row that owns its choice (native or detached, `ownsChosenStatus`): writes
 *   `chosen_status`, so the choice survives disconnects, restarts and the boot
 *   presence reset.
 * - Replicated row: the choice belongs to the home instance, so only the live
 *   `status` moves. `chosen_status` on a replicated row is never written here
 *   and never read anywhere.
 * - Live `status` follows only while the user has a connection: 'offline'
 *   keeps meaning "no connection". Without one, nobody is told anything; the
 *   next socket auth publishes the choice (utils/presenceStatus.ts).
 * - While connected: updates the in-memory status cache (later activity
 *   broadcasts read it), tells friends, DM and space co-members and the user's
 *   own other sessions, and relays to peers (a no-op for replicated rows).
 */
export function applyChosenStatus(userId: string, status: ChosenUserStatus): void {
  const db = getDb();
  const row = db
    .select({ homeInstance: schema.users.homeInstance, federationHomeOrphaned: schema.users.federationHomeOrphaned })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (!row) return;

  const ownsChoice = ownsChosenStatus(row);
  const connected = connectionManager.isUserOnline(userId);

  if (ownsChoice && connected) {
    db.update(schema.users).set({ chosenStatus: status, status }).where(eq(schema.users.id, userId)).run();
  } else if (ownsChoice) {
    db.update(schema.users).set({ chosenStatus: status }).where(eq(schema.users.id, userId)).run();
  } else if (connected) {
    db.update(schema.users).set({ status }).where(eq(schema.users.id, userId)).run();
  }

  if (!connected) return;

  connectionManager.setUserStatus(userId, status);
  const activities: Activity[] = connectionManager.getUserActivities(userId);
  const payload = presenceUpdateFor(userId, status, activities.length > 0 ? activities : undefined);
  for (const uid of collectProfileBroadcastTargetIds(userId)) connectionManager.sendToUser(uid, payload);
  connectionManager.sendToUser(userId, payload);

  void import('../utils/federationPresence.js').then(({ queuePresenceRelay }) => {
    try { queuePresenceRelay(userId, status, activities); } catch (e) { console.warn('[presence] queuePresenceRelay(chosen) failed', e); }
  });
}

/**
 * Send `recipientId`'s sessions the current presence of `subjectId`: status and
 * the activity snapshot (live or relayed activities, else the custom status),
 * as the ready payload would report them. An offline subject reports no
 * activities.
 */
export function sendPresenceSnapshot(recipientId: string, subjectId: string): void {
  const subject = getDb()
    .select({
      id: schema.users.id,
      homeUserId: schema.users.homeUserId,
      homeInstance: schema.users.homeInstance,
      status: schema.users.status,
      customStatus: schema.users.customStatus,
    })
    .from(schema.users)
    .where(eq(schema.users.id, subjectId))
    .get();
  if (!subject) return;
  const status = subject.status ?? 'offline';
  const activities = status === 'offline'
    ? []
    : snapshotActivities(connectionManager.getUserActivities(subject.id), subject.customStatus);
  connectionManager.sendToUser(recipientId, presenceUpdateEvent(subject, status, activities));
}

/**
 * A friendship between two rows of this instance was just created. Presence
 * events only fire on change, so without this a friend who was already in a
 * game when the friendship formed would show none until it changed (#340).
 *
 * - Each side's sessions get the other's current presence.
 * - For each native side whose new friend is replicated, the friend's home is
 *   sent the native's current presence, so it can keep the activities and tell
 *   the friend (`snapshotPresenceForFriend`).
 */
export function exchangeFriendPresence(userIdA: string, userIdB: string): void {
  // Best effort: the friendship is already committed and its own relay still
  // has to go out, so nothing here may throw into the caller.
  try {
    sendPresenceSnapshot(userIdA, userIdB);
    sendPresenceSnapshot(userIdB, userIdA);
    const activitiesA = connectionManager.getUserActivities(userIdA);
    const activitiesB = connectionManager.getUserActivities(userIdB);
    // Imported lazily: federationPresence reaches the federation routes, which
    // import the WS handler that imports this module.
    void import('../utils/federationPresence.js')
      .then(({ snapshotPresenceForFriend }) => {
        snapshotPresenceForFriend(userIdA, userIdB, activitiesA);
        snapshotPresenceForFriend(userIdB, userIdA, activitiesB);
      })
      .catch((e: unknown) => { console.warn('[presence] snapshotPresenceForFriend failed', e); });
  } catch (e) {
    console.warn('[presence] exchangeFriendPresence failed', e);
  }
}
