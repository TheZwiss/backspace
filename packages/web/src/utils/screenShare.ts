import { Room, Track, BackupCodecPolicy } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import type { ScreenShareConfig } from '../stores/voiceStore';
import { getStreamingLimits } from '../stores/settingsStore';
import { getPublisherPC, getMediaStreamTrack } from './livekitInternals';
import { broadcastVoiceStatus } from './voice';
import {
  STANDARD_RESOLUTIONS, STANDARD_FRAMERATES, WIDTH_MAP,
  BITRATE_MATRIX_KBPS,
  type StandardResolution,
} from '@backspace/shared/src/constants';

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
  publish: {
    videoCodec: 'vp9' | 'h264';
    videoEncoding: { maxBitrate: number; maxFramerate: number };
    simulcast: false;
    backupCodec?: { codec: 'h264'; encoding: { maxBitrate: number; maxFramerate: number } };
    backupCodecPolicy?: BackupCodecPolicy;
  };
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

// ---------------------------------------------------------------------------
// Resolve a matrix cell: admin override first, then default (all in kbps)
// ---------------------------------------------------------------------------

function resolveMatrixKbps(height: number, fps: number, overrides: Record<string, number> | null | undefined): number {
  const key = `${height}_${fps}`;
  if (overrides?.[key] != null) return overrides[key]!;
  return BITRATE_MATRIX_KBPS[height]?.[fps] ?? BITRATE_MATRIX_KBPS[1080]![60]!;
}

// ---------------------------------------------------------------------------
// Native mode — pixel-count-proportional bitrate computation
// ---------------------------------------------------------------------------

function computeNativeBitrate(
  capturedWidth: number,
  capturedHeight: number,
  fps: number,
  overrides: Record<string, number> | null | undefined,
): number {
  const capturedPixels = capturedWidth * capturedHeight;

  // Find nearest known resolution tier by pixel count (handles ultrawides correctly)
  let nearestHeight: StandardResolution = 1080;
  let nearestDist = Infinity;
  for (const h of STANDARD_RESOLUTIONS) {
    const knownPixels = WIDTH_MAP[h] * h;
    const dist = Math.abs(capturedPixels - knownPixels);
    if (dist < nearestDist) { nearestDist = dist; nearestHeight = h; }
  }

  // Snap to nearest known framerate
  let nearestFps = 30;
  let nearestFpsDist = Infinity;
  for (const f of STANDARD_FRAMERATES) {
    const dist = Math.abs(fps - f);
    if (dist < nearestFpsDist) { nearestFpsDist = dist; nearestFps = f; }
  }

  const baseKbps = resolveMatrixKbps(nearestHeight, nearestFps, overrides);
  const nearestPixels = WIDTH_MAP[nearestHeight] * nearestHeight;

  // Scale proportionally by pixel count and framerate — result in kbps
  return Math.round(baseKbps * (capturedPixels / nearestPixels) * (fps / nearestFps));
}

export function buildScreenShareOptions(config: ScreenShareConfig): ScreenShareBuildResult {
  const { height, fps, mode, customBitrateKbps } = config;
  const isNative = height === 'native';
  const limits = getStreamingLimits();
  const overrides = limits.bitrateMatrixOverrides;

  // Capture dimensions: sentinel 0 for native (caller skips resolution constraint)
  const captureWidth = isNative ? 0 : WIDTH_MAP[height as StandardResolution] ?? 1920;
  const captureHeight = isNative ? 0 : (height as number);

  // Resolve bitrate in kbps: custom > override > default > native estimate
  let rawKbps: number;
  if (customBitrateKbps != null) {
    rawKbps = customBitrateKbps;
  } else if (isNative) {
    const nearestFps = STANDARD_FRAMERATES.reduce((a, b) =>
      Math.abs(b - fps) < Math.abs(a - fps) ? b : a
    );
    rawKbps = resolveMatrixKbps(2160, nearestFps, overrides);
  } else {
    rawKbps = resolveMatrixKbps(height as number, fps, overrides);
  }

  // Clamp to instance limits (all in kbps)
  const clampedKbps = Math.min(Math.max(rawKbps, limits.minBitrateKbps), limits.maxBitrateKbps);

  // Convert to bps ONLY at the WebRTC boundary
  const bps = clampedKbps * 1000;
  const minBps = Math.round(bps * 0.25);

  // Gaming mode: H.264 primary (hardware NVENC/QSV encoding, zero CPU impact on games)
  // Text mode: VP9 primary (better compression for sharp text) with H.264 backup for Safari
  const isGaming = mode === 'gaming';

  return {
    capture: { width: captureWidth, height: captureHeight, frameRate: fps },
    publish: {
      videoCodec: isGaming ? 'h264' : 'vp9',
      videoEncoding: { maxBitrate: bps, maxFramerate: fps },
      simulcast: false,
      // H.264 is universally supported — no backup needed for gaming mode.
      // VP9 needs H.264 backup for Safari/incompatible viewers.
      ...(isGaming ? {} : {
        backupCodec: {
          codec: 'h264' as const,
          encoding: { maxBitrate: bps, maxFramerate: fps },
        },
        backupCodecPolicy: BackupCodecPolicy.SIMULCAST,
      }),
    },
    overdrive: {
      maxBitrate: bps,
      maxFramerate: fps,
      minBitrate: minBps,
      degradationPreference: isGaming ? 'balanced' : 'maintain-resolution',
    },
    contentHint: isGaming ? 'motion' : 'detail',
  };
}

// ---------------------------------------------------------------------------
// Shared helper: resolve native-mode overdrive from actual track dimensions
// Used by both applyScreenShareOverdrive (screenShare.ts) and updateActiveTracks (useLiveKit.ts)
// ---------------------------------------------------------------------------

export function resolveNativeOverdrive(
  mediaTrack: MediaStreamTrack | null | undefined,
  config: ScreenShareConfig,
  opts: ScreenShareBuildResult,
): void {
  if (config.height !== 'native' || config.customBitrateKbps != null || !mediaTrack) return;
  const settings = mediaTrack.getSettings();
  if (!settings.width || !settings.height) return;

  const limits = getStreamingLimits();
  const nativeKbps = computeNativeBitrate(settings.width, settings.height, config.fps, limits.bitrateMatrixOverrides);
  const clampedKbps = Math.min(Math.max(nativeKbps, limits.minBitrateKbps), limits.maxBitrateKbps);

  // Convert to bps at the mutation point
  const bps = clampedKbps * 1000;
  opts.overdrive.maxBitrate = bps;
  opts.overdrive.minBitrate = Math.round(bps * 0.25);
  opts.publish.videoEncoding.maxBitrate = bps;
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
    // For native mode: omit resolution constraint to capture at display's full native resolution
    const captureOptions: any = {
      audio: config.shareAudio ? {
        // Chrome 141+: exclude this tab's own audio from system audio capture
        // @ts-ignore — restrictOwnAudio is not yet in all TS type definitions
        restrictOwnAudio: true,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      } : false,
      frameRate: opts.capture.frameRate,
    };
    if (opts.capture.width > 0 && opts.capture.height > 0) {
      captureOptions.resolution = { width: opts.capture.width, height: opts.capture.height };
    }

    const track = await room.localParticipant.setScreenShareEnabled(true, captureOptions, {
      videoCodec: opts.publish.videoCodec,
      videoEncoding: opts.publish.videoEncoding,
      simulcast: opts.publish.simulcast,
      ...(opts.publish.backupCodec ? {
        backupCodec: opts.publish.backupCodec,
        backupCodecPolicy: opts.publish.backupCodecPolicy,
      } : {}),
    });

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
      if (freshOpts.capture.width > 0 && freshOpts.capture.height > 0) {
        // Standard mode: apply resolution + frameRate together
        await screenPub.track.mediaStreamTrack.applyConstraints({
          width: { ideal: freshOpts.capture.width },
          height: { ideal: freshOpts.capture.height },
          frameRate: { ideal: freshOpts.capture.frameRate, min: 15 },
        });
      } else {
        // Native mode: apply frameRate only — never pass 0 to width/height
        await screenPub.track.mediaStreamTrack.applyConstraints({
          frameRate: { ideal: freshOpts.capture.frameRate, min: 15 },
        });
      }
      screenPub.track.mediaStreamTrack.contentHint = freshOpts.contentHint;

      // For native mode, compute correct bitrate from actual track dimensions
      resolveNativeOverdrive(screenPub.track.mediaStreamTrack, useVoiceStore.getState().screenShareConfig, freshOpts);
    }
    await applyOverdrive(room, Track.Source.ScreenShare, freshOpts.overdrive);
  }, 2000);

  // Second overdrive at 5s — safety net for slow BWE convergence
  setTimeout(async () => {
    if (!useVoiceStore.getState().isScreenSharing) return;
    const freshOpts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
    const screenPub5 = room.localParticipant.getTrackPublications()
      .find(p => p.source === Track.Source.ScreenShare);
    if (screenPub5?.track?.mediaStreamTrack) {
      resolveNativeOverdrive(screenPub5.track.mediaStreamTrack, useVoiceStore.getState().screenShareConfig, freshOpts);
    }
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
