import type Database from 'better-sqlite3';
import { canonicalPermissionString } from '@backspace/shared/src/permissions.js';

// Stored permission values (docs/systems/permissions.md, "Stored form"). Raw
// better-sqlite3 so it runs at boot, like the role renumbering in
// rolePositions.ts, before the Drizzle handle is shared.

/** Every column that stores a permissions value, with the key that finds its row again. */
const PERMISSION_COLUMNS: readonly { table: string; key: readonly string[]; columns: readonly string[] }[] = [
  { table: 'roles', key: ['id'], columns: ['permissions'] },
  { table: 'channel_overrides', key: ['channel_id', 'target_type', 'target_id'], columns: ['allow', 'deny'] },
  { table: 'category_overrides', key: ['category_id', 'target_type', 'target_id'], columns: ['allow', 'deny'] },
];

/**
 * Rewrite every stored permissions value that is not in canonical form
 * (`canonicalPermissionString`): the role routes once stored a request's
 * string as given, and the override routes did until the stored form was
 * enforced, so an old database can hold "0x10", " 8", "-1", a legacy JSON
 * name list or NULL. Each becomes the decimal string the routes store now, with the same meaning
 * for every permission check; a negative value, which reads as every bit,
 * becomes the defined bits. Returns how many values were rewritten.
 * Idempotent: a second run rewrites nothing.
 */
export function normalizeStoredPermissions(db: Database.Database): number {
  let changed = 0;
  db.transaction(() => {
    for (const { table, key, columns } of PERMISSION_COLUMNS) {
      const rows = db.prepare(`SELECT ${[...key, ...columns].join(', ')} FROM ${table}`).all() as Record<string, string | null>[];
      const where = key.map((k) => `${k} = ?`).join(' AND ');
      for (const column of columns) {
        const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where}`);
        for (const row of rows) {
          const stored = row[column] ?? null;
          const canonical = canonicalPermissionString(stored);
          if (stored === canonical) continue;
          update.run(canonical, ...key.map((k) => row[k]));
          changed++;
        }
      }
    }
  })();
  return changed;
}
