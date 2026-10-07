import { useMemo } from 'react';
import type { DmChannel, MemberWithUser, User } from '@backspace/shared';
import { useAuthStore, useSelfIdentity } from '../stores/authStore';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { isMine, selfIdentityOf, type SelfIdentity } from './identity';
import { locateDmChannel } from './dmChannelLookup';
import { getCanonicalUserView, useCanonicalUserView } from './userViewLookup';

/**
 * A user as seen in one channel.
 *
 * A user id means something only on the instance that issued it, so "who is
 * `<@id>`" has an answer only in the context of the channel the token was
 * written in. A DM's ids are its pinned origin's ids and its people are
 * `dm.members`; a space channel's ids are its space's origin's ids and its
 * people are that space's roster. Mentions, the mention picker, the typing
 * indicator and the self-mention highlight all answer through this module,
 * never through `spaceStore.members` alone: that field is the roster of the
 * space whose detail was loaded last, whatever channel is on screen (#338).
 */

/** Name colour of a space owner who has no role colour. */
export const OWNER_NAME_COLOR = '#fda4af';

/** How many candidates the mention picker shows. */
export const MENTION_CANDIDATE_LIMIT = 8;

export interface ChannelUser {
  /** The user's id on the channel's origin: the id a `<@id>` token in this channel carries. */
  userId: string;
  /**
   * The user row. From `resolveChannelUser` / `useChannelUser` it is the
   * best-known view (`userViews`); from the candidate list it is the row as
   * the channel's origin delivered it, which a rendered row passes through
   * `useCanonicalUserView` itself.
   */
  user: User;
  /** The instance that issued `userId` and `user` ('' is the page's own). */
  origin: string;
  /** The membership row in the channel's space; null in a DM. */
  member: MemberWithUser | null;
  /** Space channels only: the highest role's colour, or the owner rose. Null otherwise. */
  nameColor: string | null;
}

/**
 * The store slices a channel's people are derived from. The per-channel
 * lookup maps are not among them: see `ChannelFacts`.
 */
interface ChannelUserSources {
  dmChannels: DmChannel[];
  dmAlternatives: ReadonlyMap<string, ReadonlyMap<string, string>>;
  members: MemberWithUser[];
  spaces: TaggedSpace[];
}

/**
 * What the lookup maps say about one channel: its space and the origin that
 * issued its id ('' is home).
 *
 * The hooks read the channel's two entries as values rather than selecting
 * the maps (which are replaced on every change, see `stores/spaceChannels.ts`),
 * so a change to another channel does not re-render them.
 */
interface ChannelFacts {
  spaceId: string | undefined;
  origin: string;
}

type ChannelRoster =
  /**
   * `people` are the members the listed entry holds, read in `origin`'s ids
   * (the current assumption; see `DmChannelLocation`); empty when the client
   * holds no member list for the copy that issued the id.
   */
  | { kind: 'dm'; origin: string; people: readonly User[] }
  | { kind: 'space'; spaceId: string; origin: string; members: MemberWithUser[]; ownerId: string | null }
  | { kind: 'unknown'; origin: string };

function rosterOf(sources: ChannelUserSources, facts: ChannelFacts, channelId: string): ChannelRoster {
  const dm = locateDmChannel(sources.dmChannels, sources.dmAlternatives, channelId);
  if (dm?.kind === 'pinned') return { kind: 'dm', origin: facts.origin, people: dm.dm.members };
  // Another origin's id for a listed conversation: ids under it are that
  // origin's, and the listed entry's members are not that copy's list, so
  // nobody resolves here. It is still a DM, never a space channel.
  if (dm?.kind === 'alternate') return { kind: 'dm', origin: dm.origin, people: [] };

  if (!facts.spaceId) return { kind: 'unknown', origin: facts.origin };
  const spaceId = facts.spaceId;
  // `members` holds one space's roster at a time; rows of any other space are
  // not this channel's people.
  const members = sources.members.filter((m) => m.spaceId === spaceId);
  const ownerId = sources.spaces.find((s) => s.id === spaceId)?.ownerId ?? null;
  return { kind: 'space', spaceId, origin: facts.origin, members, ownerId };
}

function spaceNameColor(member: MemberWithUser, ownerId: string | null): string | null {
  if (member.roles && member.roles.length > 0) {
    const top = member.roles.reduce((best, r) => (r.position > best.position ? r : best));
    return top.color;
  }
  if (ownerId && member.userId === ownerId) return OWNER_NAME_COLOR;
  return null;
}

function fromDmUser(user: User, origin: string): ChannelUser {
  return { userId: user.id, user, origin, member: null, nameColor: null };
}

function fromSpaceMember(member: MemberWithUser, ownerId: string | null, origin: string): ChannelUser {
  return { userId: member.userId, user: member.user, origin, member, nameColor: spaceNameColor(member, ownerId) };
}

function findChannelUser(
  sources: ChannelUserSources,
  facts: ChannelFacts,
  channelId: string,
  userId: string,
): ChannelUser | null {
  const roster = rosterOf(sources, facts, channelId);
  if (roster.kind === 'dm') {
    const user = roster.people.find((u) => u.id === userId);
    return user ? fromDmUser(user, roster.origin) : null;
  }
  if (roster.kind === 'space') {
    const member = roster.members.find((m) => m.userId === userId);
    return member ? fromSpaceMember(member, roster.ownerId, roster.origin) : null;
  }
  return null;
}

function channelCandidates(
  sources: ChannelUserSources,
  facts: ChannelFacts,
  channelId: string,
  self: SelfIdentity | null,
): ChannelUser[] {
  const roster = rosterOf(sources, facts, channelId);
  if (roster.kind === 'dm') {
    return roster.people.filter((u) => !isMine(u, roster.origin, self)).map((u) => fromDmUser(u, roster.origin));
  }
  if (roster.kind === 'space') {
    return roster.members.map((m) => fromSpaceMember(m, roster.ownerId, roster.origin));
  }
  return [];
}

function channelSelfId(
  sources: ChannelUserSources,
  facts: ChannelFacts,
  channelId: string,
  self: SelfIdentity | null,
): string | undefined {
  return self?.rowIds.get(rosterOf(sources, facts, channelId).origin);
}

function currentSelf(): SelfIdentity | null {
  const { user, myRowIds } = useAuthStore.getState();
  return selfIdentityOf(user, myRowIds);
}

function currentSources(): ChannelUserSources {
  const { dmChannels, dmAlternatives, members, spaces } = useSpaceStore.getState();
  return { dmChannels, dmAlternatives, members, spaces };
}

function currentFacts(channelId: string): ChannelFacts {
  const { channelToSpaceMap, channelOriginMap } = useSpaceStore.getState();
  return { spaceId: channelToSpaceMap.get(channelId), origin: channelOriginMap.get(channelId) ?? '' };
}

function useSources(): ChannelUserSources {
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const dmAlternatives = useSpaceStore((s) => s.dmAlternatives);
  const members = useSpaceStore((s) => s.members);
  const spaces = useSpaceStore((s) => s.spaces);
  return useMemo(
    () => ({ dmChannels, dmAlternatives, members, spaces }),
    [dmChannels, dmAlternatives, members, spaces],
  );
}

/** Reactive `currentFacts`: the channel's entries read as values (see `ChannelFacts`). */
function useFacts(channelId: string | null): ChannelFacts {
  const spaceId = useSpaceStore((s) => (channelId ? s.channelToSpaceMap.get(channelId) : undefined));
  const origin = useSpaceStore((s) => (channelId ? s.channelOriginMap.get(channelId) ?? '' : ''));
  return useMemo(() => ({ spaceId, origin }), [spaceId, origin]);
}

// ─── Non-React ──────────────────────────────────────────────────────────────

/**
 * The user `userId` names in channel `channelId`, with their best-known view,
 * or null when that id is not one of the channel's people as far as this
 * client knows (a DM member it does not list, or a space whose roster is not
 * the loaded one).
 */
export function resolveChannelUser(channelId: string, userId: string): ChannelUser | null {
  const found = findChannelUser(currentSources(), currentFacts(channelId), channelId, userId);
  return found ? { ...found, user: getCanonicalUserView(found.user, found.origin) } : null;
}

/**
 * Who can be mentioned in a channel: a DM's members except the signed-in
 * user, or the channel's space roster. Ids are the channel origin's, which is
 * what a mention token in this channel must carry.
 */
export function getChannelMentionCandidates(channelId: string): ChannelUser[] {
  return channelCandidates(currentSources(), currentFacts(channelId), channelId, currentSelf());
}

/** The signed-in user's id on the origin that issued `channelId`'s ids. */
export function getSelfIdInChannel(channelId: string): string | undefined {
  return channelSelfId(currentSources(), currentFacts(channelId), channelId, currentSelf());
}

/** Whether `userId`, as written in channel `channelId`, is the signed-in user. */
export function isSelfInChannel(channelId: string, userId: string): boolean {
  const selfId = getSelfIdInChannel(channelId);
  return selfId !== undefined && selfId === userId;
}

/**
 * Candidates whose shown name or username contains `query`, case-insensitive,
 * at most `limit` of them. Matches the best-known view as well as the row the
 * origin delivered, so a stub whose own row has no display name is found by
 * the name the picker shows for it.
 */
export function filterMentionCandidates(
  candidates: readonly ChannelUser[],
  query: string,
  limit: number = MENTION_CANDIDATE_LIMIT,
): ChannelUser[] {
  const q = query.toLowerCase();
  const matches = (user: User): boolean =>
    (user.displayName ?? '').toLowerCase().includes(q) || user.username.toLowerCase().includes(q);
  return candidates
    .filter((c) => matches(c.user) || matches(getCanonicalUserView(c.user, c.origin)))
    .slice(0, limit);
}

// ─── React ──────────────────────────────────────────────────────────────────

const NO_USER: User = {
  id: '',
  username: '',
  displayName: null,
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: null,
  bio: null,
  status: 'offline',
  customStatus: null,
  isAdmin: false,
  createdAt: 0,
  homeInstance: null,
  homeUserId: null,
  replicatedInstances: [],
};

/**
 * Reactive `resolveChannelUser`. A null `channelId` or `userId` (no channel
 * context, no user to look up) is always a miss.
 */
export function useChannelUser(channelId: string | null, userId: string | null): ChannelUser | null {
  const sources = useSources();
  const facts = useFacts(channelId);
  const found = useMemo(
    () => (channelId && userId ? findChannelUser(sources, facts, channelId, userId) : null),
    [sources, facts, channelId, userId],
  );
  const canonical = useCanonicalUserView(found?.user ?? NO_USER, found?.origin ?? '');
  return useMemo(() => (found ? { ...found, user: canonical } : null), [found, canonical]);
}

/** Reactive `getChannelMentionCandidates`. */
export function useChannelMentionCandidates(channelId: string): ChannelUser[] {
  const sources = useSources();
  const facts = useFacts(channelId);
  const self = useSelfIdentity();
  return useMemo(
    () => channelCandidates(sources, facts, channelId, self),
    [sources, facts, channelId, self],
  );
}

/** Reactive `getSelfIdInChannel`. */
export function useSelfIdInChannel(channelId: string | null): string | undefined {
  const sources = useSources();
  const facts = useFacts(channelId);
  const self = useSelfIdentity();
  return useMemo(
    () => (channelId ? channelSelfId(sources, facts, channelId, self) : undefined),
    [sources, facts, channelId, self],
  );
}
