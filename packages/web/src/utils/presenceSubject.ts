import type { Activity, DmChannel, PresenceIdentity, SpaceWithChannelsAndMembers } from '@backspace/shared';
import { friendRowAt, useSocialStore } from '../stores/socialStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useActivityStore, type ActivityEntry } from '../stores/activityStore';
import type { PresenceSubject } from './identity';

/**
 * Turning what a server sends about presence into `PresenceSubject`s, so the
 * activity store can key it by the person's home identity (`userKey`).
 *
 * A current server names the subject's identity itself (`homeUserId` /
 * `homeInstance` on `presence_update`, `userActivityIdentities` on `ready`).
 * A server that predates those fields sends only its own row id. For that
 * case the identity comes from a row the client already holds for the same
 * (id, origin): a friend, a member of a loaded space or a DM member delivered
 * by that origin, or a member that origin's last `ready` listed (any of its
 * spaces, open or not; `readyRowIndex`). A row the client does not hold is
 * taken as native to the delivering instance, which is what an unannotated id
 * there usually is.
 */

/** The subject of a `presence_update`, from its fields or, for an older server, from known rows. */
export function presenceSubjectOf(
  event: { userId: string } & Partial<PresenceIdentity>,
  origin: string,
): PresenceSubject {
  if (event.homeUserId !== undefined || event.homeInstance !== undefined) {
    return { id: event.userId, homeUserId: event.homeUserId ?? null, homeInstance: event.homeInstance ?? null };
  }
  return knownSubject(event.userId, origin);
}

function knownSubject(userId: string, origin: string): PresenceSubject {
  // Any instance's row of a friend, not only the row their entry is shown by.
  const friend = friendRowAt(useSocialStore.getState().friends, userId, origin);
  if (friend) return friend;

  const { spaces, currentSpaceId, members, dmChannels, channelOriginMap } = useSpaceStore.getState();
  const currentSpace = spaces.find(s => s.id === currentSpaceId);
  if (currentSpace && (currentSpace._instanceOrigin ?? '') === origin) {
    const member = members.find(m => m.userId === userId);
    if (member) return member.user;
  }

  for (const dm of dmChannels) {
    if ((channelOriginMap.get(dm.id) ?? '') !== origin) continue;
    const member = dm.members.find(m => m.id === userId);
    if (member) return member;
  }

  const listed = useActivityStore.getState().originRows.get(origin)?.get(userId);
  if (listed) return listed;

  return { id: userId };
}

/**
 * The entries of a `ready` payload's activity snapshot. Each key is the
 * delivering instance's row id; its identity comes from
 * `userActivityIdentities`, or for an older server from the space and DM
 * members in the same payload (its snapshot covered only those).
 */
export function readyActivityEntries(event: {
  userActivities?: Record<string, Activity[]>;
  userActivityIdentities?: Record<string, PresenceIdentity>;
  spaces: SpaceWithChannelsAndMembers[];
  dmChannels: DmChannel[];
}): ActivityEntry[] {
  if (!event.userActivities) return [];
  const identities = event.userActivityIdentities;
  let payloadRows: Map<string, PresenceSubject> | null = null;
  const entries: ActivityEntry[] = [];
  for (const [id, activities] of Object.entries(event.userActivities)) {
    const identity = identities?.[id];
    if (identity) {
      entries.push({ subject: { id, ...identity }, activities });
      continue;
    }
    payloadRows ??= readyRows(event);
    entries.push({ subject: payloadRows.get(id) ?? { id }, activities });
  }
  return entries;
}

/**
 * The rows a `ready` from a server that predates the identity fields lists
 * (every member of every space, every DM member), for `presenceSubjectOf` to
 * name that server's later row-id-only presence by. Null for a current
 * server: its events name the identity themselves.
 */
export function readyRowIndex(event: {
  userActivityIdentities?: Record<string, PresenceIdentity>;
  spaces: SpaceWithChannelsAndMembers[];
  dmChannels: DmChannel[];
}): Map<string, PresenceSubject> | null {
  if (event.userActivityIdentities) return null;
  return readyRows(event);
}

function readyRows(event: { spaces: SpaceWithChannelsAndMembers[]; dmChannels: DmChannel[] }): Map<string, PresenceSubject> {
  const rows = new Map<string, PresenceSubject>();
  for (const space of event.spaces) {
    for (const member of space.members ?? []) rows.set(member.userId, member.user);
  }
  for (const dm of event.dmChannels) {
    for (const member of dm.members) rows.set(member.id, member);
  }
  return rows;
}
