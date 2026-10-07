import { eq, lt, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { extractDomain, getOurIdentityDomain, isOwnDomain, type RelayActor } from '../routes/federation/identity.js';

/**
 * The only reader and writer of `federation_subject_clocks`: the last applied
 * change per federated subject, which makes member and friend events
 * last-writer-wins on every path they arrive by.
 *
 * A subject is what a group of events changes between two states:
 * - a group member: the group's `federatedId` and the member's identity
 *   (`member_add` and `member_remove`);
 * - a friend pair: both identities, in either order (the five friend events).
 *
 * The rule (docs/systems/federation.md "Subject clocks"):
 * - a relayed event whose timestamp is older than the subject's clock is
 *   stale: it is accepted and changes nothing;
 * - an event that is applied, or accepted as a no-op after its sender's
 *   authority over it was checked, moves the clock to its timestamp (never
 *   back);
 * - a change made here moves the clock to the timestamp of the event it relays.
 *
 * An event with the clock's own timestamp is not stale: two events of one
 * change (an acceptance's `friend_request_update` and `friend_add`) share a
 * timestamp, and each is idempotent. A subject with no row has no known
 * change, so its first event applies and starts the clock.
 *
 * The live relay and the pull both reach the processors through
 * `processRelayEvents`, and the processors consult the clock through
 * `claimSubjectChange` at the point where they write, so neither path, nor a
 * replay of a kept event, can apply an older event over a newer one.
 *
 * Timestamps come from different instances' clocks. The rule only has to
 * order events that a lost delivery set minutes to days apart, not
 * milliseconds.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a clock row is kept after its last write. An event can still
 * arrive up to the outbox TTL after it was made (at most 365 days, see
 * `federationRelayTtlDays` in routes/settings.ts), or 90 days through the
 * mutation log; the 35 days on top cover the difference between the two
 * instances' clocks.
 */
export const SUBJECT_CLOCK_RETENTION_MS = 400 * DAY_MS;

/**
 * An identity as a clock key part: its home user id and its home domain, the
 * comparison `sameRelayActor` makes. This instance's own names (origin host
 * and identity domain) collapse to one, so a local user keys the same however
 * a peer spells our origin. Null when the identity is incomplete.
 */
function identityPart(actor: RelayActor | null | undefined): [string, string] | null {
  if (!actor || typeof actor.homeUserId !== 'string' || actor.homeUserId.length === 0) return null;
  if (typeof actor.homeInstance !== 'string') return null;
  const domain = extractDomain(actor.homeInstance.trim()).toLowerCase();
  if (!domain) return null;
  const home = isOwnDomain(domain) ? (getOurIdentityDomain() ?? domain) : domain;
  return [actor.homeUserId, home];
}

/** The clock subject of `member` in the group `federatedId`; null when either is incomplete. */
export function memberClockSubject(federatedId: string | null | undefined, member: RelayActor | null | undefined): string | null {
  if (typeof federatedId !== 'string' || federatedId.length === 0) return null;
  const identity = identityPart(member);
  if (!identity) return null;
  return JSON.stringify(['member', federatedId, ...identity]);
}

/** The clock subject of the friend pair `a`, `b` (order does not matter); null when either is incomplete. */
export function friendPairClockSubject(a: RelayActor | null | undefined, b: RelayActor | null | undefined): string | null {
  const first = identityPart(a);
  const second = identityPart(b);
  if (!first || !second) return null;
  const sides = [first, second].sort((x, y) => {
    const left = JSON.stringify(x);
    const right = JSON.stringify(y);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return JSON.stringify(['friend', ...sides[0]!, ...sides[1]!]);
}

/** A relayed timestamp as a clock value: a non-finite one orders before every change. */
function clockValue(at: number): number {
  return typeof at === 'number' && Number.isFinite(at) ? at : 0;
}

/** Whether a change at `at` is older than the last change recorded for `subject`. */
export function isSubjectChangeStale(
  subject: string,
  at: number,
  db: ReturnType<typeof getDb> = getDb(),
): boolean {
  const row = db
    .select({ changedAt: schema.federationSubjectClocks.changedAt })
    .from(schema.federationSubjectClocks)
    .where(eq(schema.federationSubjectClocks.subjectKey, subject))
    .get();
  return row !== undefined && clockValue(at) < row.changedAt;
}

/** Move `subject`'s clock to `at` unless it is already later. */
export function recordSubjectChange(
  subject: string,
  at: number,
  db: ReturnType<typeof getDb> = getDb(),
  now: number = Date.now(),
): void {
  const changedAt = clockValue(at);
  db.insert(schema.federationSubjectClocks)
    .values({ subjectKey: subject, changedAt, recordedAt: now })
    .onConflictDoUpdate({
      target: schema.federationSubjectClocks.subjectKey,
      set: {
        changedAt: sql`MAX(${schema.federationSubjectClocks.changedAt}, excluded.changed_at)`,
        recordedAt: sql`excluded.recorded_at`,
      },
    })
    .run();
}

/**
 * The check and the write in one step, for a processor about to apply (or
 * accept as a no-op) a change at `at`: false when it is stale, otherwise the
 * clock moves to `at` and the caller applies it. Callers make no `await`
 * between this and their write, so no other event of the subject lands in
 * between.
 */
export function claimSubjectChange(
  subject: string,
  at: number,
  db: ReturnType<typeof getDb> = getDb(),
  now: number = Date.now(),
): boolean {
  if (isSubjectChangeStale(subject, at, db)) return false;
  recordSubjectChange(subject, at, db, now);
  return true;
}

/** Delete clock rows not written for `SUBJECT_CLOCK_RETENTION_MS`. Returns how many went. */
export function sweepSubjectClocks(now: number = Date.now()): number {
  return getDb()
    .delete(schema.federationSubjectClocks)
    .where(lt(schema.federationSubjectClocks.recordedAt, now - SUBJECT_CLOCK_RETENTION_MS))
    .run().changes;
}

/**
 * A membership change made here (an add, a kick or a leave through this
 * instance's routes): `member`'s clock in the group `federatedId` moves to
 * `at`, the timestamp of the event that relays the change.
 */
export function recordLocalMemberChange(
  federatedId: string | null | undefined,
  member: RelayActor,
  at: number,
  db: ReturnType<typeof getDb> = getDb(),
): void {
  const subject = memberClockSubject(federatedId, member);
  if (subject) recordSubjectChange(subject, at, db);
}

/**
 * A friend change made here (a request, an answer, a cancel or a removal
 * through this instance's routes): the pair's clock moves to `at`, the
 * timestamp of the event that relays the change.
 */
export function recordLocalFriendPairChange(
  a: RelayActor,
  b: RelayActor,
  at: number,
  db: ReturnType<typeof getDb> = getDb(),
): void {
  const subject = friendPairClockSubject(a, b);
  if (subject) recordSubjectChange(subject, at, db);
}
