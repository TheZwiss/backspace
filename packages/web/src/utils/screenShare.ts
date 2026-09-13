import { Room, Track, BackupCodecPolicy, AudioPresets } from 'livekit-client';
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
    audioPreset: typeof AudioPresets.musicHighQualityStereo;
    dtx: false;
    red: false;
    forceStereo: true;
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
  // The persisted config is the only source of codec intent. The VP8 backup
  // remains simulcast: room dynacast pauses it when nobody needs it, while an
  // incompatible subscriber can receive VP8 without regressing every viewer.

  // Backup encoding: cap at 30fps and proportional bitrate to keep CPU overhead low
  const backupFps = Math.min(fps, 30);
  const backupBps = Math.round(bps * (backupFps / fps));

  return {
    capture: { width: captureWidth, height: captureHeight, frameRate: fps },
    publish: {
      videoCodec: config.codec,
      videoEncoding: { maxBitrate: bps, maxFramerate: fps },
      simulcast: false,
      backupCodec: {
        codec: 'vp8' as const,
        encoding: { maxBitrate: backupBps, maxFramerate: backupFps },
      },
      backupCodecPolicy: BackupCodecPolicy.SIMULCAST,
      audioPreset: AudioPresets.musicHighQualityStereo,
      dtx: false,
      red: false,
      forceStereo: true,
    },
    overdrive: {
      maxBitrate: bps,
      maxFramerate: fps,
      degradationPreference: mode === 'text' ? 'maintain-resolution' : 'balanced',
    },
    contentHint: mode === 'text' ? 'detail' : 'motion',
  };
}

// ---------------------------------------------------------------------------
// Shared helper: resolve native-mode overdrive from actual track dimensions
// Used by both scheduleScreenShareOverdrive (screenShare.ts) and updateActiveTracks (useLiveKit.ts)
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
  opts.publish.videoEncoding.maxBitrate = bps;
}

// ---------------------------------------------------------------------------
// Overdrive — forces bitrate/resolution/framerate on RTCRtpSender
// ---------------------------------------------------------------------------

export async function applyOverdrive(
  room: Room,
  source: Track.Source,
  options: OverdriveOptions,
): Promise<boolean> {
  try {
    const pub = room.localParticipant.getTrackPublications().find(p => p.source === source);
    if (!pub?.track) return false;

    const pc = getPublisherPC(room);
    if (!pc) return false;

    const pubMediaTrack = getMediaStreamTrack(pub.track);
    const senders = pc.getSenders();
    const sender = senders.find(s => s.track?.id === pubMediaTrack?.id);
    if (!sender) return false;

    const params = sender.getParameters();
    if (!params.encodings?.length) return false;
    // Before LiveKit finishes configuring the sender, Chromium can expose one
    // empty placeholder encoding. Any values written there are replaced by
    // LiveKit's sendEncodings, so report "not ready" and let the bounded
    // scheduler retry after negotiation advances.
    if (params.encodings.length === 1 && Object.keys(params.encodings[0]!).length === 0) {
      return false;
    }

    // Target the highest-quality layer. With simulcast, encodings[0] is the
    // lowest layer; our overdrive must hit the top layer so the custom bitrate
    // slider controls the full-resolution stream, not the quarter-res one.
    // For non-simulcast tracks (single encoding), length - 1 === 0.
    const idx = params.encodings.length - 1;
    params.encodings[idx]!.maxBitrate = options.maxBitrate;
    params.encodings[idx]!.maxFramerate = options.maxFramerate;
    params.encodings[idx]!.priority = 'high';
    params.encodings[idx]!.networkPriority = 'high';
    (params as any).degradationPreference = options.degradationPreference;

    await sender.setParameters(params);
    return true;
  } catch (err) {
    console.warn('[ScreenShare] Failed to apply overdrive:', err);
    return false;
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

/** Codec confirmed by outbound WebRTC stats; null until stats expose it. */
let _publishedScreenShareCodec: 'vp9' | 'h264' | 'vp8' | null = null;
/** Requested codec of the current publication, used only to decide whether republish is needed. */
let _requestedPublishedScreenShareCodec: 'vp9' | 'h264' | null = null;

export function getPublishedScreenShareCodec(): 'vp9' | 'h264' | 'vp8' | null {
  return _publishedScreenShareCodec;
}

export function getRequestedPublishedScreenShareCodec(): 'vp9' | 'h264' | null {
  return _requestedPublishedScreenShareCodec;
}

/** True while republishScreenShare() swaps publications; unpublish handlers must not treat it as a stop. */
let _republishing = false;

/** True while republishScreenShare() swaps publications. See handleScreenShareUnpublished. */
export function isScreenShareRepublishing(): boolean {
  return _republishing;
}

/**
 * True while stopScreenShare() is unpublishing. livekit-client emits
 * `LocalTrackUnpublished` synchronously inside `unpublishTrack`, so the
 * explicit stop path reaches handleScreenShareUnpublished mid-teardown; the
 * flag keeps that from broadcasting a second `voice_status` for the one stop.
 */
let _stopping = false;

export async function publishScreenShare(room: Room, stream: MediaStream): Promise<boolean> {
  const config = useVoiceStore.getState().screenShareConfig;
  const opts = buildScreenShareOptions(config);
  const needsH264SdpPatch = config.codec === 'h264';
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState !== 'live') return false;
  const audioTrack = stream.getAudioTracks().find((t) => t.readyState === 'live') ?? null;

  // SDP profile override must be in place before the publish negotiation
  if (needsH264SdpPatch) activateHwOverdrive();

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
      await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
        audioPreset: opts.publish.audioPreset,
        dtx: opts.publish.dtx,
        red: opts.publish.red,
        forceStereo: opts.publish.forceStereo,
      });
    }

    _requestedPublishedScreenShareCodec = opts.publish.videoCodec;
    _publishedScreenShareCodec = null;
    useVoiceStore.setState({ isScreenSharing: true });
    scheduleScreenShareOverdrive(room);
    scheduleEncoderDetection(room, config.codec, videoTrack.id);
    return true;
  } catch (err) {
    console.error('[ScreenShare] Failed to publish screen share:', err);
    // A failure after the video went out would otherwise leave a dead
    // publication after its underlying staged track is stopped.
    if (videoPublished) {
      try {
        await room.localParticipant.unpublishTrack(videoTrack, false);
      } catch (unpublishErr) {
        console.error('[ScreenShare] Failed to roll back the video publication:', unpublishErr);
      }
    }
    if (config.shareAudio && err instanceof Error && err.name !== 'NotAllowedError') {
      useUIStore.getState().addToast(
        i18n.t('voice:streamSettings.systemAudioStartFailed'),
        'warning',
        8000,
      );
    }
    stopStagedCapture(stream);
    return false;
  } finally {
    // The global SDP hook is negotiation-scoped. Leaving it installed would
    // affect camera/microphone renegotiations later in the call.
    if (needsH264SdpPatch) deactivateHwOverdrive();
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
  _requestedPublishedScreenShareCodec = null;

  const ok = await publishScreenShare(room, stream);
  if (!ok) {
    deactivateHwOverdrive();
    useVoiceStore.setState({ isScreenSharing: false });
    // The swap suppressed handleScreenShareUnpublished, and a video publish
    // that never landed emits no rollback unpublish either, so nothing else
    // will carry the stop to the clients outside the LiveKit room. Without
    // this their channel lists keep the sharing indicator up indefinitely
    // while the sharer's own UI says they stopped.
    broadcastVoiceStatus();
  }
}

// ---------------------------------------------------------------------------
// Shared screen-share sender scheduling
// ---------------------------------------------------------------------------

const OVERDRIVE_ATTEMPT_OFFSETS_MS = [0, 250, 750, 2000, 5000] as const;

/**
 * Apply the current screen-share capture settings once and sender parameters
 * as soon as a negotiated encoding is available. The final pass deliberately
 * remains at five seconds to reassert the ceiling after Chromium's bandwidth
 * estimate converges. Reconnect and track-restart paths use the same scheduler
 * because they can replace the sender and briefly expose placeholder encodings.
 */
export function scheduleScreenShareOverdrive(room: Room): void {
  const startedAt = Date.now();
  let attemptIndex = 0;
  let captureConfigured = false;

  const apply = async (): Promise<void> => {
    if (!useVoiceStore.getState().isScreenSharing) return;
    const freshOpts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);

    const screenPub = room.localParticipant.getTrackPublications()
      .find(p => p.source === Track.Source.ScreenShare);
    if (screenPub?.track?.mediaStreamTrack) {
      const mediaTrack = screenPub.track.mediaStreamTrack;
      if (!captureConfigured) {
        captureConfigured = true;
        try {
          if (freshOpts.capture.width > 0 && freshOpts.capture.height > 0) {
            // Standard mode: apply resolution + frameRate together
            await mediaTrack.applyConstraints({
              width: { ideal: freshOpts.capture.width },
              height: { ideal: freshOpts.capture.height },
              frameRate: { ideal: freshOpts.capture.frameRate, min: 15 },
            });
          } else {
            // Native mode: apply frameRate only — never pass 0 to width/height
            await mediaTrack.applyConstraints({
              frameRate: { ideal: freshOpts.capture.frameRate, min: 15 },
            });
          }
          mediaTrack.contentHint = freshOpts.contentHint;
        } catch (err) {
          // Capture constraints and sender parameters are independent. A browser
          // rejecting one constraint must not cancel the bounded sender retry.
          console.warn('[ScreenShare] Failed to apply capture constraints:', err);
        }
      }

      // Native dimensions can settle after negotiation/restart, so recompute
      // their ceiling on each bounded sender attempt without reapplying capture
      // constraints or restarting the source track.
      resolveNativeOverdrive(mediaTrack, useVoiceStore.getState().screenShareConfig, freshOpts);
    }
    const applied = await applyOverdrive(room, Track.Source.ScreenShare, freshOpts.overdrive);
    if (!useVoiceStore.getState().isScreenSharing) return;

    const lastIndex = OVERDRIVE_ATTEMPT_OFFSETS_MS.length - 1;
    if (attemptIndex >= lastIndex) return;

    // Once a real sender encoding accepts the values, skip intermediate
    // retries but keep the 5-second pass that reasserts the ceiling after
    // Chromium's screen-share bandwidth estimate has converged.
    attemptIndex = applied ? lastIndex : attemptIndex + 1;
    const targetOffset = OVERDRIVE_ATTEMPT_OFFSETS_MS[attemptIndex]!;
    const delay = Math.max(0, targetOffset - (Date.now() - startedAt));
    setTimeout(() => { void apply(); }, delay);
  };
  void apply();
}

// ---------------------------------------------------------------------------
// Negotiated codec and encoder detection — checks stats after stream starts
// ---------------------------------------------------------------------------

interface EncoderStatsEntry extends RTCStats {
  kind?: string;
  mediaType?: string;
  codecId?: string;
  mimeType?: string;
  bytesSent?: number;
  active?: boolean;
  encoderImplementation?: string;
}

function normalizeVideoCodec(value: string | undefined): 'vp9' | 'h264' | 'vp8' | null {
  const normalized = value?.toLowerCase();
  if (normalized?.includes('vp9')) return 'vp9';
  if (normalized?.includes('h264')) return 'h264';
  if (normalized?.includes('vp8')) return 'vp8';
  return null;
}

async function inspectPublishedEncoder(
  room: Room,
  requestedCodec: 'vp9' | 'h264',
  expectedTrackId: string,
): Promise<boolean> {
  if (!useVoiceStore.getState().isScreenSharing) return true;

  const pc = getPublisherPC(room);
  if (!pc) return false;
  const screenPub = room.localParticipant.getTrackPublications()
    .find(p => p.source === Track.Source.ScreenShare);
  if (!screenPub?.track) return false;
  const mediaTrack = getMediaStreamTrack(screenPub.track);
  if (!mediaTrack || mediaTrack.id !== expectedTrackId) return true;
  const sender = pc.getSenders().find(s => s.track?.id === expectedTrackId);
  if (!sender) return false;

  const stats = await sender.getStats();
  const codecById = new Map<string, string>();
  const outbound: Array<{ codec: 'vp9' | 'h264' | 'vp8'; bytesSent: number; encoderImpl: string | null }> = [];
  stats.forEach((report) => {
    const entry = report as EncoderStatsEntry;
    if (entry.type === 'codec' && entry.mimeType) codecById.set(entry.id, entry.mimeType);
  });
  stats.forEach((report) => {
    const entry = report as EncoderStatsEntry;
    if (entry.type !== 'outbound-rtp' || (entry.kind !== 'video' && entry.mediaType !== 'video')) return;
    if (entry.active === false) return;
    const codec = normalizeVideoCodec(entry.mimeType ?? (entry.codecId ? codecById.get(entry.codecId) : undefined));
    if (!codec) return;
    outbound.push({
      codec,
      bytesSent: entry.bytesSent ?? 0,
      encoderImpl: entry.encoderImplementation ?? null,
    });
  });
  if (outbound.length === 0) return false;

  const sending = outbound.filter((entry) => entry.bytesSent > 0);
  // SIMULCAST can expose the requested primary and VP8 backup together. Prefer
  // a confirmed, sending primary; only report the backup when the requested
  // codec is absent/inactive and VP8 is the stream actually carrying bytes.
  const selected = sending.find((entry) => entry.codec === requestedCodec)
    ?? (sending.length > 0
      ? sending.reduce((best, entry) => entry.bytesSent > best.bytesSent ? entry : best)
      : outbound.find((entry) => entry.codec === requestedCodec) ?? outbound[0]!);
  _publishedScreenShareCodec = selected.codec;

  const h264Implementations = outbound
    .filter((entry) => entry.codec === 'h264')
    .map((entry) => entry.encoderImpl)
    .filter((value): value is string => value != null);
  if (requestedCodec === 'h264' && h264Implementations.some((value) => /openh264/i.test(value))) {
    useUIStore.getState().addToast(
      i18n.t('voice:streamSettings.softwareH264Fallback'),
      'warning',
      8000,
    );
    return true;
  }

  // Chromium may expose the codec before encoderImplementation. Retry H264
  // briefly so the software-fallback signal is not lost to stats timing.
  return requestedCodec !== 'h264'
    || selected.codec !== 'h264'
    || h264Implementations.length > 0;
}

const ENCODER_DETECTION_OFFSETS_MS = [0, 1000, 4000, 8000] as const;

function scheduleEncoderDetection(
  room: Room,
  requestedCodec: 'vp9' | 'h264',
  expectedTrackId: string,
): void {
  const startedAt = Date.now();
  let attemptIndex = 0;
  const inspect = async (): Promise<void> => {
    try {
      if (await inspectPublishedEncoder(room, requestedCodec, expectedTrackId)) return;
    } catch {
      // Non-critical — the connection inspector still exposes available stats.
    }
    attemptIndex += 1;
    if (attemptIndex >= ENCODER_DETECTION_OFFSETS_MS.length) return;
    const targetOffset = ENCODER_DETECTION_OFFSETS_MS[attemptIndex]!;
    const delay = Math.max(0, targetOffset - (Date.now() - startedAt));
    setTimeout(() => { void inspect(); }, delay);
  };
  void inspect();
}

// ---------------------------------------------------------------------------
// Stop screen sharing
// ---------------------------------------------------------------------------

export async function stopScreenShare(room: Room): Promise<void> {
  _stopping = true;
  try {
    for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
      // Per publication, not per loop: a throw on the video track used to abort
      // the loop, leaving the screen-share audio published with nothing left in
      // the UI able to stop it — isScreenSharing is already false by then, so
      // every stop path is closed and remote peers keep hearing the desktop.
      try {
        const pub = room.localParticipant.getTrackPublication(source);
        if (pub?.track) await room.localParticipant.unpublishTrack(pub.track, true);
      } catch (err) {
        console.error(`[ScreenShare] Failed to unpublish ${source}:`, err);
      }
    }
  } finally {
    _stopping = false;
  }
  deactivateHwOverdrive();
  _publishedScreenShareCodec = null;
  _requestedPublishedScreenShareCodec = null;
  useVoiceStore.setState({ isScreenSharing: false });
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
  // The explicit stop path unpublishes synchronously, so this handler runs from
  // inside stopScreenShare(), which clears the same state and broadcasts once
  // its publications are gone. Returning here keeps a single stop to a single
  // `voice_status` fan-out instead of two.
  if (_stopping) return;
  deactivateHwOverdrive();
  _publishedScreenShareCodec = null;
  _requestedPublishedScreenShareCodec = null;
  useVoiceStore.setState({ isScreenSharing: false });
  // `voice_status` is what carries isScreenSharing to people who are not in the
  // LiveKit room (channel lists, join sheets). Every stop path funnels through
  // here or through handleScreenShareUnpublished, so both must broadcast.
  broadcastVoiceStatus();
}
