import path from 'node:path';
import { config } from '../../config.js';
import { getDb, schema } from '../../db/index.js';
import { getOurOrigin, normalizeOriginForCompare } from '../../utils/federationAuth.js';
import { generateSnowflake } from '../../utils/snowflake.js';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { renameIdNamedStub } from './stubName.js';

/**
 * Extract bare domain from a homeInstance value.
 * Handles both full URLs ("https://nova.ddns.net") and bare domains ("nova.ddns.net").
 * Used to normalize homeInstance to a canonical format for identity matching.
 */
export function extractDomain(homeInstance: string): string {
  try {
    return new URL(homeInstance).hostname;
  } catch {
    // Already a bare domain or malformed — strip protocol manually
    return homeInstance.replace(/^https?:\/\//, '').split('/')[0] ?? homeInstance;
  }
}


/**
 * The bare lowercase domain that constitutes this instance's federated
 * identity authority. Derives from DOMAIN (identity), falling back to
 * getOurOrigin() only when DOMAIN is unset (dev/tests). PUBLIC_ORIGIN is a
 * transport override and deliberately NOT consulted first — identity
 * comparisons must not shift when the transport origin is overridden.
 */
export function getOurIdentityDomain(): string | null {
  if (config.domain) return config.domain.toLowerCase();
  const origin = getOurOrigin();
  if (!origin) return null;
  return extractDomain(origin).toLowerCase();
}


/**
 * The acting identity an inbound relay event asserts. A `homeUserId` on its own
 * is NOT an identity — the column is only unique within one instance, so it is
 * meaningless without the `homeInstance` that scopes it. Every attribution site
 * therefore passes the pair.
 */
export interface RelayActor {
  homeUserId: string;
  homeInstance: string;
}


/**
 * What this instance can say about a homeward claim: a peer asserting an event
 * authored by one of OUR natively-homed users.
 *
 *   - `proven`   — the user has an established federated presence on the peer.
 *   - `unproven` — the user exists here, but no presence on the peer is on file
 *                  yet. Either the peer is forging, or the user's client has
 *                  not yet pushed the registry entry that records the
 *                  connection (it is written after the session opens, so a
 *                  relay the user causes can arrive first). The two cannot be
 *                  told apart from here, so the claim is refused without being
 *                  called a forgery.
 *   - `no_such_user` — there is no live native user with that id. Nothing that
 *                  arrives later can make the claim true.
 *
 * Presence is the ONLY thing that makes a homeward relay legitimate: such an
 * event can only genuinely exist if the user holds an account on that peer and
 * acted there. Both records consulted here are written exclusively by the user
 * themselves, over an authenticated session on this instance:
 *
 *   - `user_federation_registry` — `PUT /api/users/@me/federation-registry`,
 *     scoped to `request.userId`. Every lifecycle state counts (a connection
 *     that is `disconnected` / `auth_expired` today was still real).
 *   - `users.replicated_instances` — `PATCH /api/users/@me`, same scoping.
 *
 * A peer cannot forge either one, so it cannot manufacture standing to speak
 * for a user who never connected to it.
 */
export type HomewardStanding = 'proven' | 'unproven' | 'no_such_user';

export function localUserStandingOnPeer(
  homeUserId: string,
  peerOrigin: string,
  db: ReturnType<typeof getDb>,
): HomewardStanding {
  // Homeward means "homed HERE", so the actor must resolve to a NATIVE row
  // (home_instance IS NULL). Matching a replicated stub that merely carries the
  // same home_user_id would reintroduce the cross-instance id collision the
  // homeInstance pairing exists to prevent.
  const nativeUser = db
    .select({ id: schema.users.id, replicatedInstances: schema.users.replicatedInstances })
    .from(schema.users)
    .where(and(
      eq(schema.users.id, homeUserId),
      isNull(schema.users.homeInstance),
      eq(schema.users.isDeleted, 0),
    ))
    .get();
  if (!nativeUser) return 'no_such_user';

  const peerHost = normalizeOriginForCompare(peerOrigin);
  if (!peerHost) return 'unproven';

  const registryRows = db
    .select({ origin: schema.userFederationRegistry.origin })
    .from(schema.userFederationRegistry)
    .where(eq(schema.userFederationRegistry.userId, nativeUser.id))
    .all();
  if (registryRows.some(r => normalizeOriginForCompare(r.origin) === peerHost)) return 'proven';

  if (nativeUser.replicatedInstances) {
    try {
      const parsed: unknown = JSON.parse(nativeUser.replicatedInstances);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry !== 'object' || entry === null) continue;
          const origin = (entry as { origin?: unknown }).origin;
          if (typeof origin === 'string' && normalizeOriginForCompare(origin) === peerHost) return 'proven';
        }
      }
    } catch {
      // Malformed JSON is treated as "no recorded presence" — fail closed.
    }
  }

  return 'unproven';
}


/**
 * Why an inbound relay event's acting identity was refused, as it goes into the
 * relay response's `rejected[].reason`.
 *
 *   - `attribution_mismatch` — permanent. The signing peer can never speak for
 *     this actor: it is homed on a third instance, is malformed, or claims to
 *     be one of our users who does not exist (or no longer does).
 *   - `attribution_unproven` — the actor is one of our live users and the peer
 *     may well be carrying their event home, but the proof that they hold an
 *     account there has not reached us. A retry can succeed once it does.
 *
 * The HTTP relay boundary only puts `attribution_unproven` on the wire for a
 * sender that lists it in `FederationRelayRequest.capabilities`; every other
 * sender receives `attribution_mismatch` for both (see `handlers/relay.ts`).
 */
export type AttributionRefusal = 'attribution_mismatch' | 'attribution_unproven';

/**
 * Check that an inbound relay event's acting identity is one the signing peer
 * is entitled to speak for. Returns `null` when it is, otherwise the refusal
 * reason the handler reports.
 *
 * The only trustworthy fact about an inbound relay is the HMAC-authenticated
 * peer. `sourceInstance` is bound to that peer at the relay boundary (see
 * `handlers/relay.ts` and `events/dispatch.ts`), so it is safe to treat it as
 * the signing peer here.
 *
 * Two valid cases:
 * 1. **Direct**: the actor is homed on the signing peer. A peer is the identity
 *    authority for its own users, but only for ids that are not already a
 *    different identity here: when the `homeUserId` belongs only to local users
 *    homed elsewhere (`resolveRelayActor` reports `mismatch`), the event could
 *    never be applied as that actor, so it is refused before any handler acts.
 *    The same holds when the identity is a detached account
 *    (`federationHomeOrphaned = 1`): its home domain was reset, the account is
 *    sovereign here, and the domain no longer speaks for it.
 * 2. **Homeward relay**: the actor is homed on THIS instance — a client-
 *    federation user (e.g. erin@nova logged into orbit) acted on the remote and
 *    the relay carries it back home. This is only accepted when the local user
 *    actually holds a federated account on the signing peer
 *    (`localUserStandingOnPeer`). Without that binding, any approved peer could
 *    forge events attributed to any of our users.
 *
 * An actor homed on a third instance is never accepted: the signing peer is not
 * that instance's identity authority and has no delegation from it.
 */
export function attributionRefusal(
  actor: RelayActor | null | undefined,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
): AttributionRefusal | null {
  if (!actor) return 'attribution_mismatch';
  const { homeUserId, homeInstance } = actor;
  if (typeof homeUserId !== 'string' || homeUserId.length === 0) return 'attribution_mismatch';
  if (typeof homeInstance !== 'string' || homeInstance.length === 0) return 'attribution_mismatch';

  const authorDomain = extractDomain(homeInstance).toLowerCase();
  const sourceDomain = extractDomain(sourceInstance).toLowerCase();
  if (!authorDomain || !sourceDomain) return 'attribution_mismatch';

  // Case 1: the actor belongs to the signing peer.
  if (authorDomain === sourceDomain) {
    const identity = resolveRelayActor(actor, db);
    if (identity.kind === 'mismatch') return 'attribution_mismatch';
    // A detached account no longer belongs to its old home domain.
    if (identity.kind === 'found' && identity.user.federationHomeOrphaned === 1) return 'attribution_mismatch';
    return null;
  }

  // Case 2: homeward relay — the actor belongs to THIS instance.
  const ourDomain = extractDomain(getOurOrigin()).toLowerCase();
  if (ourDomain && authorDomain === ourDomain) {
    switch (localUserStandingOnPeer(homeUserId, sourceInstance, db)) {
      case 'proven': return null;
      case 'unproven': return 'attribution_unproven';
      case 'no_such_user': return 'attribution_mismatch';
    }
  }

  return 'attribution_mismatch';
}


/**
 * The federated identity a local user row stands for, or null when the row
 * does not carry one. A native row is homed here: its identity is its own id
 * on this instance. A federated account or replicated stub carries its home
 * pair; one without a `homeUserId` has no identity that can be compared.
 */
export function relayActorOfUser(user: {
  id: string;
  homeUserId: string | null;
  homeInstance: string | null;
}): RelayActor | null {
  if (!user.homeInstance) return { homeUserId: user.id, homeInstance: getOurOrigin() };
  if (!user.homeUserId) return null;
  return { homeUserId: user.homeUserId, homeInstance: user.homeInstance };
}

/**
 * Whether two federated identities are the same person: the same home user id
 * on the same home instance. Instances are compared by domain, the way
 * `attributionRefusal` compares them, because stored `homeInstance` values are
 * bare domains while origins on the wire are full URLs.
 */
export function sameRelayActor(a: RelayActor, b: RelayActor): boolean {
  if (a.homeUserId !== b.homeUserId) return false;
  const domainA = extractDomain(a.homeInstance).toLowerCase();
  const domainB = extractDomain(b.homeInstance).toLowerCase();
  return domainA.length > 0 && domainA === domainB;
}


/**
 * What resolving an inbound relay event's acting identity found.
 *
 *   - `found`: the live local user that IS this identity.
 *   - `unknown`: no live local user carries this `homeUserId` at all. The
 *     identity may simply not be known here yet; each handler keeps its own
 *     answer for that case.
 *   - `mismatch`: the `homeUserId` belongs to one or more local users, but none
 *     of them is homed where the event says. The event names an identity that
 *     is not the one those rows stand for, so it can never apply to them;
 *     handlers refuse it as `attribution_mismatch`.
 */
export type RelayActorResolution =
  | { kind: 'found'; user: typeof schema.users.$inferSelect }
  | { kind: 'unknown' }
  | { kind: 'mismatch' };

/**
 * Whether a bare domain is one of this instance's own names: the host of its
 * origin (`getOurOrigin`, what it puts on the wire for its users) or its
 * identity domain (`DOMAIN`). They differ only when `PUBLIC_ORIGIN` overrides
 * the transport, and a reference to a native user may carry either.
 */
export function isOwnDomain(domain: string): boolean {
  if (!domain) return false;
  return domain === extractDomain(getOurOrigin()).toLowerCase() || domain === getOurIdentityDomain();
}

/**
 * Resolve a federated identity, a `homeUserId` + `homeInstance` pair, to the
 * local user that IS that identity. Never by `homeUserId` alone: that value is
 * only unique on its home instance, so a bare-id lookup can land on a
 * different person, such as a native user whose own id happens to equal it.
 *
 * A native row matches when its own id is the `homeUserId` and the
 * `homeInstance` is one of this instance's own names (`isOwnDomain`); any other
 * row matches when it carries the same home user id on the same home domain,
 * compared the way `sameRelayActor` compares identities.
 *
 * Inbound relay handlers use it for the acting identity, after
 * `attributionRefusal` accepted the pair (which already refuses a `mismatch`
 * and a detached account). Together they give the invariant every handler
 * relies on: the user an event is applied as is a live, attached user homed on
 * the signing peer, or is one of our own users who holds an account there (the
 * homeward case). `resolveRelayActor` itself still returns a detached row as
 * `found`, since a lookup that is not an actor (a participant, a historical
 * reference) may name one. `findFederatedUser` uses it as its
 * first step, so every `resolveOrCreateReplicatedUser` caller gets the same
 * rule. `resolveLocalUser` keeps its bare-id semantics for its other callers.
 */
export function resolveRelayActor(
  actor: RelayActor,
  db: ReturnType<typeof getDb>,
): RelayActorResolution {
  const candidates = db
    .select()
    .from(schema.users)
    .where(
      and(
        or(
          eq(schema.users.homeUserId, actor.homeUserId),
          and(eq(schema.users.id, actor.homeUserId), isNull(schema.users.homeInstance)),
        ),
        eq(schema.users.isDeleted, 0),
      ),
    )
    .all();
  if (candidates.length === 0) return { kind: 'unknown' };
  const actorDomain = extractDomain(actor.homeInstance).toLowerCase();
  const user = candidates.find((candidate) => {
    if (!candidate.homeInstance) return candidate.id === actor.homeUserId && isOwnDomain(actorDomain);
    const identity = relayActorOfUser(candidate);
    return identity !== null && sameRelayActor(identity, actor);
  });
  return user ? { kind: 'found', user } : { kind: 'mismatch' };
}


/**
 * Resolve a home user ID to a local user.
 * Matches users where home_user_id = homeUserId, or where
 * the user's own id equals homeUserId and they have no home_instance set (local user).
 *
 * Ignores `homeInstance`, so it must not be used to resolve the acting identity
 * of an inbound relay event; use `resolveRelayActor` for that.
 */
export function resolveLocalUser(
  homeUserId: string,
  db: ReturnType<typeof getDb>,
): typeof schema.users.$inferSelect | undefined {
  const candidates = db
    .select()
    .from(schema.users)
    .where(
      and(
        or(
          eq(schema.users.homeUserId, homeUserId),
          and(eq(schema.users.id, homeUserId), isNull(schema.users.homeInstance)),
        ),
        eq(schema.users.isDeleted, 0),
      ),
    )
    .all();

  // Prefer non-deleted active users; if multiple, prefer the one with homeUserId set
  // (replicated user) over a local user match
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  return candidates.find(u => u.homeUserId === homeUserId) ?? candidates[0];
}


/**
 * Unified federated user lookup — finds a user regardless of which code path
 * created them (auth registration vs S2S relay stub).
 *
 * Three-tier matching:
 * 1. Identity: the row that IS `homeUserId` + `homeInstance` (`resolveRelayActor`)
 * 2. Domain + username hint: normalized homeInstance domain + username base
 *    match, among rows that have no `homeUserId` yet (the only rows a name
 *    can bind; `backfillHomeUserId` then records the id on the match)
 * 3. Not found: returns undefined
 *
 * When tier 1 reports `mismatch` (the `homeUserId` belongs only to local users
 * of another identity) the lookup ends there: no row is returned and tier 2 is
 * not tried, so the id can neither reach those users nor bind a stub by name.
 *
 * Does NOT perform side effects (backfill). See `backfillHomeUserId` for that.
 */
export function findFederatedUser(
  homeUserId: string,
  homeInstance: string,
  db: ReturnType<typeof getDb>,
  hints?: { username?: string | null },
): typeof schema.users.$inferSelect | undefined {
  const lookup = lookupFederatedUser(homeUserId, homeInstance, db, hints);
  return lookup.kind === 'found' ? lookup.user : undefined;
}

function lookupFederatedUser(
  homeUserId: string,
  homeInstance: string,
  db: ReturnType<typeof getDb>,
  hints?: { username?: string | null },
): RelayActorResolution {
  // Tier 1: the identity itself. A mismatch is final.
  const identity = resolveRelayActor({ homeUserId, homeInstance }, db);
  if (identity.kind !== 'unknown') return identity;

  // Tier 2: domain + username hint match
  if (!hints?.username) return { kind: 'unknown' };

  const domain = extractDomain(homeInstance);
  const hintLower = hints.username.toLowerCase();

  // Scoped SQL query: match on homeInstance domain + username base
  // Username base is the part before '@'. We use SQL LIKE to match
  // '{hint}@%' pattern, plus an exact match for users without '@'.
  const candidates = db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.homeInstance, domain),
        eq(schema.users.isDeleted, 0),
        // A username match binds only a row that has no home id yet. A row
        // with a home id is already one identity; tier 1 found it or it is
        // someone else, and a name must not turn it into the one asked for.
        isNull(schema.users.homeUserId),
        // Detached (home-orphaned) accounts are sovereign: never re-bindable to
        // the domain's new incarnation via username heuristics — that is exactly
        // how a new same-name user would capture the established account.
        eq(schema.users.federationHomeOrphaned, 0),
        or(
          sql`lower(substr(${schema.users.username}, 1, instr(${schema.users.username}, '@') - 1)) = ${hintLower}`,
          and(
            sql`instr(${schema.users.username}, '@') = 0`,
            sql`lower(${schema.users.username}) = ${hintLower}`,
          ),
        ),
      ),
    )
    .all();

  if (candidates.length === 0) return { kind: 'unknown' };

  // Pick best candidate: prefer real accounts over stubs, then most profile data
  if (candidates.length === 1) return { kind: 'found', user: candidates[0]! };

  const best = candidates.sort((a, b) => {
    // Real account (not federation-replicated) wins
    const aReal = a.passwordHash !== '!federation-replicated' ? 1 : 0;
    const bReal = b.passwordHash !== '!federation-replicated' ? 1 : 0;
    if (aReal !== bReal) return bReal - aReal;
    // More profile data wins
    const profileCount = (u: typeof a) =>
      [u.displayName, u.avatar, u.banner, u.bio].filter(Boolean).length;
    return profileCount(b) - profileCount(a);
  })[0]!;
  return { kind: 'found', user: best };
}


/**
 * Backfill homeUserId on an existing user record so future lookups
 * use the fast path (tier 1). Called by resolveOrCreateReplicatedUser
 * after findFederatedUser matches via tier 2.
 */
export function backfillHomeUserId(
  user: typeof schema.users.$inferSelect,
  homeUserId: string,
  db: ReturnType<typeof getDb>,
): typeof schema.users.$inferSelect {
  if (user.homeUserId === homeUserId) return user;
  // Only backfill if the user has no homeUserId yet. If they already have a
  // DIFFERENT non-null homeUserId, this means the wrong user was matched —
  // overwriting would corrupt their identity.
  if (user.homeUserId) {
    console.warn(`[federation] Refusing to overwrite homeUserId on user ${user.id} (${user.username}): existing=${user.homeUserId}, incoming=${homeUserId}`);
    return user;
  }
  db.update(schema.users)
    .set({ homeUserId })
    .where(eq(schema.users.id, user.id))
    .run();
  console.log(`[federation] Backfilled homeUserId=${homeUserId} on user ${user.id} (${user.username})`);
  return { ...user, homeUserId };
}


/**
 * Resolve a federated participant to a local user, creating a minimal
 * replicated user stub if one doesn't already exist.  This is needed
 * for the group-DM bootstrap path: when Instance C receives a
 * member_add event whose roster includes users that only live on
 * Instance A or B, those users won't have been pre-replicated via the
 * friend-connect flow.  We create a bare-bones row so the local DB
 * can reference them in dm_members / dm_messages.
 *
 * Returns null, and creates nothing, for a deleted identity, a dead incarnation
 * of this instance, or a `homeUserId` that belongs only to local users of
 * another identity (see `findFederatedUser`).
 */
export function resolveOrCreateReplicatedUser(
  homeUserId: string,
  homeInstance: string,
  db: ReturnType<typeof getDb>,
  hints?: { username?: string | null; status?: 'online' | 'idle' | 'dnd' | 'offline' | null; deleted?: boolean | null },
): typeof schema.users.$inferSelect | null {
  const existing = lookupFederatedUser(homeUserId, homeInstance, db, hints);
  if (existing.kind === 'found') {
    // A row met before its username was known is still named
    // `<homeUserId>@<domain>`; the first username hint renames it.
    return renameIdNamedStub(backfillHomeUserId(existing.user, homeUserId, db), hints?.username, db);
  }
  // The id belongs only to local users of another identity. It names no one
  // here, and a stub for it would give one id two identities on this instance.
  if (existing.kind === 'mismatch') {
    console.warn(`[federation] Not resolving homeUserId=${homeUserId} (${extractDomain(homeInstance)}): the id belongs to a local user of another identity`);
    return null;
  }

  // A participant the sender marks as deleted must not materialize as a new
  // stub — mirror of the local-tombstone skip below. An existing row still
  // resolves above, so historical attribution is unaffected (spec §3.3).
  if (hints?.deleted) {
    console.log(`[federation] Skipping stub creation for remotely-deleted identity homeUserId=${homeUserId}`);
    return null;
  }

  // Check if this identity was previously deleted — don't resurrect a tombstoned
  // user by creating a new stub. The isDeleted=0 filter in findFederatedUser
  // already hides the deleted row, so we must query without that filter here.
  const domain = extractDomain(homeInstance);

  // An instance never hosts a replicated stub homed at itself. A self-domain
  // identity that is live resolves at tier 1 above (native id match); one
  // that reaches the create path is a dead incarnation from before an
  // instance reset (e.g. replayed by a peer's initial sync). Creating a row
  // here is what produced the self-homed double-domain junk stubs.
  const ourDomain = getOurIdentityDomain();
  if (ourDomain && domain.toLowerCase() === ourDomain) {
    console.log(`[federation] Refusing self-homed stub for homeUserId=${homeUserId} (${domain}) — dead incarnation of this instance`);
    return null;
  }

  const deletedMatch = db
    .select({ id: schema.users.id, isDeleted: schema.users.isDeleted })
    .from(schema.users)
    .where(and(eq(schema.users.homeUserId, homeUserId), eq(schema.users.homeInstance, domain)))
    .get();
  if (deletedMatch?.isDeleted) {
    console.log(`[federation] Skipping stub creation for deleted identity homeUserId=${homeUserId} (tombstoned)`);
    return null;
  }

  // Use the home user's real username when the caller passes a hint (the wire
  // profile snapshot from friend_request_create / friend_add / DM relay carries
  // it, and the client routes ask the home first, see
  // `resolveRemoteIdentityForClient`). This makes the local stub's `username`
  // human-readable, so client-side `parseFederatedUsername(username).baseName`
  // returns the real handle. Without a hint the stub is named
  // `<homeUserId>@<domain>`, and the first later hint renames it (above).
  const localPart = (hints?.username ?? homeUserId).toLowerCase();
  const baseUsername = `${localPart}@${domain}`.toLowerCase();

  // Guard against the (unlikely) case where this username already
  // exists — e.g. a prior partial replication or manual creation.
  let username = baseUsername;
  let collision = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  let attempt = 0;
  while (collision) {
    attempt++;
    username = `${localPart}_${attempt}@${domain}`.toLowerCase();
    collision = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
    if (attempt > 10) {
      // Extremely unlikely; use a random suffix to break out
      username = `${localPart}_${randomBytes(4).toString('hex')}@${domain}`.toLowerCase();
      break;
    }
  }

  const userId = generateSnowflake();
  const now = Date.now();

  // Seed status from the wire snapshot when available — without this, a
  // freshly-created stub for an already-online remote sticks at 'offline'
  // until the home next emits a presence transition (presence_update only
  // fires on changes, not on stub creation). Falls back to 'offline'.
  const initialStatus = hints?.status ?? 'offline';

  db.insert(schema.users).values({
    id: userId,
    username,
    displayName: null,
    passwordHash: '!federation-replicated',  // Cannot be used to log in (bcrypt never produces this)
    status: initialStatus,
    isAdmin: 0,
    homeInstance: domain,  // Normalized to bare domain
    homeUserId,
    createdAt: now,
  }).run();

  const created = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!created) {
    throw new Error(`Failed to create replicated user for homeUserId=${homeUserId}`);
  }

  console.log(`[federation] Auto-created replicated user ${userId} (${username}) for homeUserId=${homeUserId} from ${domain}`);
  return created;
}
