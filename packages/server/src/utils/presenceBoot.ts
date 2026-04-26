import { and, isNull, ne, eq } from 'drizzle-orm';
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
 * any non-`offline` status row is by definition stale and safe to reset.
 *
 * Federation safety:
 * - The `users` table contains replicated user stubs for users whose home
 *   instance is elsewhere (`home_instance` non-null). Their `status` is a
 *   projection of remote presence, broadcast to us by their home instance,
 *   and is NOT a function of our local WebSocket state. We must not touch
 *   replicated rows — only reset rows where `home_instance IS NULL`.
 * - Soft-deleted (tombstoned) users have `is_deleted = 1` and are excluded
 *   from presence broadcasts already; leave their stored status alone.
 *
 * Called once during server boot, after `getDb()` succeeds and before the
 * WebSocket handler is registered. Idempotent — re-running has no effect
 * once all locally-homed users are `'offline'`.
 *
 * @returns Number of rows reset (for logging / test assertions).
 */
export function resetStalePresenceOnBoot(): number {
  const db = getDb();
  const result = db.update(schema.users)
    .set({ status: 'offline' })
    .where(and(
      isNull(schema.users.homeInstance),
      eq(schema.users.isDeleted, 0),
      ne(schema.users.status, 'offline'),
    ))
    .run();

  // better-sqlite3's RunResult exposes `changes`; drizzle passes it through.
  const changes = (result as { changes?: number }).changes ?? 0;
  if (changes > 0) {
    console.log(`[presenceBoot] Reset ${changes} stale user status row(s) to 'offline'`);
  }
  return changes;
}
