import { Room, Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import type { ScreenShareConfig } from '../stores/voiceStore';
import { AudioManager } from '../audio/AudioManager';
import { wsSend } from '../hooks/useWebSocket';
import { getPublisherPC, getMediaStreamTrack } from './livekitInternals';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverdriveOptions {
  maxBitrate: number;
  maxFramerate: number;
  minBitrate: number;
  degradationPreference: RTCDegradationPreference;
}

export interface ScreenShareBuildResult {
  capture: { width: number; height: number; frameRate: number };
  publish: { videoCodec: 'h264'; videoEncoding: { maxBitrate: number; maxFramerate: number }; simulcast: false };
  overdrive: OverdriveOptions;
  contentHint: 'motion' | 'detail';
}

// ---------------------------------------------------------------------------
// Camera preset (fixed 720p30 H264, decoupled from screen share)
// ---------------------------------------------------------------------------

export const CAMERA_PRESET = {
  resolution: { width: 1280, height: 720 },
  encoding: { maxBitrate: 2_000_000, maxFramerate: 30 },
  codec: 'h264' as const,
} as const;

export const CAMERA_OVERDRIVE: OverdriveOptions = {
  maxBitrate: 2_000_000,
  maxFramerate: 30,
  minBitrate: 0,
  degradationPreference: 'maintain-framerate',
};

// ---------------------------------------------------------------------------
// Screen share builder — three independent axes → computed result
// ---------------------------------------------------------------------------

const BITRATE_MATRIX: Record<number, Record<number, number>> = {
  1080: { 60: 12_000_000, 45: 10_000_000, 30: 8_000_000 },
  720:  { 60: 6_000_000,  45: 5_000_000,  30: 4_000_000 },
  540:  { 60: 3_000_000,  45: 2_500_000,  30: 2_000_000 },
};

const WIDTH_MAP: Record<number, number> = { 1080: 1920, 720: 1280, 540: 960 };

export function buildScreenShareOptions(config: ScreenShareConfig): ScreenShareBuildResult {
  const { height, fps, mode, customBitrateKbps } = config;
  const width = WIDTH_MAP[height]!;
  const maxBitrate = customBitrateKbps != null
    ? customBitrateKbps * 1000
    : BITRATE_MATRIX[height]![fps]!;
  const minBitrate = Math.round(maxBitrate * 0.25);

  return {
    capture: { width, height, frameRate: fps },
    publish: {
      videoCodec: 'h264',
      videoEncoding: { maxBitrate, maxFramerate: fps },
      simulcast: false,
    },
    overdrive: {
      maxBitrate,
      maxFramerate: fps,
      minBitrate,
      degradationPreference: mode === 'text' ? 'maintain-resolution' : 'balanced',
    },
    contentHint: mode === 'text' ? 'detail' : 'motion',
  };
}

// ---------------------------------------------------------------------------
// Overdrive — forces bitrate/resolution/framerate on RTCRtpSender
// ---------------------------------------------------------------------------

export async function applyOverdrive(
  room: Room,
  source: Track.Source,
  options: OverdriveOptions,
): Promise<void> {
  try {
    const pub = room.localParticipant.getTrackPublications().find(p => p.source === source);
    if (!pub?.track) return;

    const pc = getPublisherPC(room);
    if (!pc) return;

    const pubMediaTrack = getMediaStreamTrack(pub.track);
    const senders = pc.getSenders();
    const sender = senders.find(s => s.track?.id === pubMediaTrack?.id);
    if (!sender) return;

    const params = sender.getParameters();
    if (!params.encodings?.[0]) return;

    params.encodings[0].maxBitrate = options.maxBitrate;
    params.encodings[0].maxFramerate = options.maxFramerate;
    params.encodings[0].networkPriority = 'high';
    (params as any).degradationPreference = options.degradationPreference;
    if (options.minBitrate > 0) {
      (params.encodings[0] as any).minBitrate = options.minBitrate;
    }

    await sender.setParameters(params);
  } catch (err) {
    console.warn('[ScreenShare] Failed to apply overdrive:', err);
  }
}

// ---------------------------------------------------------------------------
// Start screen sharing
// ---------------------------------------------------------------------------

export async function startScreenShare(room: Room): Promise<boolean> {
  const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);

  try {
    const track = await room.localParticipant.setScreenShareEnabled(true, {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
      resolution: { width: opts.capture.width, height: opts.capture.height },
      // @ts-ignore — LiveKit accepts frameRate at capture level
      frameRate: opts.capture.frameRate,
    }, {
      videoCodec: 'h264',
      videoEncoding: opts.publish.videoEncoding,
      simulcast: false,
    } as any);

    if (!track) {
      return false;
    }

    // Rebuild mic without AEC now that screen share is acquired
    AudioManager.getInstance().setScreenShareActive(true);

    // Set content hint from builder (motion for gaming, detail for text)
    const screenPub = room.localParticipant.getTrackPublications()
      .find(p => p.source === Track.Source.ScreenShare);
    if (screenPub?.track?.mediaStreamTrack) {
      screenPub.track.mediaStreamTrack.contentHint = opts.contentHint;
    }

    useVoiceStore.setState({ isScreenSharing: true });

    // Overdrive at 2s — after WebRTC finishes negotiation
    setTimeout(async () => {
      if (!useVoiceStore.getState().isScreenSharing) return;
      // Rebuild from fresh store state — no stale closures
      const freshOpts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);

      const screenPub = room.localParticipant.getTrackPublications()
        .find(p => p.source === Track.Source.ScreenShare);
      if (screenPub?.track?.mediaStreamTrack) {
        await screenPub.track.mediaStreamTrack.applyConstraints({
          width: { ideal: freshOpts.capture.width },
          height: { ideal: freshOpts.capture.height },
          frameRate: { ideal: freshOpts.capture.frameRate, min: 15 },
        });
        // Re-assert contentHint (LiveKit may strip it during renegotiation)
        screenPub.track.mediaStreamTrack.contentHint = freshOpts.contentHint;
      }
      await applyOverdrive(room, Track.Source.ScreenShare, freshOpts.overdrive);
    }, 2000);

    // Second overdrive at 5s — safety net for slow BWE convergence
    setTimeout(async () => {
      if (!useVoiceStore.getState().isScreenSharing) return;
      const freshOpts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
      await applyOverdrive(room, Track.Source.ScreenShare, freshOpts.overdrive);
    }, 5000);

    return true;
  } catch (err) {
    console.error('[ScreenShare] Failed to start screen share:', err);
    AudioManager.getInstance().setScreenShareActive(false);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stop screen sharing
// ---------------------------------------------------------------------------

export async function stopScreenShare(room: Room): Promise<void> {
  try {
    await room.localParticipant.setScreenShareEnabled(false);
  } catch (err) {
    console.error('[ScreenShare] Failed to stop screen share:', err);
  }
  AudioManager.getInstance().setScreenShareActive(false);
  useVoiceStore.setState({ isScreenSharing: false });
}

// ---------------------------------------------------------------------------
// Change screen share source — stops current stream, re-triggers picker
// ---------------------------------------------------------------------------

export async function changeScreenShare(room: Room): Promise<void> {
  await room.localParticipant.setScreenShareEnabled(false);
  setTimeout(async () => {
    await startScreenShare(room);
  }, 200);
}

// ---------------------------------------------------------------------------
// OS-level "Stop sharing" handler
// ---------------------------------------------------------------------------

export function handleScreenShareUnpublished(): void {
  AudioManager.getInstance().setScreenShareActive(false);
  useVoiceStore.setState({ isScreenSharing: false });
  const { isMuted, isDeafened, isCameraOn } = useVoiceStore.getState();
  wsSend({ type: 'voice_status', isMuted, isDeafened, isCameraOn, isScreenSharing: false });
}
