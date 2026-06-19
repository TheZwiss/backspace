import { useVoiceStore } from '../stores/voiceStore';

/** Base gain applied to every sound effect before the user's SFX slider. */
export const SFX_BASE_VOLUME = 0.8;

/**
 * Effective sound-effect gain: the base SFX volume scaled by the user's SFX
 * slider (0–200, where 100 = unity). Read at play time so volume changes take
 * effect on the next cue without re-subscribing.
 */
export function getSfxVolume(): number {
  return SFX_BASE_VOLUME * (useVoiceStore.getState().soundEffectVolume / 100);
}
