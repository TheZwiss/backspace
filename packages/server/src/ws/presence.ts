import { eq } from 'drizzle-orm';
import { ownsChosenStatus, type Activity, type ChosenUserStatus } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';
import { connectionManager } from './handler.js';
import { collectProfileBroadcastTargetIds } from '../utils/userDeletion.js';

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
  const payload = {
    type: 'presence_update' as const,
    userId,
    status,
    ...(activities.length > 0 ? { activities } : {}),
  };
  for (const uid of collectProfileBroadcastTargetIds(userId)) connectionManager.sendToUser(uid, payload);
  connectionManager.sendToUser(userId, payload);

  void import('../utils/federationPresence.js').then(({ queuePresenceRelay }) => {
    try { queuePresenceRelay(userId, status, activities); } catch (e) { console.warn('[presence] queuePresenceRelay(chosen) failed', e); }
  });
}
