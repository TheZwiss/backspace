import { Room, Track, BackupCodecPolicy } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import type { ScreenShareConfig } from '../stores/voiceStore';
import { getStreamingLimits } from '../stores/settingsStore';
import { getPublisherPC, getMediaStreamTrack } from './livekitInternals';
import { broadcastVoiceStatus } from './voice';
import { activate as activateHwOverdrive, deactivate as deactivateHwOverdrive } from './hwOverdrive';
import { useUIStore } from '../stores/uiStore';
import { openScreenShareSetup } from '../stores/screenShareSetupStore';
import i18n from '../i18n';
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
    backupCodec?: { codec: 'vp8' | 'h264'; encoding: { maxBitrate: number; maxFramerate: number } };
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

  // Resolve bitrate in kbps: custom (if allowed) > override > default > native estimate
  let rawKbps: number;
  if (customBitrateKbps != null && limits.allowCustomBitrate) {
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

  // hwOverdrive forces H.264 with SDP profile override for hardware encoding.
  // Default is always VP9. Both paths get VP8 SIMULCAST backup (dynacast pauses
  // the backup when no subscriber needs it — near-zero cost).
  const hwOverdrive = useVoiceStore.getState().hwOverdrive;

  // Backup encoding: cap at 30fps and proportional bitrate to keep CPU overhead low
  const backupFps = Math.min(fps, 30);
  const backupBps = Math.round(bps * (backupFps / fps));

  return {
    capture: { width: captureWidth, height: captureHeight, frameRate: fps },
    publish: {
      videoCodec: hwOverdrive ? 'h264' : 'vp9',
      videoEncoding: { maxBitrate: bps, maxFramerate: fps },
      simulcast: false,
      backupCodec: {
        codec: 'vp8' as const,
        encoding: { maxBitrate: backupBps, maxFramerate: backupFps },
      },
      backupCodecPolicy: BackupCodecPolicy.SIMULCAST,
    },
    overdrive: {
      maxBitrate: bps,
      maxFramerate: fps,
      minBitrate: minBps,
      degradationPreference: mode === 'text' ? 'maintain-resolution' : 'balanced',
    },
    contentHint: mode === 'text' ? 'detail' : 'motion',
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
  const limits = getStreamingLimits();
  const effectiveCustom = limits.allowCustomBitrate ? config.customBitrateKbps : null;
  if (config.height !== 'native' || effectiveCustom != null || !mediaTrack) return;
  const settings = mediaTrack.getSettings();
  if (!settings.width || !settings.height) return;

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
// Capture constraints — the one place that turns config into getDisplayMedia input
// ---------------------------------------------------------------------------

function buildCaptureConstraints(config: ScreenShareConfig, opts: ScreenShareBuildResult): DisplayMediaStreamOptions {
  const video: MediaTrackConstraints = { frameRate: { ideal: opts.capture.frameRate } };
  // Native mode: no resolution constraint so the display captures at full size
  if (opts.capture.width > 0 && opts.capture.height > 0) {
    video.width = { ideal: opts.capture.width };
    video.height = { ideal: opts.capture.height };
  }
  return {
    video,
    audio: config.shareAudio ? {
      // Request own-playback exclusion where supported; custom Electron picker needs 43.4+
      // @ts-ignore — restrictOwnAudio is not yet in all TS type definitions
      restrictOwnAudio: true,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    } : false,
  };
}

// ---------------------------------------------------------------------------
// Stage — capture without publishing.
//
// Every screen share starts here, on every platform. Browsers open their native
// prompt; Electron's main process answers the request from the renderer's
// preselected source (see ScreenShareSetup). The returned stream is previewed
// in the setup screen and only reaches the room via publishScreenShare(), so
// cancelling the setup never sends a frame.
// ---------------------------------------------------------------------------

export function isScreenCaptureSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

/**
 * The user dismissed the picker rather than hitting a real failure. Both names
 * occur in the wild: Chromium raises NotAllowedError, Firefox and the Wayland
 * portal raise AbortError. Shared so a cancellation never also reports a fault.
 */
export function isCaptureCancellation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'NotAllowedError' || err.name === 'AbortError';
}

/** Must run inside a user gesture in browsers (getDisplayMedia requires transient activation). */
export async function stageScreenCapture(): Promise<MediaStream> {
  const config = useVoiceStore.getState().screenShareConfig;
  const opts = buildScreenShareOptions(config);
  if (!isScreenCaptureSupported()) {
    throw new DOMException('getDisplayMedia is not available', 'NotSupportedError');
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(buildCaptureConstraints(config, opts));
    const video = stream.getVideoTracks()[0];
    if (video) video.contentHint = opts.contentHint;
    return stream;
  } catch (err) {
    // Loopback unsupported (Linux without pulse, macOS without Catap) makes
    // the whole getDisplayMedia call reject. No auto-retry: the picker
    // selection was consumed, retrying would re-prompt it.
    if (config.shareAudio && !isCaptureCancellation(err)) {
      useUIStore.getState().addToast(
        i18n.t('voice:screenPicker.audioCaptureFailed'),
        'warning',
        8000,
      );
    }
    throw err;
  }
}

export type CapturedSurfaceKind = 'monitor' | 'window' | 'browser';

/**
 * What the picker actually handed us. `MediaTrackSettings.displaySurface` is
 * the standard answer (Chromium, Safari); Firefox does not report it, so the
 * kind is unknown there and the preview is the ground truth.
 */
export function describeStagedCapture(stream: MediaStream): { kind: CapturedSurfaceKind | null; label: string | null } {
  const track = stream.getVideoTracks()[0];
  if (!track) return { kind: null, label: null };
  const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
  const kind: CapturedSurfaceKind | null =
    surface === 'monitor' || surface === 'window' || surface === 'browser' ? surface : null;
  // Chromium labels are raw ids ("screen:0:0", "window:1234:0", "web-contents-media-stream://…");
  // Firefox and Safari give a human name. Only surface the latter.
  const raw = track.label?.trim() ?? '';
  const label = raw && !/^(screen|window|web-contents|monitor)[:\-]/i.test(raw) && !/^[a-z-]+:\/\//i.test(raw) ? raw : null;
  return { kind, label };
}

/**
 * Re-apply the current config to a staged (unpublished) capture. Cheap: the
 * track is local only, so there is no SFU renegotiation. Lets the setup screen
 * reflect quality changes in the preview before anything is sent.
 */
export async function applyStagedCaptureConfig(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') return;
  const config = useVoiceStore.getState().screenShareConfig;
  const opts = buildScreenShareOptions(config);
  const constraints = buildCaptureConstraints(config, opts).video;
  try {
    if (typeof constraints === 'object') await track.applyConstraints(constraints);
  } catch (err) {
    console.warn('[ScreenShare] Failed to apply staged constraints:', err);
  }
  track.contentHint = opts.contentHint;
}

export function stopStagedCapture(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

// ---------------------------------------------------------------------------
// Publish — send a staged capture to the room as the local screen share
// ---------------------------------------------------------------------------

/** Codec of the currently published screen share; null when nothing is published. */
let _publishedScreenShareCodec: 'vp9' | 'h264' | null = null;

export function getPublishedScreenShareCodec(): 'vp9' | 'h264' | null {
  return _publishedScreenShareCodec;
}

/** True while republishScreenShare() swaps publications; unpublish handlers must not treat it as a stop. */
let _republishing = false;

export async function publishScreenShare(room: Room, stream: MediaStream): Promise<boolean> {
  const config = useVoiceStore.getState().screenShareConfig;
  const hwOverdrive = useVoiceStore.getState().hwOverdrive;
  const opts = buildScreenShareOptions(config);

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState !== 'live') return false;
  const audioTrack = stream.getAudioTracks().find((t) => t.readyState === 'live') ?? null;

  // SDP profile override must be in place before the publish negotiation
  if (hwOverdrive) activateHwOverdrive();
  else deactivateHwOverdrive();

  let videoPublished = false;
  try {
    videoTrack.contentHint = opts.contentHint;
    await room.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      videoCodec: opts.publish.videoCodec,
      videoEncoding: opts.publish.videoEncoding,
      // LiveKit uses screenShareEncoding (not videoEncoding) for screen share tracks.
      // Without this, the default ScreenSharePresets.h1080fps15 caps at 15fps.
      screenShareEncoding: opts.publish.videoEncoding,
      simulcast: opts.publish.simulcast,
      ...(opts.publish.backupCodec ? {
        backupCodec: opts.publish.backupCodec,
        backupCodecPolicy: opts.publish.backupCodecPolicy,
      } : {}),
    });
    videoPublished = true;
    if (audioTrack) {
      await room.localParticipant.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
    }

    _publishedScreenShareCodec = opts.publish.videoCodec;
    useVoiceStore.setState({ isScreenSharing: true });
    applyScreenShareOverdrive(room);
    if (hwOverdrive) scheduleEncoderDetection(room);
    return true;
  } catch (err) {
    console.error('[ScreenShare] Failed to publish screen share:', err);
    // A failure after the video went out (a rejected loopback track, a
    // negotiation error) would otherwise leave a publication whose track we
    // are about to stop: remote peers see a dead screen share, and no stop
    // path can clear it because they are all gated on isScreenSharing.
    if (videoPublished) {
      try {
        await room.localParticipant.unpublishTrack(videoTrack, false);
      } catch (unpublishErr) {
        console.error('[ScreenShare] Failed to roll back the video publication:', unpublishErr);
      }
    }
    if (hwOverdrive) deactivateHwOverdrive();
    stopStagedCapture(stream);
    return false;
  }
}

/**
 * Re-publish the live screen share with the current publish options. The
 * codec is baked into SDP negotiation, so a codec change needs a fresh
 * publication — but the MediaStreamTrack is reusable, so no re-capture and
 * no second picker prompt.
 */
export async function republishScreenShare(room: Room): Promise<void> {
  const videoPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const audioPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  const videoTrack = videoPub?.track?.mediaStreamTrack;
  if (!videoPub?.track || !videoTrack) return;
  const audioTrack = audioPub?.track?.mediaStreamTrack ?? null;
  const stream = new MediaStream([videoTrack, ...(audioTrack ? [audioTrack] : [])]);

  _republishing = true;
  try {
    await room.localParticipant.unpublishTrack(videoPub.track, false);
    if (audioPub?.track) await room.localParticipant.unpublishTrack(audioPub.track, false);
  } finally {
    _republishing = false;
  }
  _publishedScreenShareCodec = null;

  const ok = await publishScreenShare(room, stream);
  if (!ok) {
    deactivateHwOverdrive();
    useVoiceStore.setState({ isScreenSharing: false, hwOverdrive: false });
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
// Hardware encoder detection — checks WebRTC stats after stream starts
// ---------------------------------------------------------------------------

function scheduleEncoderDetection(room: Room): void {
  setTimeout(async () => {
    if (!useVoiceStore.getState().isScreenSharing) return;
    if (!useVoiceStore.getState().hwOverdrive) return;

    try {
      const pc = getPublisherPC(room);
      if (!pc) return;

      const screenPub = room.localParticipant.getTrackPublications()
        .find(p => p.source === Track.Source.ScreenShare);
      if (!screenPub?.track) return;

      const mediaTrack = getMediaStreamTrack(screenPub.track);
      if (!mediaTrack) return;

      const sender = pc.getSenders().find(s => s.track?.id === mediaTrack.id);
      if (!sender) return;

      const stats = await sender.getStats();
      let encoderImpl: string | null = null;
      stats.forEach((report: any) => {
        if (report.type === 'outbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
          encoderImpl = report.encoderImplementation ?? null;
        }
      });

      if (encoderImpl && /openh264/i.test(encoderImpl)) {
        useUIStore.getState().addToast(
          'Hardware encoder not available — using software fallback. Switch to VP9 for better performance.',
          'warning',
          8000,
        );
      }
    } catch {
      // Non-critical — silently ignore detection failures
    }
  }, 4000);
}

// ---------------------------------------------------------------------------
// Stop screen sharing
// ---------------------------------------------------------------------------

export async function stopScreenShare(room: Room): Promise<void> {
  try {
    for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
      const pub = room.localParticipant.getTrackPublication(source);
      if (pub?.track) await room.localParticipant.unpublishTrack(pub.track, true);
    }
  } catch (err) {
    console.error('[ScreenShare] Failed to stop screen share:', err);
  }
  deactivateHwOverdrive();
  _publishedScreenShareCodec = null;
  useVoiceStore.setState({ isScreenSharing: false, hwOverdrive: false });
  // `voice_status` is what carries isScreenSharing to people who are not in the
  // LiveKit room (channel lists, join sheets). Every stop path funnels through
  // here or through handleScreenShareUnpublished, so both must broadcast.
  broadcastVoiceStatus();
}

// ---------------------------------------------------------------------------
// Change screen share source — stop, then reopen the setup screen
// ---------------------------------------------------------------------------

export async function changeScreenShare(room: Room): Promise<void> {
  await stopScreenShare(room);
  openScreenShareSetup();
}

// ---------------------------------------------------------------------------
// OS-level "Stop sharing" handler
// ---------------------------------------------------------------------------

export function handleScreenShareUnpublished(): void {
  if (_republishing) return;
  deactivateHwOverdrive();
  _publishedScreenShareCodec = null;
  useVoiceStore.setState({ isScreenSharing: false, hwOverdrive: false });
  // `voice_status` is what carries isScreenSharing to people who are not in the
  // LiveKit room (channel lists, join sheets). Every stop path funnels through
  // here or through handleScreenShareUnpublished, so both must broadcast.
  broadcastVoiceStatus();
}
