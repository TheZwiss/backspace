/**
 * Voice restriction flags of a participant: permission mute ("no SPEAK here"),
 * a moderator's mute and deafen. A person is in one channel at a time, so each
 * flag is kept per `spaceId:userId`. A bot can sit in several channels of a
 * space at once, and its flags are judged (permission mute) or set (a
 * moderator's mute and deafen) per channel, so a bot seat is keyed
 * `spaceId:userId:channelId`. A row in a given channel checks both keys: the
 * bot's flag in another channel does not show.
 */

/** The key a flag is stored under: per space for a person, per seat when `channelId` names a bot seat. */
export function voiceFlagKey(spaceId: string, userId: string, channelId?: string | null): string {
  return channelId ? `${spaceId}:${userId}:${channelId}` : `${spaceId}:${userId}`;
}

/** Whether the flag set holds the participant in this channel (their per-space key or this seat's key). */
export function isVoiceFlagIn(
  flags: ReadonlySet<string>,
  spaceId: string | null | undefined,
  userId: string,
  channelId: string | null | undefined,
): boolean {
  if (!spaceId) return false;
  if (flags.has(voiceFlagKey(spaceId, userId))) return true;
  return channelId ? flags.has(voiceFlagKey(spaceId, userId, channelId)) : false;
}

/** Permission mute of a participant as shown in one channel (see `isVoiceFlagIn`). */
export function isPermissionMutedIn(
  muted: ReadonlySet<string>,
  spaceId: string | null | undefined,
  userId: string,
  channelId: string | null | undefined,
): boolean {
  return isVoiceFlagIn(muted, spaceId, userId, channelId);
}
