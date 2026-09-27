import { and, eq, inArray, ne } from 'drizzle-orm';
import { ownsChosenStatus } from '@backspace/shared';
import { getDb, schema } from '../db/index.js';

/**
 * Reset orphaned presence state at server boot.
 *
 * `users.status` is only flipped back to `'offline'` by the WebSocket
 * disconnect path (`ConnectionManager.finalizeDisconnect` after a 5s grace
 * timer). When the server process exits — deploy, crash, OOM, kill — those
 * in-memory grace timers are lost and any rows currently set to `'online'`,
 * `'idle'`, or `'dnd'` stay frozen at that value forever, causing users to
 * appear permanently online to friends and space co-members until they next
 * connect.
 *
 * At boot, the in-memory `ConnectionManager` is empty by construction, so
 * any non-`offline` status row this instance owns is by definition stale and
 * safe to reset.
 *
 * Which rows: the ones whose status this instance owns, by the same rule as
 * the chosen status (`ownsChosenStatus`: native, or detached from a reset
 * home). Their live `status` is a function of this instance's WebSocket state.
 *
 * Federation safety:
 * - A replicated row (`home_instance` set, not detached) carries a projection
 *   of remote presence, broadcast to us by its home instance, and is NOT a
 *   function of our local WebSocket state. It is never touched here.
 * - Soft-deleted (tombstoned) users have `is_deleted = 1` and are excluded
 *   from presence broadcasts already; leave their stored status alone.
 *
 * Called once during server boot, after `getDb()` succeeds and before the
 * WebSocket handler is registered. Idempotent — re-running has no effect
 * once all owned rows are `'offline'`.
 *
 * @returns Number of rows reset (for logging / test assertions).
 */
export function resetStalePresenceOnBoot(): number {
  const db = getDb();
  const staleIds = db
    .select({
      id: schema.users.id,
      homeInstance: schema.users.homeInstance,
      federationHomeOrphaned: schema.users.federationHomeOrphaned,
    })
    .from(schema.users)
    .where(and(
      eq(schema.users.isDeleted, 0),
      ne(schema.users.status, 'offline'),
    ))
    .all()
    .filter((row) => ownsChosenStatus(row))
    .map((row) => row.id);

  if (staleIds.length === 0) return 0;

  // One statement per chunk keeps the id list under SQLite's bound-parameter limit.
  const CHUNK = 500;
  let changes = 0;
  for (let i = 0; i < staleIds.length; i += CHUNK) {
    const result = db.update(schema.users)
      .set({ status: 'offline' })
      .where(inArray(schema.users.id, staleIds.slice(i, i + CHUNK)))
      .run();
    // better-sqlite3's RunResult exposes `changes`; drizzle passes it through.
    changes += (result as { changes?: number }).changes ?? 0;
  }

  if (changes > 0) {
    console.log(`[presenceBoot] Reset ${changes} stale user status row(s) to 'offline'`);
  }
  return changes;
}
