import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import type { ClientKind } from '@backspace/shared';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const KINDS: ReadonlySet<string> = new Set(['web', 'desktop', 'mobile']);

export function parseClientKind(value: unknown): ClientKind {
  return typeof value === 'string' && KINDS.has(value) ? (value as ClientKind) : 'web';
}

/**
 * Records that a user was active today. Day precision only: the row is
 * touched once per UTC day and the write is skipped after that, so the
 * server never learns at what time anyone was online. Returns true when a
 * row was written.
 */
export function touchUserActivity(db: Db, userId: string, today: string, client?: ClientKind): boolean {
  const values: { lastActiveDay: string; lastClient?: ClientKind } = { lastActiveDay: today };
  if (client !== undefined) values.lastClient = client;
  const result = db.update(schema.users).set(values).where(and(
    eq(schema.users.id, userId),
    or(isNull(schema.users.lastActiveDay), ne(schema.users.lastActiveDay, today)),
  )).run();
  return result.changes === 1;
}
