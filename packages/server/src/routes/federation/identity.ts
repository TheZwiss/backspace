import path from 'node:path';
import { config } from '../../config.js';
import { getDb, schema } from '../../db/index.js';
import { getOurOrigin } from '../../utils/federationAuth.js';
import { generateSnowflake } from '../../utils/snowflake.js';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

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
 * Verify that an acting user's homeInstance is legitimate for this relay.
 *
 * Two valid cases:
 * 1. **Direct**: author is from the source instance (standard S2S — peer sends events for its own users).
 * 2. **Homeward relay**: author is from the *receiving* instance. This happens when a client-federation
 *    user (e.g., erin@nova logged into orbit) sends a message on a remote server, and the
 *    S2S relay forwards it back to the author's home instance. The trusted peer is just the messenger.
 *
 * Both sides are normalized to bare domain before comparison.
 */
export function verifyAttribution(actingUserHomeInstance: string, sourceInstance: string): boolean {
  const authorDomain = extractDomain(actingUserHomeInstance);
  // Case 1: author belongs to the source peer
  if (authorDomain === extractDomain(sourceInstance)) return true;
  // Case 2: homeward relay — author belongs to THIS (receiving) instance
  if (authorDomain === extractDomain(getOurOrigin())) return true;
  return false;
}


/**
 * Resolve a home user ID to a local user.
 * Matches users where home_user_id = homeUserId, or where
 * the user's own id equals homeUserId and they have no home_instance set (local user).
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
 * 1. Fast path: homeUserId column match (existing resolveLocalUser logic)
 * 2. Domain + username hint: normalized homeInstance domain + username base match
 * 3. Not found: returns undefined
 *
 * Does NOT perform side effects (backfill). See `backfillHomeUserId` for that.
 */
export function findFederatedUser(
  homeUserId: string,
  homeInstance: string,
  db: ReturnType<typeof getDb>,
  hints?: { username?: string | null },
): typeof schema.users.$inferSelect | undefined {
  // Tier 1: fast path — existing resolveLocalUser logic
  const fastMatch = resolveLocalUser(homeUserId, db);
  if (fastMatch) return fastMatch;

  // Tier 2: domain + username hint match
  if (!hints?.username) return undefined;

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

  if (candidates.length === 0) return undefined;

  // Pick best candidate: prefer real accounts over stubs, then most profile data
  if (candidates.length === 1) return candidates[0]!;

  return candidates.sort((a, b) => {
    // Real account (not federation-replicated) wins
    const aReal = a.passwordHash !== '!federation-replicated' ? 1 : 0;
    const bReal = b.passwordHash !== '!federation-replicated' ? 1 : 0;
    if (aReal !== bReal) return bReal - aReal;
    // More profile data wins
    const profileCount = (u: typeof a) =>
      [u.displayName, u.avatar, u.banner, u.bio].filter(Boolean).length;
    return profileCount(b) - profileCount(a);
  })[0]!;
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
 */
export function resolveOrCreateReplicatedUser(
  homeUserId: string,
  homeInstance: string,
  db: ReturnType<typeof getDb>,
  hints?: { username?: string | null; status?: 'online' | 'idle' | 'dnd' | 'offline' | null; deleted?: boolean | null },
): typeof schema.users.$inferSelect | null {
  const existing = findFederatedUser(homeUserId, homeInstance, db, hints);
  if (existing) return backfillHomeUserId(existing, homeUserId, db);

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
  // it). This makes the local stub's `username` human-readable, so client-side
  // `parseFederatedUsername(username).baseName` returns the real handle. Falls
  // back to the snowflake-id scheme when no hint is available (legacy paths).
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
