import type Database from 'better-sqlite3';
import { PermissionBits, canonicalPermissionString } from '@backspace/shared/src/permissions.js';

// Stored permission values (docs/systems/permissions.md, "Stored form"). Raw
// better-sqlite3 so it runs at boot, like the role renumbering in
// rolePositions.ts, before the Drizzle handle is shared.

/** Every column that stores a permissions value, with the key that finds its row again. */
const PERMISSION_COLUMNS: readonly { table: string; key: readonly string[]; columns: readonly string[] }[] = [
  { table: 'roles', key: ['id'], columns: ['permissions'] },
  { table: 'channel_overrides', key: ['channel_id', 'target_type', 'target_id'], columns: ['allow', 'deny'] },
  { table: 'category_overrides', key: ['category_id', 'target_type', 'target_id'], columns: ['allow', 'deny'] },
];

/** One stored value the pass rewrites. */
interface Rewrite {
  table: string;
  column: string;
  key: readonly string[];
  keyValues: (string | null)[];
  stored: string | null;
  canonical: string;
}

/**
 * Whether `stringToPermissions` reads less out of `stored` than it says: text
 * that is neither an integer nor a JSON list of permission names (read as 0),
 * or a list naming something that is not a permission (that name is dropped).
 * Rewriting such a value loses the text, so the pass logs it first.
 */
function isUnreadable(stored: string | null): boolean {
  if (!stored) return false;
  try {
    BigInt(stored);
    return false;
  } catch {
    try {
      const parsed: unknown = JSON.parse(stored);
      return !Array.isArray(parsed) || !parsed.every((name) => typeof name === 'string' && Object.hasOwn(PermissionBits, name));
    } catch {
      return true;
    }
  }
}

/** The values not in canonical form, read without writing anything. */
function pendingRewrites(db: Database.Database): Rewrite[] {
  const rewrites: Rewrite[] = [];
  for (const { table, key, columns } of PERMISSION_COLUMNS) {
    const rows = db.prepare(`SELECT ${[...key, ...columns].join(', ')} FROM ${table}`).all() as Record<string, string | null>[];
    for (const column of columns) {
      for (const row of rows) {
        const stored = row[column] ?? null;
        const canonical = canonicalPermissionString(stored);
        if (stored === canonical) continue;
        rewrites.push({ table, column, key, keyValues: key.map((k) => row[k] ?? null), stored, canonical });
      }
    }
  }
  return rewrites;
}

/**
 * Rewrite every stored permissions value that is not in canonical form
 * (`canonicalPermissionString`): the role routes once stored a request's
 * string as given, and the override routes did until the stored form was
 * enforced, so an old database can hold "0x10", " 8", "-1", a legacy JSON
 * name list or NULL. Each becomes the decimal string the routes store now,
 * with the same meaning for every permission check; a negative value, which
 * reads as every bit, becomes the defined bits.
 *
 * `beforeChanges` runs once, before the first write, only when something is
 * about to be rewritten (`initDatabase` takes a database snapshot there); if
 * it throws, nothing is written. A value whose text cannot be read in full
 * (`isUnreadable`) is logged with its row and old text as it is replaced, so
 * it can be recovered; the next boot finds it canonical and logs nothing.
 *
 * Returns how many values were rewritten. Idempotent: a second run rewrites
 * nothing.
 */
export function normalizeStoredPermissions(
  db: Database.Database,
  options: { beforeChanges?: () => void } = {},
): number {
  const rewrites = pendingRewrites(db);
  if (rewrites.length === 0) return 0;
  options.beforeChanges?.();

  db.transaction(() => {
    for (const { table, column, key, keyValues, canonical } of rewrites) {
      const where = key.map((k) => `${k} = ?`).join(' AND ');
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where}`).run(canonical, ...keyValues);
    }
  })();

  for (const { table, column, key, keyValues, stored, canonical } of rewrites) {
    if (!isUnreadable(stored)) continue;
    const row = key.map((k, i) => `${k}=${keyValues[i] ?? 'NULL'}`).join(' ');
    console.warn(`[permissions] ${table} ${row} ${column}: unreadable value ${JSON.stringify(stored)} replaced by "${canonical}"`);
  }
  return rewrites.length;
}
