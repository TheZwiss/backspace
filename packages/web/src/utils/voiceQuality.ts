import type { AudioPreset, LocalAudioTrack, Room } from 'livekit-client';
import { Track } from 'livekit-client';
import { isVoiceBitrateKbps } from '@backspace/shared/src/constants';

/**
 * The microphone publish preset for a voice channel's quality, or `undefined`
 * when there is no valid one (a DM call, or a channel from a server that
 * predates the setting), which leaves LiveKit's own default in place.
 */
export function audioPresetForKbps(kbps: number | null | undefined): AudioPreset | undefined {
  return isVoiceBitrateKbps(kbps) ? { maxBitrate: kbps * 1000 } : undefined;
}

/**
 * Applies a channel's voice quality to a room that is already connected: the
 * default every later publish of the microphone uses (a device change
 * republishes it), and the encoder of the track that is live now.
 *
 * The sender is changed in place, with no republish, so nobody in the call
 * hears a gap when an admin changes the setting. A browser without sender
 * parameters, or a track that is not yet sending, keeps the default and gets
 * the new value on its next publish; the failure is not worth interrupting
 * the call for.
 *
 * As with the screen share limits, this is enforced by the sending client
 * only: the publish goes straight to the SFU, which has no audio bitrate cap
 * to hand a token (docs/systems/voice.md).
 */
export async function applyMicBitrate(room: Room, kbps: number | null | undefined): Promise<void> {
  const preset = audioPresetForKbps(kbps);
  if (!preset) return;
  room.options.publishDefaults = { ...room.options.publishDefaults, audioPreset: preset };

  const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const sender = (publication?.track as LocalAudioTrack | undefined)?.sender;
  if (!sender) return;
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings) return;
    const [encoding] = parameters.encodings;
    if (!encoding) return;
    encoding.maxBitrate = preset.maxBitrate;
    await sender.setParameters(parameters);
  } catch (err) {
    console.warn('[LiveKit] Could not apply the channel voice quality to the live microphone:', err);
  }
}
