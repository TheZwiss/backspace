/**
 * Splits a potentially federated username into base name and domain.
 * "erin@nova.ddns.net" → { baseName: "erin", domain: "nova.ddns.net" }
 * "erin"                → { baseName: "erin", domain: null }
 */
export function parseFederatedUsername(username: string): { baseName: string; domain: string | null } {
  const atIndex = username.indexOf('@');
  if (atIndex === -1) return { baseName: username, domain: null };
  return { baseName: username.slice(0, atIndex), domain: username.slice(atIndex + 1) };
}

/**
 * The name a user is shown by: their display name, else the base of their
 * username ("erin@nova.ddns.net" is shown as "erin"). One rule for every
 * place a person is named, so a row, its header and a mention of it agree.
 * Callers that need a placeholder for an empty result add their own.
 */
export function userDisplayName(user: { displayName?: string | null; username: string }): string {
  return user.displayName || parseFederatedUsername(user.username).baseName;
}

// ─── Hosts and identities across instances ──────────────────────────────────
// Origins are `''` for the page's own instance and full URLs for the others;
// `users.home_instance` is a bare host. Two hosts are compared only through
// `homeHostOf`, never by raw string comparison.

/**
 * The host of an origin for a message, or the origin itself when it does
 * not parse, so the text still names what was meant. Compare
 * {@link normalizeOriginToHost}, whose `''` failure value is for matching.
 */
export function hostOf(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

/**
 * Bare, lowercased hostname of an origin or `homeInstance` value (no scheme, no
 * port). The comparison used to decide whether two values name the same home
 * instance.
 */
export function homeHostOf(value: string): string {
  const stripped = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return (stripped.split('/')[0] ?? '').split(':')[0]!.toLowerCase();
}

/**
 * The host an origin or `homeInstance` value names, as written (port kept):
 *
 *   null / undefined / ''   → ''
 *   'https://nova.ddns.net' → 'nova.ddns.net'
 *   'http://localhost:3000' → 'localhost:3000'
 *   'nova.ddns.net'         → 'nova.ddns.net'
 *
 * For request payloads and display. Compare hosts with {@link homeHostOf}.
 */
export function normalizeOriginToHost(input: string | null | undefined): string {
  if (!input) return '';
  if (input.includes('://')) {
    try {
      return new URL(input).host;
    } catch {
      return '';
    }
  }
  return input;
}

/**
 * Resolve a delivering origin to its concrete host. Substitutes
 * `window.location.host` for the empty-origin sentinel (`''` = our home
 * connection). All other inputs are normalized via {@link normalizeOriginToHost}.
 */
export function deliveringHost(origin: string): string {
  if (origin === '') return typeof window === 'undefined' ? '' : window.location.host;
  return normalizeOriginToHost(origin);
}

/** The identity fields of a user row, as the instance that issued it sent them. */
export interface IdentityFields {
  id: string;
  homeUserId?: string | null;
  homeInstance?: string | null;
}

/**
 * Who a person is across instances: their home instance's host and their row
 * id there. `host` is kept as the row or origin named it, for request payloads;
 * compare hosts only through {@link userKey} (or {@link homeHostOf}).
 */
export interface HomeIdentity {
  host: string;
  userId: string;
}

/**
 * The home identity of `row`, as the instance at `origin` issued it
 * (`''` = the page's own instance). The one statement of the rule; every
 * "which person is this" on the client derives from it.
 *
 * - A row with a `homeInstance` is replicated and names its home itself:
 *   `(homeInstance, homeUserId)`.
 * - A row without one is native to the instance that issued it: its home is
 *   `origin`'s host and its home id is its own id.
 * - A replicated row without a `homeUserId` (a legacy stub) names no
 *   identity: null. It is only ever the row it is.
 *
 * So Bob's native row on orbit, orbit's row for him as nova's replicated row
 * shows it, and any third instance's row for him all have the identity
 * `(orbit, <his id on orbit>)`, and a user native to nova and one native to
 * orbit never share an identity, whatever their ids (#353).
 */
export function homeIdentityOf(row: IdentityFields, origin: string): HomeIdentity | null {
  if (row.homeInstance) {
    const host = normalizeOriginToHost(row.homeInstance);
    if (!row.homeUserId || !host) return null;
    return { host, userId: row.homeUserId };
  }
  return { host: deliveringHost(origin), userId: row.id };
}

/**
 * The key for a person: `<home host>:<home user id>`, with the host compared
 * through {@link homeHostOf}. The same for every instance's row of the same
 * person. A row without an identity (a legacy stub, see
 * {@link homeIdentityOf}) gets a key of its own, `~<issuing host>:<id>`, that
 * no other row shares.
 *
 * Every client map keyed by person (user views, activities, presence,
 * friends' status) is keyed by this, and nothing looks a person up by a raw
 * row id.
 */
export function userKey(row: IdentityFields, origin: string): string {
  const identity = homeIdentityOf(row, origin);
  if (!identity) return `~${homeHostOf(deliveringHost(origin))}:${row.id}`;
  return `${homeHostOf(identity.host)}:${identity.userId}`;
}

/**
 * Whether `origin` is the home of the person `row` names, so the row is their
 * own view rather than another instance's copy of them. Always true for a row
 * native to the instance that issued it.
 */
export function isIssuedByHome(row: IdentityFields, origin: string): boolean {
  const identity = homeIdentityOf(row, origin);
  if (!identity) return false;
  return homeHostOf(identity.host) === homeHostOf(deliveringHost(origin));
}

/** The fields a presence or activity entry is about: the delivering instance's row. */
export type PresenceSubject = IdentityFields;

/** How a request names a person to an instance (a DM create, for one). */
export interface PersonTarget {
  userId?: string;
  homeUserId?: string;
  homeInstance?: string;
}

/**
 * Where to send a request about the person `row` names (issued by `origin`),
 * and how to name them there. A person with an identity is asked about on
 * the page's own instance (`''`): by their id when they are native to it,
 * otherwise by their home identity, which that server resolves or creates the
 * row for. A legacy stub has no identity to send, so it is named by its own
 * id on the instance that issued it.
 */
export function personRequest(row: IdentityFields, origin: string): { origin: string; target: PersonTarget } {
  const identity = homeIdentityOf(row, origin);
  if (!identity) return { origin, target: { userId: row.id } };
  if (origin === '' && !row.homeInstance) return { origin: '', target: { userId: row.id } };
  return { origin: '', target: { homeUserId: identity.userId, homeInstance: identity.host } };
}

/**
 * Should the federation-globe indicator render for this user, from the
 * current client's perspective?
 *
 * True iff the user is genuinely remote: their username carries an `@domain`
 * suffix AND that domain is NOT our own host. Catches the bug where a stub
 * delivered by a sibling instance (e.g. orbit-side `frank@nova.ddns.net`
 * viewed from a session logged in to nova) would otherwise show the globe.
 *
 * Compose with {@link useCanonicalUserView} at render sites: resolve the
 * canonical view first, then run this predicate so the answer reflects the
 * best-known view of the user, not whichever stub the carrying channel
 * happened to land on.
 */
export function isFederationGlobeApplicable(
  user: { username: string },
): boolean {
  const { domain } = parseFederatedUsername(user.username);
  if (!domain) return false;
  if (typeof window === 'undefined') return true; // SSR fallback
  return domain !== window.location.host;
}

// ─── The signed-in user ──────────────────────────────────────────────────────

/**
 * Everything that says a row is the signed-in user: the person their session
 * row names (`key`, the `userKey` of the page's session row) and, per
 * connected instance, the row id that instance's `ready` gave them
 * (`rowIds`, `''` = the page's own instance and its session row).
 * Built by `selfIdentityOf` from `stores/authStore.ts`, the one source.
 */
export interface SelfIdentity {
  key: string;
  rowIds: ReadonlyMap<string, string>;
}

/**
 * The signed-in user as `isMine` reads them, from the page's session row and
 * the row id each connected instance's `ready` gave them
 * (`authStore.myRowIds`). Null when signed out.
 */
export function selfIdentityOf(
  user: IdentityFields | null,
  myRowIds: ReadonlyMap<string, string>,
): SelfIdentity | null {
  if (!user) return null;
  const rowIds = new Map(myRowIds);
  rowIds.set('', user.id);
  return { key: userKey(user, ''), rowIds };
}

/**
 * Whether `row`, as `origin` issued it, is the signed-in user: the row that
 * instance named as theirs, or any row naming the same person (a replicated
 * copy of them on any instance). No username or display-name heuristic: a
 * name can be shared by two people.
 */
export function isMine(row: IdentityFields, origin: string, self: SelfIdentity | null): boolean {
  if (!self) return false;
  if (self.rowIds.get(origin) === row.id) return true;
  return homeIdentityOf(row, origin) !== null && userKey(row, origin) === self.key;
}


/**
 * The signed-in user's row as the instance at `origin` issues it, for a row
 * the client makes up before that instance sends its own (an unsent message,
 * a pending upload, a DM preview, the local voice participant). `rowId` is
 * the id that instance gave the user (`getMyUserIdForOrigin(origin)`); the
 * identity fields name the person `session` (the page's session row) names,
 * the way that instance carries them: none when `origin` is their home, else
 * their home identity. The profile fields are the session row's.
 *
 * So `isMine(ownRowAt(session, origin, id), origin, self)` holds and the
 * row's `userKey` is the session row's, whichever instance it is checked
 * against.
 */
export function ownRowAt<T extends IdentityFields>(session: T, origin: string, rowId: string): T {
  const identity = homeIdentityOf(session, '');
  if (!identity) return { ...session, id: rowId };
  if (homeHostOf(identity.host) === homeHostOf(deliveringHost(origin))) {
    return { ...session, id: rowId, homeInstance: null, homeUserId: null };
  }
  return { ...session, id: rowId, homeInstance: identity.host, homeUserId: identity.userId };
}
