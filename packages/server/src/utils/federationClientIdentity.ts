import { getDb, schema } from '../db/index.js';
import { hydrateReplicatedUserProfile, resolveOrCreateReplicatedUser } from '../routes/federation.js';
import { resolveRelayActor } from '../routes/federation/identity.js';
import { isPlaceholderNamedStub } from '../routes/federation/stubName.js';
import { canonicalizeHomeInstance } from './federationAuth.js';
import { lookupRemoteUserByHomeId, type LookupResult } from './federationLookup.js';
import { resolveOriginFromHostname } from './federationOriginResolve.js';
import { eq } from 'drizzle-orm';

type UserRow = typeof schema.users.$inferSelect;

/** A user id as `generateSnowflake` writes it: a decimal 64-bit integer. */
const SNOWFLAKE_ID = /^\d{1,20}$/;

/** What the identity's home said when asked for the user by id. */
type HomeAnswer =
  | { kind: 'answered'; user: Extract<LookupResult, { ok: true }> }
  | { kind: 'no_such_user' }
  | { kind: 'no_answer' };

/**
 * The origin of the active peer that is the home of `homeInstance`, or null
 * when there is none (not peered, or the peering is not `active`).
 */
function activePeerOriginFor(homeInstance: string, db: ReturnType<typeof getDb>): string | null {
  const canon = canonicalizeHomeInstance(homeInstance);
  if (!canon) return null;
  let host: string;
  try {
    host = new URL(canon).host;
  } catch {
    return null;
  }
  const origin = resolveOriginFromHostname(host);
  if (!origin) return null;
  const peer = db
    .select({ status: schema.federationPeers.status })
    .from(schema.federationPeers)
    .where(eq(schema.federationPeers.origin, origin))
    .get();
  return peer?.status === 'active' ? origin : null;
}

/**
 * How long a client route waits for the identity's home. The request is held
 * open meanwhile, so this is far below the lookup's 10s default; a home that
 * does not answer in time is treated as unreachable and the row keeps (or
 * gets) its id name until a later contact renames it.
 */
export const CLIENT_HOME_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * After a home gave no answer for an identity, it is not asked again for that
 * identity for this long, so repeated clicks on an id-named user do not each
 * wait for a dead host. In memory only; a restart forgets it.
 */
const NO_ANSWER_RETRY_AFTER_MS = 60_000;
const NO_ANSWER_CACHE_MAX_ENTRIES = 1_000;
const noAnswerUntil = new Map<string, number>();

function noAnswerKey(peerOrigin: string, homeUserId: string): string {
  return `${peerOrigin}\n${homeUserId}`;
}

function rememberNoAnswer(key: string, now: number): void {
  for (const [k, until] of noAnswerUntil) {
    if (until <= now) noAnswerUntil.delete(k);
  }
  if (noAnswerUntil.size >= NO_ANSWER_CACHE_MAX_ENTRIES) {
    const oldest = noAnswerUntil.keys().next();
    if (!oldest.done) noAnswerUntil.delete(oldest.value);
  }
  noAnswerUntil.set(key, now + NO_ANSWER_RETRY_AFTER_MS);
}

/** Test hook: forget every remembered no-answer. */
export function _resetHomeLookupCache(): void {
  noAnswerUntil.clear();
}

/**
 * Ask the identity's home instance for the user by id (signed S2S
 * `POST /api/federation/users/by-home-id`), waiting at most
 * `CLIENT_HOME_LOOKUP_TIMEOUT_MS`. An answer counts only when it is about the
 * id that was asked for. A home that recently gave no answer for this id is
 * not asked again yet.
 */
async function askHome(peerOrigin: string, homeUserId: string): Promise<HomeAnswer> {
  const key = noAnswerKey(peerOrigin, homeUserId);
  const until = noAnswerUntil.get(key);
  if (until !== undefined && until > Date.now()) return { kind: 'no_answer' };

  let result: LookupResult;
  try {
    result = await lookupRemoteUserByHomeId(peerOrigin, homeUserId, { timeoutMs: CLIENT_HOME_LOOKUP_TIMEOUT_MS });
  } catch (err) {
    // Only a peer row that vanished since `activePeerOriginFor` read it; every
    // peer failure comes back as `unreachable`.
    console.warn('[federation] by-home-id lookup of %s on %s failed: %s', homeUserId, peerOrigin, (err as Error).message);
    rememberNoAnswer(key, Date.now());
    return { kind: 'no_answer' };
  }
  if (!result.ok) {
    if (result.reason === 'not_found') return { kind: 'no_such_user' };
    rememberNoAnswer(key, Date.now());
    return { kind: 'no_answer' };
  }
  if (result.homeUserId !== homeUserId) {
    rememberNoAnswer(key, Date.now());
    return { kind: 'no_answer' };
  }
  noAnswerUntil.delete(key);
  return { kind: 'answered', user: result };
}

/**
 * Resolve or create the row for a remote identity with the username and
 * profile its home just reported. On an existing `<homeUserId>@<domain>` row,
 * the username hint renames it (`resolveOrCreateReplicatedUser`).
 */
async function resolveWithAnswer(
  homeUserId: string,
  homeInstance: string,
  answer: Extract<LookupResult, { ok: true }>,
  db: ReturnType<typeof getDb>,
): Promise<UserRow | null> {
  const row = resolveOrCreateReplicatedUser(homeUserId, homeInstance, db, {
    username: answer.username,
    status: answer.profile.status ?? null,
  });
  if (!row) return null;
  return hydrateReplicatedUserProfile(row, { ...answer.profile, username: answer.username }, db);
}

/**
 * Resolve a remote identity (`homeUserId` + `homeInstance`) that a signed-in
 * local client names, e.g. the target of "Message", a group DM member, a
 * member to add, kick or promote, or a space-invite recipient.
 *
 * The client supplies only the pair, never a name: the username comes from the
 * identity's home over the signed S2S lookup, so the row is named correctly on
 * first contact (`<username>@<domain>`, display name hydrated) instead of
 * `<homeUserId>@<domain>`.
 *
 *   - Known row with its real name: returned as is, no network call.
 *   - Known row still named `<homeUserId>@<domain>`: the home is asked and the
 *     row renamed; without an answer it is returned unchanged.
 *   - Unknown identity: a row is created only when the `homeUserId` is
 *     shaped like a snowflake. When the home is an active peer it is asked
 *     and the row created with the reported name; when it says there is no
 *     such user, nothing is created. When it cannot be asked (no active
 *     peering yet) or does not answer (unreachable, rate limited, timeout),
 *     the row is created under the id name and renamed by the first username
 *     that arrives later (a relayed message, a friend-add, the
 *     peer-activation backfill).
 *
 * Returns null, and creates nothing, in those refusal cases and where
 * `resolveOrCreateReplicatedUser` does (the id belongs to a local user of
 * another identity, a tombstoned or self-homed identity). Callers answer null
 * with their not-found error.
 */
export async function resolveRemoteIdentityForClient(
  homeUserId: string,
  homeInstance: string,
  db: ReturnType<typeof getDb>,
): Promise<UserRow | null> {
  const known = resolveRelayActor({ homeUserId, homeInstance }, db);
  if (known.kind === 'mismatch') return null;

  if (known.kind === 'found') {
    if (!isPlaceholderNamedStub(known.user)) return known.user;
    const peerOrigin = activePeerOriginFor(homeInstance, db);
    if (!peerOrigin) return known.user;
    const answer = await askHome(peerOrigin, homeUserId);
    if (answer.kind !== 'answered') return known.user;
    return (await resolveWithAnswer(homeUserId, homeInstance, answer.user, db)) ?? known.user;
  }

  // A new row is created only for an id shaped like one (every user id is a
  // snowflake) that its home does not deny. Without an active peering yet the
  // home cannot be asked: the row gets the id name, and the DM's first message
  // starts the peering, whose activation renames the row (backfill).
  if (!SNOWFLAKE_ID.test(homeUserId)) return null;
  const peerOrigin = activePeerOriginFor(homeInstance, db);
  if (!peerOrigin) return resolveOrCreateReplicatedUser(homeUserId, homeInstance, db);
  const answer = await askHome(peerOrigin, homeUserId);
  switch (answer.kind) {
    case 'answered': return resolveWithAnswer(homeUserId, homeInstance, answer.user, db);
    case 'no_such_user': return null;
    case 'no_answer': return resolveOrCreateReplicatedUser(homeUserId, homeInstance, db);
  }
}
