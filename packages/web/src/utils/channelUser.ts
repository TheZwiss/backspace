import { useMemo } from 'react';
import type { DmChannel, MemberWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../stores/authStore';
import { getMyUserIdForOrigin, useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
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
  /** The membership row in the channel's space; null in a DM. */
  member: MemberWithUser | null;
  /** Space channels only: the highest role's colour, or the owner rose. Null otherwise. */
  nameColor: string | null;
}

/** The store slices a channel's people are derived from. */
interface ChannelUserSources {
  dmChannels: DmChannel[];
  dmAlternatives: Map<string, Map<string, string>>;
  members: MemberWithUser[];
  channelToSpaceMap: Map<string, string>;
  channelOriginMap: Map<string, string>;
  spaces: TaggedSpace[];
}

type ChannelRoster =
  | { kind: 'dm'; dm: DmChannel; origin: string }
  | { kind: 'space'; spaceId: string; origin: string; members: MemberWithUser[]; ownerId: string | null }
  | { kind: 'unknown'; origin: string };

/**
 * The DM a channel id belongs to, and the origin that id was issued by.
 *
 * Same resolution as `resolveDmChannelId` (the pinned entry, or another
 * origin's local id for it recorded in `dmAlternatives`), done over the given
 * slices so hooks can memoize on them, and returning the issuing origin too:
 * ids under an alternate id are that origin's, not the pinned origin's.
 */
function findDm(sources: ChannelUserSources, channelId: string): { dm: DmChannel; origin: string } | null {
  const pinned = sources.dmChannels.find((dm) => dm.id === channelId);
  if (pinned) return { dm: pinned, origin: sources.channelOriginMap.get(pinned.id) ?? '' };
  for (const [federatedId, byOrigin] of sources.dmAlternatives) {
    for (const [origin, localId] of byOrigin) {
      if (localId !== channelId) continue;
      const primary = sources.dmChannels.find((dm) => dm.federatedId === federatedId);
      return primary ? { dm: primary, origin } : null;
    }
  }
  return null;
}

function rosterOf(sources: ChannelUserSources, channelId: string): ChannelRoster {
  const dm = findDm(sources, channelId);
  if (dm) return { kind: 'dm', dm: dm.dm, origin: dm.origin };

  const origin = sources.channelOriginMap.get(channelId) ?? '';
  const spaceId = sources.channelToSpaceMap.get(channelId);
  if (!spaceId) return { kind: 'unknown', origin };
  // `members` holds one space's roster at a time; rows of any other space are
  // not this channel's people.
  const members = sources.members.filter((m) => m.spaceId === spaceId);
  const ownerId = sources.spaces.find((s) => s.id === spaceId)?.ownerId ?? null;
  return { kind: 'space', spaceId, origin, members, ownerId };
}

function spaceNameColor(member: MemberWithUser, ownerId: string | null): string | null {
  if (member.roles && member.roles.length > 0) {
    const top = member.roles.reduce((best, r) => (r.position > best.position ? r : best));
    return top.color;
  }
  if (ownerId && member.userId === ownerId) return OWNER_NAME_COLOR;
  return null;
}

function fromDmUser(user: User): ChannelUser {
  return { userId: user.id, user, member: null, nameColor: null };
}

function fromSpaceMember(member: MemberWithUser, ownerId: string | null): ChannelUser {
  return { userId: member.userId, user: member.user, member, nameColor: spaceNameColor(member, ownerId) };
}

function findChannelUser(sources: ChannelUserSources, channelId: string, userId: string): ChannelUser | null {
  const roster = rosterOf(sources, channelId);
  if (roster.kind === 'dm') {
    const user = roster.dm.members.find((u) => u.id === userId);
    return user ? fromDmUser(user) : null;
  }
  if (roster.kind === 'space') {
    const member = roster.members.find((m) => m.userId === userId);
    return member ? fromSpaceMember(member, roster.ownerId) : null;
  }
  return null;
}

/** The signed-in user's id on `origin` ('' is home). */
function selfIdOnOrigin(origin: string, homeUserId: string | undefined): string | undefined {
  return origin === '' ? homeUserId : getMyUserIdForOrigin(origin);
}

function channelCandidates(
  sources: ChannelUserSources,
  channelId: string,
  homeUserId: string | undefined,
): ChannelUser[] {
  const roster = rosterOf(sources, channelId);
  if (roster.kind === 'dm') {
    const selfId = selfIdOnOrigin(roster.origin, homeUserId);
    return roster.dm.members.filter((u) => u.id !== selfId).map(fromDmUser);
  }
  if (roster.kind === 'space') {
    return roster.members.map((m) => fromSpaceMember(m, roster.ownerId));
  }
  return [];
}

function channelSelfId(sources: ChannelUserSources, channelId: string, homeUserId: string | undefined): string | undefined {
  return selfIdOnOrigin(rosterOf(sources, channelId).origin, homeUserId);
}

function currentSources(): ChannelUserSources {
  const { dmChannels, dmAlternatives, members, channelToSpaceMap, channelOriginMap, spaces } = useSpaceStore.getState();
  return { dmChannels, dmAlternatives, members, channelToSpaceMap, channelOriginMap, spaces };
}

function useSources(): ChannelUserSources {
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const dmAlternatives = useSpaceStore((s) => s.dmAlternatives);
  const members = useSpaceStore((s) => s.members);
  const channelToSpaceMap = useSpaceStore((s) => s.channelToSpaceMap);
  const channelOriginMap = useSpaceStore((s) => s.channelOriginMap);
  const spaces = useSpaceStore((s) => s.spaces);
  return useMemo(
    () => ({ dmChannels, dmAlternatives, members, channelToSpaceMap, channelOriginMap, spaces }),
    [dmChannels, dmAlternatives, members, channelToSpaceMap, channelOriginMap, spaces],
  );
}

// ─── Non-React ──────────────────────────────────────────────────────────────

/**
 * The user `userId` names in channel `channelId`, with their best-known view,
 * or null when that id is not one of the channel's people as far as this
 * client knows (a DM member it does not list, or a space whose roster is not
 * the loaded one).
 */
export function resolveChannelUser(channelId: string, userId: string): ChannelUser | null {
  const found = findChannelUser(currentSources(), channelId, userId);
  return found ? { ...found, user: getCanonicalUserView(found.user) } : null;
}

/**
 * Who can be mentioned in a channel: a DM's members except the signed-in
 * user, or the channel's space roster. Ids are the channel origin's, which is
 * what a mention token in this channel must carry.
 */
export function getChannelMentionCandidates(channelId: string): ChannelUser[] {
  return channelCandidates(currentSources(), channelId, useAuthStore.getState().user?.id);
}

/** The signed-in user's id on the origin that issued `channelId`'s ids. */
export function getSelfIdInChannel(channelId: string): string | undefined {
  return channelSelfId(currentSources(), channelId, useAuthStore.getState().user?.id);
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
    .filter((c) => matches(c.user) || matches(getCanonicalUserView(c.user)))
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
  const found = useMemo(
    () => (channelId && userId ? findChannelUser(sources, channelId, userId) : null),
    [sources, channelId, userId],
  );
  const canonical = useCanonicalUserView(found?.user ?? NO_USER);
  return useMemo(() => (found ? { ...found, user: canonical } : null), [found, canonical]);
}

/** Reactive `getChannelMentionCandidates`. */
export function useChannelMentionCandidates(channelId: string): ChannelUser[] {
  const sources = useSources();
  const homeUserId = useAuthStore((s) => s.user?.id);
  return useMemo(() => channelCandidates(sources, channelId, homeUserId), [sources, channelId, homeUserId]);
}

/** Reactive `getSelfIdInChannel`. */
export function useSelfIdInChannel(channelId: string | null): string | undefined {
  const sources = useSources();
  const homeUserId = useAuthStore((s) => s.user?.id);
  return useMemo(
    () => (channelId ? channelSelfId(sources, channelId, homeUserId) : undefined),
    [sources, channelId, homeUserId],
  );
}
