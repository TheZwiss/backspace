import { Room, Track, VideoPreset } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { AudioManager } from '../audio/AudioManager';

/**
 * Canonical quality presets — single source of truth.
 * Used by all screen share entry points, camera controls, and VideoQualityPopover.
 */
export const SCREEN_QUALITY_MAP: Record<string, VideoPreset> = {
  '1080p60': new VideoPreset(1920, 1080, 12_000_000, 60),
  '1080p': new VideoPreset(1920, 1080, 8_000_000, 30),
  '720p60': new VideoPreset(1280, 720, 8_000_000, 60),
  '720p': new VideoPreset(1280, 720, 5_000_000, 30),
  '540p': new VideoPreset(960, 540, 2_000_000, 30),
  '360p': new VideoPreset(640, 360, 1_000_000, 30),
};

export const AUTO_PRESET = SCREEN_QUALITY_MAP['720p60']!;

/**
 * Apply overdrive hammer to a published track — forces bitrate/resolution/framerate
 * directly on the RTCRtpSender, bypassing LiveKit's conservative defaults.
 *
 * Screen share: uses 'maintain-resolution' (text/code readability matters more than fps)
 * Camera: uses 'maintain-framerate' (smooth motion matters more than sharpness)
 */
export async function applyOverdrive(
  room: Room,
  source: Track.Source,
  preset: VideoPreset,
): Promise<void> {
  try {
    const pub = room.localParticipant.getTrackPublications().find(p => p.source === source);
    if (!pub?.track) return;

    const engine = (room as any).engine;
    const pc = engine?.pcManager?.publisher?.pc || engine?.publisher?.pc || engine?.pc;
    if (!pc) return;

    const senders = (pc as RTCPeerConnection).getSenders();
    const sender = senders.find(s => s.track?.id === (pub.track as any).mediaStreamTrack?.id);
    if (!sender) return;

    const params = sender.getParameters();
    if (!params.encodings?.[0]) return;

    params.encodings[0].maxBitrate = preset.encoding.maxBitrate;
    params.encodings[0].maxFramerate = preset.encoding.maxFramerate;
    params.encodings[0].networkPriority = 'high';

    const isScreenShare = source === Track.Source.ScreenShare;
    if (isScreenShare) {
      (params as any).degradationPreference = 'maintain-resolution';
      (params.encodings[0] as any).minBitrate = 2_000_000;
    } else {
      (params as any).degradationPreference = 'maintain-framerate';
    }

    await sender.setParameters(params);
  } catch (err) {
    console.warn('[ScreenShare] Failed to apply overdrive:', err);
  }
}

/**
 * Start screen sharing at target quality from the beginning.
 * Reads videoQuality from store at call time — no stale closures.
 */
export async function startScreenShare(room: Room): Promise<boolean> {
  const { videoQuality } = useVoiceStore.getState();
  const preset = SCREEN_QUALITY_MAP[videoQuality] || AUTO_PRESET;

  // Notify AudioManager BEFORE enabling screen share so the mic track
  // gets republished with AEC off, preventing Chrome's ducking.
  AudioManager.getInstance().setScreenShareActive(true);

  try {
    const track = await room.localParticipant.setScreenShareEnabled(true, {
      audio: true,
      resolution: preset.resolution,
      // @ts-ignore — LiveKit accepts frameRate at capture level
      frameRate: preset.encoding.maxFramerate,
    }, {
      videoCodec: 'h264',
      videoEncoding: preset.encoding,
      simulcast: false,
    } as any);

    if (!track) {
      // User cancelled the screen picker
      AudioManager.getInstance().setScreenShareActive(false);
      return false;
    }

    // Update store — screen share is now active
    useVoiceStore.setState({ isScreenSharing: true });

    // Overdrive at 2s — after WebRTC finishes negotiation
    setTimeout(async () => {
      // Read state fresh at timer fire — no stale closure
      if (!useVoiceStore.getState().isScreenSharing) return;
      const currentPreset = SCREEN_QUALITY_MAP[useVoiceStore.getState().videoQuality] || AUTO_PRESET;

      const screenPub = room.localParticipant.getTrackPublications()
        .find(p => p.source === Track.Source.ScreenShare);
      if (screenPub?.track?.mediaStreamTrack) {
        await screenPub.track.mediaStreamTrack.applyConstraints({
          width: { ideal: currentPreset.resolution.width },
          height: { ideal: currentPreset.resolution.height },
          frameRate: { ideal: currentPreset.encoding.maxFramerate, min: 15 },
        });
      }
      await applyOverdrive(room, Track.Source.ScreenShare, currentPreset);
    }, 2000);

    // Second overdrive at 5s — safety net for slow BWE convergence
    setTimeout(async () => {
      if (!useVoiceStore.getState().isScreenSharing) return;
      const currentPreset = SCREEN_QUALITY_MAP[useVoiceStore.getState().videoQuality] || AUTO_PRESET;
      await applyOverdrive(room, Track.Source.ScreenShare, currentPreset);
    }, 5000);

    return true;
  } catch (err) {
    console.error('[ScreenShare] Failed to start screen share:', err);
    AudioManager.getInstance().setScreenShareActive(false);
    return false;
  }
}

/**
 * Stop screen sharing, restore AEC, reset store.
 */
export async function stopScreenShare(room: Room): Promise<void> {
  try {
    await room.localParticipant.setScreenShareEnabled(false);
  } catch (err) {
    console.error('[ScreenShare] Failed to stop screen share:', err);
  }
  AudioManager.getInstance().setScreenShareActive(false);
  useVoiceStore.setState({ isScreenSharing: false });
}

/**
 * Change the screen share source — stops current stream, re-triggers picker.
 */
export async function changeScreenShare(room: Room): Promise<void> {
  await room.localParticipant.setScreenShareEnabled(false);
  // Small delay then re-start to re-trigger the source picker
  setTimeout(async () => {
    await startScreenShare(room);
  }, 200);
}

/**
 * Called from LocalTrackUnpublished handler to handle OS-level "Stop sharing".
 * Resets store state and restores AEC without trying to unpublish (already done).
 */
export function handleScreenShareUnpublished(): void {
  AudioManager.getInstance().setScreenShareActive(false);
  useVoiceStore.setState({ isScreenSharing: false });
}
