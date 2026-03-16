import { Room, Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import type { ScreenShareConfig } from '../stores/voiceStore';
import { getStreamingLimits } from '../stores/settingsStore';
import { getPublisherPC, getMediaStreamTrack } from './livekitInternals';
import { broadcastVoiceStatus } from './voice';

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
  publish: { videoCodec: 'vp9'; videoEncoding: { maxBitrate: number; maxFramerate: number }; simulcast: false };
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
  1080: { 60: 8_000_000, 45: 7_000_000, 30: 6_000_000 },
  720:  { 60: 4_000_000, 45: 3_500_000, 30: 3_000_000 },
  540:  { 60: 2_500_000, 45: 2_000_000, 30: 1_500_000 },
};

const WIDTH_MAP: Record<number, number> = { 1080: 1920, 720: 1280, 540: 960 };

export function buildScreenShareOptions(config: ScreenShareConfig): ScreenShareBuildResult {
  const { height, fps, mode, customBitrateKbps } = config;
  const width = WIDTH_MAP[height]!;
  const limits = getStreamingLimits();
  const rawBitrate = customBitrateKbps != null
    ? customBitrateKbps * 1000
    : BITRATE_MATRIX[height]![fps]!;
  // Clamp to instance-level admin limits
  const maxBitrate = Math.min(Math.max(rawBitrate, limits.minBitrateKbps * 1000), limits.maxBitrateKbps * 1000);
  const minBitrate = Math.round(maxBitrate * 0.25);

  return {
    capture: { width, height, frameRate: fps },
    publish: {
      videoCodec: 'vp9',
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
    if (!params.encodings?.length) return;

    // Target the highest-quality layer. With simulcast, encodings[0] is the
    // lowest layer; our overdrive must hit the top layer so the custom bitrate
    // slider controls the full-resolution stream, not the quarter-res one.
    // For non-simulcast tracks (single encoding), length - 1 === 0.
    const idx = params.encodings.length - 1;
    params.encodings[idx]!.maxBitrate = options.maxBitrate;
    params.encodings[idx]!.maxFramerate = options.maxFramerate;
    params.encodings[idx]!.networkPriority = 'high';
    (params as any).degradationPreference = options.degradationPreference;
    if (options.minBitrate > 0) {
      (params.encodings[idx] as any).minBitrate = options.minBitrate;
    }

    await sender.setParameters(params);
  } catch (err) {
    console.warn('[ScreenShare] Failed to apply overdrive:', err);
  }
}

// ---------------------------------------------------------------------------
// Start screen sharing — single path via setScreenShareEnabled()
// In Electron, getDisplayMedia() is intercepted by setDisplayMediaRequestHandler
// in the main process, which shows the custom picker automatically.
// ---------------------------------------------------------------------------

export async function startScreenShare(room: Room): Promise<boolean> {
  console.log('[SS] startScreenShare called, room state:', room.state);
  const config = useVoiceStore.getState().screenShareConfig;
  const opts = buildScreenShareOptions(config);

  try {
    const track = await room.localParticipant.setScreenShareEnabled(true, {
      audio: config.shareAudio ? {
        // Chrome 141+: exclude this tab's own audio from system audio capture
        // Prevents feedback loop where remote voices are captured and echoed back
        // Silently ignored by older browsers / Electron's Chromium 130
        // @ts-ignore — restrictOwnAudio is not yet in all TS type definitions
        restrictOwnAudio: true,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      } : false,
      resolution: { width: opts.capture.width, height: opts.capture.height },
      // @ts-ignore — LiveKit accepts frameRate at capture level
      frameRate: opts.capture.frameRate,
    }, {
      videoCodec: opts.publish.videoCodec,
      videoEncoding: opts.publish.videoEncoding,
      simulcast: opts.publish.simulcast,
    } as any);

    console.log('[SS] setScreenShareEnabled returned:', !!track);
    if (!track) {
      return false;
    }

    // Set content hint from builder (motion for gaming, detail for text)
    const screenPub = room.localParticipant.getTrackPublications()
      .find(p => p.source === Track.Source.ScreenShare);
    if (screenPub?.track?.mediaStreamTrack) {
      screenPub.track.mediaStreamTrack.contentHint = opts.contentHint;
    }

    useVoiceStore.setState({ isScreenSharing: true });
    applyScreenShareOverdrive(room);
    return true;
  } catch (err) {
    console.error('[ScreenShare] Failed to start screen share:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared overdrive scheduling
// ---------------------------------------------------------------------------

function applyScreenShareOverdrive(room: Room): void {
  // Overdrive at 2s — after WebRTC finishes negotiation
  setTimeout(async () => {
    if (!useVoiceStore.getState().isScreenSharing) return;
    const freshOpts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);

    const screenPub = room.localParticipant.getTrackPublications()
      .find(p => p.source === Track.Source.ScreenShare);
    if (screenPub?.track?.mediaStreamTrack) {
      await screenPub.track.mediaStreamTrack.applyConstraints({
        width: { ideal: freshOpts.capture.width },
        height: { ideal: freshOpts.capture.height },
        frameRate: { ideal: freshOpts.capture.frameRate, min: 15 },
      });
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
  useVoiceStore.setState({ isScreenSharing: false });
}

// ---------------------------------------------------------------------------
// Change screen share source — stops current stream, re-triggers picker
// ---------------------------------------------------------------------------

export async function changeScreenShare(room: Room): Promise<void> {
  await stopScreenShare(room);
  setTimeout(async () => {
    await startScreenShare(room);
  }, 200);
}

// ---------------------------------------------------------------------------
// OS-level "Stop sharing" handler
// ---------------------------------------------------------------------------

export function handleScreenShareUnpublished(): void {
  useVoiceStore.setState({ isScreenSharing: false });
  broadcastVoiceStatus();
}
