/**
 * Every D1 statement the receiver runs. Keeping them here means the route
 * handlers in `index.ts` deal with HTTP only, and the exact column list that
 * leaves the receiver is written down in one place.
 *
 * See section 7 of docs/superpowers/specs/2026-09-06-instance-telemetry-design.md.
 */

/** One stored ping. `body` is the validated payload re-serialised by `parsePing`. */
export interface StoredPing {
  instance: string;
  day: string;
  receivedAt: string;
  country: string;
  schema: number;
  body: string;
}

/** The row shape of the `pings` table, snake case as SQLite returns it. */
interface PingRow {
  instance: string;
  day: string;
  received_at: string;
  country: string;
  schema: number;
  body: string;
}

/**
 * Writes one ping, replacing an earlier one for the same instance and day.
 *
 * An instance reports once a day but may retry, and a retry carries the newer
 * numbers, so the last write for a day wins rather than piling up rows.
 */
export async function upsertPing(db: D1Database, p: StoredPing): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pings (instance, day, received_at, country, schema, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(instance, day) DO UPDATE SET received_at = excluded.received_at, country = excluded.country, schema = excluded.schema, body = excluded.body`,
    )
    .bind(p.instance, p.day, p.receivedAt, p.country, p.schema, p.body)
    .run();
}

/**
 * Reads the rows whose `day` falls in the inclusive range `[from, to]`, at most
 * `limit` of them.
 *
 * The order is by day and then by instance so two calls for the same range
 * return the same file, which keeps a re-run of the collector comparable with
 * the run before it, and so a range that hits the limit always drops the same
 * tail rather than an arbitrary slice.
 *
 * `limit` is required rather than defaulted. An unbounded read of this table is
 * the defect this parameter exists to close, and a default would leave the
 * unbounded call one omission away from being written again.
 */
export async function exportRange(
  db: D1Database,
  from: string,
  to: string,
  limit: number,
): Promise<StoredPing[]> {
  const { results } = await db
    .prepare(
      'SELECT instance, day, received_at, country, schema, body FROM pings WHERE day >= ?1 AND day <= ?2 ORDER BY day, instance LIMIT ?3',
    )
    .bind(from, to, limit)
    .all<PingRow>();
  return results.map((r) => ({
    instance: r.instance,
    day: r.day,
    receivedAt: r.received_at,
    country: r.country,
    schema: r.schema,
    body: r.body,
  }));
}

/** Drops every row dated before `day`. Returns how many rows went. */
export async function deleteOlderThan(db: D1Database, day: string): Promise<number> {
  const res = await db.prepare('DELETE FROM pings WHERE day < ?1').bind(day).run();
  return res.meta.changes;
}
