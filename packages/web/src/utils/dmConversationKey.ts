import type { DmChannel, User } from '@backspace/shared';

/**
 * The conversation key (`federatedId`) of a DM, for DM lists that leave it out.
 *
 * Every instance holding a copy of a federated 1-on-1 gives it the same key:
 * the first 32 hex characters of SHA-256 over the two members' home user ids,
 * sorted and joined with ':' (`computeFederatedId` in the server's
 * `utils/federationOutbox.ts`; the relay and the re-attach reconcile compute it
 * the same way, which is what lets two instances' copies be matched). Group
 * keys are random UUIDs and cannot be derived.
 *
 * Servers up to 1.6.1 listed DMs in `GET /api/dm` without the key. A client
 * connected to such a peer derives it here from the listed members, so the
 * peer's copy of a conversation is recognised as the conversation the client
 * already shows instead of becoming a second row.
 */

/** The fields a peer on 1.6.1 or older may leave out of a DM it sends. */
type PeerOptionalField =
  | 'federatedId'
  | 'ownerId'
  | 'ownerHomeUserId'
  | 'ownerHomeInstance'
  | 'name'
  | 'icon'
  | 'lastMessage'
  | 'metadataUpdatedAt';

/**
 * A DM as a server of any version may send it. Up to 1.6.1, `GET /api/dm` left
 * out `federatedId` and the group metadata. Only the client merge module
 * (`stores/dmConversations.ts`) reads this type; everything else reads the
 * full `DmChannel` it produces.
 */
export type PeerDmChannel = Omit<DmChannel, PeerOptionalField> & Partial<Pick<DmChannel, PeerOptionalField>>;

/** A 1-on-1 DM: no owner, exactly two members. Groups always have an owner. */
export function isOneOnOneDm(dm: Pick<PeerDmChannel, 'ownerId' | 'members'>): boolean {
  return !dm.ownerId && dm.members.length === 2;
}

/** The id a server hashes for a member: the home user id, or the local id of a native user. */
function homeIdentityOf(member: Pick<User, 'id' | 'homeUserId'>): string {
  return member.homeUserId || member.id;
}

/**
 * The key a server gives the 1-on-1 between these two users, or null when the
 * browser offers no Web Crypto (a page not served from a secure context).
 */
export async function oneOnOneFederatedId(
  a: Pick<User, 'id' | 'homeUserId'>,
  b: Pick<User, 'id' | 'homeUserId'>,
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const pair = [homeIdentityOf(a), homeIdentityOf(b)].sort().join(':');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(pair));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 32);
}

/**
 * Keys for the listed 1-on-1s that came without one, by channel id.
 *
 * `listed` must be the entries exactly as the server sent them, before any
 * client-side normalization: the server only keys a 1-on-1 in which at least
 * one member has a home instance elsewhere, and the members' raw
 * `homeInstance` is what says so. A 1-on-1 the server would have left
 * unkeyed gets no key here either.
 */
export async function deriveMissingOneOnOneKeys(listed: readonly PeerDmChannel[]): Promise<Map<string, string>> {
  const derived = new Map<string, string>();
  for (const dm of listed) {
    if (dm.federatedId !== undefined) continue;
    if (!isOneOnOneDm(dm)) continue;
    const [a, b] = dm.members;
    if (!a || !b) continue;
    if (!a.homeInstance && !b.homeInstance) continue;
    const key = await oneOnOneFederatedId(a, b);
    if (key) derived.set(dm.id, key);
  }
  return derived;
}
