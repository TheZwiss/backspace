import crypto from 'node:crypto';

/**
 * DM conversation identity (docs/decisions/0002-dm-conversation-identity.md).
 *
 * A DM conversation has one key, `dm_channels.federated_id`, and this module
 * is the only code that computes or mints one. Every instance holding a copy
 * of a conversation stores the same key, which is how two instances' copies
 * (and a client connected to both) recognise each other.
 *
 * - A 1-on-1's key is derived from its two members' home identities
 *   (`oneOnOneKey`). Every 1-on-1 row stores it from insertion.
 * - A group's key is a random UUID (`mintGroupKey`), minted once, together
 *   with the owner home identity, when the group first gets a member homed
 *   elsewhere. A group no other instance holds keeps `NULL`.
 */

/** Anything with a local id and, when homed elsewhere, a home user id. */
export interface HomeIdentified {
  id: string;
  homeUserId: string | null;
}

/**
 * The id a user is known by on the instance that homes them: the home user
 * id of a user homed elsewhere, the local id of a native user.
 */
export function homeIdentityOf(user: HomeIdentified): string {
  return user.homeUserId || user.id;
}

/**
 * The key of the 1-on-1 between `a` and `b`: the first 32 hex characters of
 * SHA-256 over their two home identities, sorted and joined with ':'. Every
 * deployed instance and the web client's compatibility derivation compute
 * these exact bytes, so they can never change.
 */
export function oneOnOneKey(a: HomeIdentified, b: HomeIdentified): string {
  const sorted = [homeIdentityOf(a), homeIdentityOf(b)].sort();
  return crypto.createHash('sha256').update(sorted.join(':')).digest('hex').slice(0, 32);
}

/** A new group key. Minted once per group and never recomputed. */
export function mintGroupKey(): string {
  return crypto.randomUUID();
}
