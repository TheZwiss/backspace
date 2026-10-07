import { and, eq, lt } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { normalizeOriginForCompare } from './federationAuth.js';

/**
 * The ledger of relay events applied here (`federation_applied_events`), for
 * events whose processors cannot tell a second delivery from the state they
 * leave behind. Each key is scoped to the origin the event is attributed to,
 * compared normalized, so the live relay and a pull (which may spell the same
 * origin differently) agree.
 *
 * Two kinds of key:
 * - `dmDeleteKey`: a delete for a DM message this instance did not hold. The
 *   delete is accepted, and a create for the same message arriving later is
 *   answered `duplicate`, so a create delayed behind its delete never brings
 *   the message back.
 * - `relayEventKey`: an event that is applied once and never again (friend
 *   events). See `processRelayEvents`.
 *
 * Rows live 100 days (`sweepAppliedEvents`), longer than the 90-day mutation
 * log a pull reads, so nothing the pull can serve outlives its ledger row.
 */

export const APPLIED_EVENT_RETENTION_MS = 100 * 24 * 60 * 60 * 1000;

/** The ledger key a delete of message `messageId` (in its home's coordinates) leaves. */
export function dmDeleteKey(messageId: string): string {
  return `dm_delete:${messageId}`;
}

/** The ledger key of a one-shot relay event. */
export function relayEventKey(eventType: string, messageId: string): string {
  return `${eventType}:${messageId}`;
}

function originKey(origin: string): string | null {
  return normalizeOriginForCompare(origin);
}

/** Whether `key` is recorded for `origin`. */
export function hasAppliedEvent(origin: string, key: string, db: ReturnType<typeof getDb> = getDb()): boolean {
  const source = originKey(origin);
  if (!source) return false;
  const row = db
    .select({ key: schema.federationAppliedEvents.eventKey })
    .from(schema.federationAppliedEvents)
    .where(and(
      eq(schema.federationAppliedEvents.sourceOrigin, source),
      eq(schema.federationAppliedEvents.eventKey, key),
    ))
    .get();
  return row !== undefined;
}

/** Record `key` for `origin`. Recording an existing key keeps its first time. */
export function recordAppliedEvent(
  origin: string,
  key: string,
  db: ReturnType<typeof getDb> = getDb(),
  now: number = Date.now(),
): void {
  const source = originKey(origin);
  if (!source) return;
  db.insert(schema.federationAppliedEvents)
    .values({ sourceOrigin: source, eventKey: key, appliedAt: now })
    .onConflictDoNothing()
    .run();
}

/** Delete ledger rows older than the retention. Returns how many went. */
export function sweepAppliedEvents(now: number = Date.now()): number {
  return getDb()
    .delete(schema.federationAppliedEvents)
    .where(lt(schema.federationAppliedEvents.appliedAt, now - APPLIED_EVENT_RETENTION_MS))
    .run().changes;
}
