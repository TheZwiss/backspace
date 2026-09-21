/**
 * Every D1 statement the hub runs. The route handlers in `index.ts` deal with
 * HTTP only, and the exact columns that enter and leave the database are
 * written down in one place.
 *
 * Two D1 facts shape this file. There are no interactive transactions, so a
 * write that must be all-or-nothing goes through `db.batch([...])`, which runs
 * its statements in one implicit transaction. And a statement binds at most
 * 100 parameters, so a document is written as one prepared statement per row
 * rather than one multi-row `INSERT`; the widest statement here binds 11.
 *
 * See section 7 of docs/superpowers/specs/2026-09-21-space-directory-design.md.
 */

import { rowHash } from './hash';
import type { AvatarColor, ValidDocument } from './validate';

/**
 * One feed row, every `DirectoryEntry` field in snake case as SQLite returns
 * it. `federated_registration_open` is the INTEGER the column holds, 0 or 1.
 * `avatar_color` and `visibility` are typed by what `applyDocument` writes,
 * since it is the only writer of `spaces` and it takes a `ValidSpace`.
 */
export interface FeedRow {
  origin: string;
  instance_name: string;
  federated_registration_open: number;
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  banner: string | null;
  avatar_color: AvatarColor | null;
  visibility: 'public' | 'request';
  member_count: number;
  created_at: number;
}

export interface FeedOptions {
  /** Matched against name and description; empty means no filter. */
  q: string;
  limit: number;
  offset: number;
  /** Rows from origins whose `last_ok_at` is before this are left out. */
  since: number;
}

/** What one `applyDocument` call wrote to `spaces`, for logging and tests. */
export interface ApplyResult {
  inserted: number;
  updated: number;
  deleted: number;
}

/** The two columns `applyDocument` reads back to diff against the document. */
interface StoredRowHash {
  id: string;
  row_hash: string;
}

/** `fetch_attempts.last_fetch_at` for `origin`, or null when it was never pinged. */
export async function getLastFetchAt(db: D1Database, origin: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT last_fetch_at FROM fetch_attempts WHERE origin = ?1')
    .bind(origin)
    .first<{ last_fetch_at: number }>();
  return row === null ? null : row.last_fetch_at;
}

/**
 * Records that the hub is about to fetch `origin`. Written before the fetch,
 * so an origin whose document never validates still has a cooldown row and a
 * stranger cannot make the hub fetch the same host without pause.
 */
export async function touchFetchAttempt(db: D1Database, origin: string, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fetch_attempts (origin, last_fetch_at) VALUES (?1, ?2)
       ON CONFLICT(origin) DO UPDATE SET last_fetch_at = excluded.last_fetch_at`,
    )
    .bind(origin, at)
    .run();
}

/** `origins.document_hash` for `origin`, or null when no document was ever stored for it. */
export async function readOriginHash(db: D1Database, origin: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT document_hash FROM origins WHERE origin = ?1')
    .bind(origin)
    .first<{ document_hash: string }>();
  return row === null ? null : row.document_hash;
}

/**
 * The one-row write for a document whose hash matches the stored one: the
 * origin is alive, nothing else is known to have changed. A no-op for an
 * origin without an `origins` row; the caller checks the hash first, and a
 * missing row never matches.
 */
export async function touchOriginOk(db: D1Database, origin: string, at: number): Promise<void> {
  await db.prepare('UPDATE origins SET last_ok_at = ?2 WHERE origin = ?1').bind(origin, at).run();
}

/**
 * Writes a validated document for `origin` as a diff against what is stored.
 *
 * The stored `(id, row_hash)` pairs for the origin are read first. Then one
 * batch carries the `origins` upsert, a `DELETE` for every stored id the
 * document no longer has, and an upsert for every space whose id is new or
 * whose `row_hash` differs. Rows with an unchanged hash are not written, so
 * a daily document in which three member counts moved costs four statements
 * however many spaces the instance lists. A document that changes nothing at
 * all still refreshes `last_ok_at` and `document_hash` through the `origins`
 * upsert; `first_seen_at` is kept from the first write.
 *
 * The `origins` upsert is the first statement so the rows' foreign key has
 * its parent before the row writes run. Spaces are keyed by `id` on the way
 * in; `parseDocument` rejects a document that repeats an id, and if one ever
 * reached here anyway the last occurrence would be stored, which is also
 * what the upserts would have left behind.
 *
 * The read and the batch are two round trips, not one transaction. Two
 * applies for the same origin can only interleave inside the per-origin
 * cooldown the ping route enforces, and every statement here is idempotent
 * on its key, so the worst case of a race is a redundant write, never a lost
 * or duplicated row.
 */
export async function applyDocument(
  db: D1Database,
  origin: string,
  doc: ValidDocument,
  docHash: string,
  at: number,
): Promise<ApplyResult> {
  const { results: storedRows } = await db
    .prepare('SELECT id, row_hash FROM spaces WHERE origin = ?1')
    .bind(origin)
    .all<StoredRowHash>();
  const stored = new Map(storedRows.map((row) => [row.id, row.row_hash]));

  const incoming = new Map(doc.spaces.map((space) => [space.id, space]));
  const hashed = await Promise.all(
    [...incoming.values()].map(async (space) => ({ space, hash: await rowHash(space) })),
  );

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO origins (origin, instance_name, federated_registration_open, version, document_hash, first_seen_at, last_ok_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(origin) DO UPDATE SET
           instance_name = excluded.instance_name,
           federated_registration_open = excluded.federated_registration_open,
           version = excluded.version,
           document_hash = excluded.document_hash,
           last_ok_at = excluded.last_ok_at`,
      )
      .bind(origin, doc.instanceName, doc.federatedRegistrationOpen ? 1 : 0, doc.version, docHash, at),
  ];
  const result: ApplyResult = { inserted: 0, updated: 0, deleted: 0 };

  for (const id of stored.keys()) {
    if (incoming.has(id)) continue;
    statements.push(db.prepare('DELETE FROM spaces WHERE origin = ?1 AND id = ?2').bind(origin, id));
    result.deleted += 1;
  }

  for (const { space, hash } of hashed) {
    const storedHash = stored.get(space.id);
    if (storedHash === hash) continue;
    if (storedHash === undefined) result.inserted += 1;
    else result.updated += 1;
    statements.push(
      db
        .prepare(
          `INSERT INTO spaces (origin, id, row_hash, name, description, icon, banner, avatar_color, visibility, member_count, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT(origin, id) DO UPDATE SET
             row_hash = excluded.row_hash,
             name = excluded.name,
             description = excluded.description,
             icon = excluded.icon,
             banner = excluded.banner,
             avatar_color = excluded.avatar_color,
             visibility = excluded.visibility,
             member_count = excluded.member_count,
             created_at = excluded.created_at`,
        )
        .bind(
          origin,
          space.id,
          hash,
          space.name,
          space.description,
          space.icon,
          space.banner,
          space.avatarColor,
          space.visibility,
          space.memberCount,
          space.createdAt,
        ),
    );
  }

  await db.batch(statements);
  return result;
}

/**
 * `q` as a `LIKE` pattern that matches it literally anywhere in the column.
 * `LIKE` gives `%` and `_` meaning, and the `ESCAPE '\'` clause on the query
 * gives `\` meaning, so all three are escaped.
 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The public feed. Rows from origins seen alive since `since`, minus anything
 * blocked, ordered by `member_count DESC, created_at DESC` on the
 * `spaces_members` index. A block with `space_id = '*'` hides the whole
 * origin; any other block hides that one space.
 *
 * A non-empty `q` matches name or description with `LIKE`, which SQLite folds
 * case-insensitively for ASCII letters only; a query in another script
 * matches its exact case. The caller bounds `q`, `limit` and `offset`; this
 * function binds what it is given.
 */
export async function feed(db: D1Database, opts: FeedOptions): Promise<FeedRow[]> {
  const search = opts.q === '' ? '' : `AND (s.name LIKE ?4 ESCAPE '\\' OR s.description LIKE ?4 ESCAPE '\\')`;
  const statement = db.prepare(
    `SELECT s.origin, o.instance_name, o.federated_registration_open,
            s.id, s.name, s.description, s.icon, s.banner, s.avatar_color, s.visibility, s.member_count, s.created_at
     FROM spaces s
     JOIN origins o ON o.origin = s.origin
     WHERE o.last_ok_at >= ?1
       AND NOT EXISTS (
         SELECT 1 FROM blocks b WHERE b.origin = s.origin AND (b.space_id = '*' OR b.space_id = s.id)
       )
       ${search}
     ORDER BY s.member_count DESC, s.created_at DESC
     LIMIT ?2 OFFSET ?3`,
  );
  const bound =
    opts.q === ''
      ? statement.bind(opts.since, opts.limit, opts.offset)
      : statement.bind(opts.since, opts.limit, opts.offset, likePattern(opts.q));
  const { results } = await bound.all<FeedRow>();
  return results;
}

/**
 * Housekeeping for the daily cron: drops `origins` rows whose `last_ok_at`
 * and `fetch_attempts` rows whose `last_fetch_at` are before `cutoff`. The
 * `spaces` rows of a dropped origin go with it through the foreign key's
 * `ON DELETE CASCADE`. Returns D1's changed-row count summed over both
 * statements. Unlike a bare `sqlite3_changes()`, D1 counts the rows a
 * cascade removed, so the figure is every row that went across the three
 * tables; the test pins that down.
 */
export async function deleteOlderThan(db: D1Database, cutoff: number): Promise<number> {
  const results = await db.batch([
    db.prepare('DELETE FROM origins WHERE last_ok_at < ?1').bind(cutoff),
    db.prepare('DELETE FROM fetch_attempts WHERE last_fetch_at < ?1').bind(cutoff),
  ]);
  return results.reduce((sum, res) => sum + res.meta.changes, 0);
}
