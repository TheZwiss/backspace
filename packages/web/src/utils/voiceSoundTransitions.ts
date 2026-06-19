/**
 * Pure decision logic for the self mute/deafen audio cues.
 *
 * Deafening is not an independent state: `voiceStore.toggleDeafen` flips
 * `isMuted` together with `isDeafened` in a single atomic update (deafen ⇒
 * muted, undeafen ⇒ unmuted), mirroring Discord. The SoundController samples
 * both effective states on the same store tick, so a naive "fire on each
 * change" approach plays the mute *and* deafen cue at once when the user hits
 * deafen.
 *
 * The coincident mute change is a side effect of the deafen action, not a
 * distinct user intent, so it must be suppressed: when the deafen state
 * changed, only the deafen/undeafen cue plays. Pure mute toggles (deafen
 * unchanged) still play the mute/unmute cue.
 */
export interface VoiceMuteState {
  muted: boolean;
  deafened: boolean;
}

export type VoiceStateSound = 'mute' | 'unmute' | 'deafen' | 'undeafen' | null;

export function selectVoiceStateSound(
  prev: VoiceMuteState,
  next: VoiceMuteState,
): VoiceStateSound {
  const deafenedChanged = prev.deafened !== next.deafened;
  if (deafenedChanged) return next.deafened ? 'deafen' : 'undeafen';

  const mutedChanged = prev.muted !== next.muted;
  if (mutedChanged) return next.muted ? 'mute' : 'unmute';

  return null;
}
