import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { SpawnedInstance } from './twoInstanceHarness.js';

/**
 * Direct DB insert (test-only): create a space owned by an arbitrary userId.
 * Used by tests #7 and #8 — there is no public path for a replicated stub to
 * become a space owner, so we seed it directly.
 *
 * Note: the spaces table has no `updated_at` or `layout` columns — the plan's
 * INSERT template was incorrect. Only the four required columns are supplied:
 * id, name, owner_id, created_at.
 */
export function seedOwnedSpace(instance: SpawnedInstance, ownerUserId: string, name = 'test-space'): { spaceId: string } {
  const db = new Database(instance.dbPath);
  try {
    db.pragma('journal_mode = WAL');
    // Disable FK checks so we can seed a space owned by a stub user ID that
    // does not yet exist in the users table (the point of this helper).
    db.pragma('foreign_keys = OFF');
    const spaceId = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, name, owner_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(spaceId, name, ownerUserId, now);
    return { spaceId };
  } finally {
    db.close();
  }
}
