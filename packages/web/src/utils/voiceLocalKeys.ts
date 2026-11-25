import { useSpaceStore } from '../stores/spaceStore';
import { useVoiceStore } from '../stores/voiceStore';

/**
 * "Mute User" and the volume slider of the voice menu are local to the
 * listener. For a person they are kept per user id: muting someone mutes them
 * wherever you meet them. A bot can sit in several voice channels at once, and
 * each seat plays its own audio, so a bot is kept per seat (`userId@channelId`):
 * muting the bot in one channel leaves its other seats alone. Reads accept both
 * keys, so a mute stored under the plain user id before this existed still holds.
 */

export function voiceSeatKey(userId: string, channelId: string): string {
  return `${userId}@${channelId}`;
}

/** Whether the user is a bot, from the open space's roster or the voice participants' cached user. */
export function isBotParticipant(userId: string): boolean {
  const member = useSpaceStore.getState().members.find((m) => m.userId === userId);
  if (member?.user) return !!member.user.isBot;
  const participant = useVoiceStore.getState().participants.find((p) => p.userId === userId);
  return !!participant?.cachedUser?.isBot;
}

export function isLocallyMutedIn(mutes: ReadonlyMap<string, boolean>, userId: string, channelId: string | null | undefined): boolean {
  if (mutes.get(userId)) return true;
  return channelId ? (mutes.get(voiceSeatKey(userId, channelId)) ?? false) : false;
}

export function localVolumeIn(volumes: ReadonlyMap<string, number>, userId: string, channelId: string | null | undefined): number {
  if (channelId) {
    const seat = volumes.get(voiceSeatKey(userId, channelId));
    if (seat !== undefined) return seat;
  }
  return volumes.get(userId) ?? 100;
}

export function setLocalMute(userId: string, channelId: string, muted: boolean): void {
  const { setParticipantMute } = useVoiceStore.getState();
  if (!isBotParticipant(userId)) {
    setParticipantMute(userId, muted);
    return;
  }
  setParticipantMute(voiceSeatKey(userId, channelId), muted);
  // Unmuting must also lift a mute stored under the plain id before bots were kept per seat.
  if (!muted) setParticipantMute(userId, false);
}

export function setLocalVolume(userId: string, channelId: string, volume: number): void {
  const { setParticipantVolume } = useVoiceStore.getState();
  setParticipantVolume(isBotParticipant(userId) ? voiceSeatKey(userId, channelId) : userId, volume);
}
