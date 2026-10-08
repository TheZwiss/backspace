import { Room, Track, BackupCodecPolicy, AudioPresets, ConnectionState } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import type { ScreenShareConfig, ScreenShareAudioState } from '../stores/voiceStore';
import { getStreamHostLimits } from './streamHostLimits';
import { getPublisherPC, getMediaStreamTrack } from './livekitInternals';
import { broadcastVoiceStatus } from './voice';
import { encodeShareSignal, type ShareSignal } from './streamWatchProtocol';
import { activate as activateHwOverdrive, deactivate as deactivateHwOverdrive } from './hwOverdrive';
import { useUIStore } from '../stores/uiStore';
import { openScreenShareSetup } from '../stores/screenShareSetupStore';
import i18n from '../i18n';
import { isElectron, getElectronAPI } from '../platform/platform';
import type { InstanceStreamingLimits } from '@backspace/shared';
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

// ---------------------------------------------------------------------------
// Effective config — the saved choice fitted to the host's limits at use time
// ---------------------------------------------------------------------------

function nearest(values: readonly number[], target: number): number {
  return values.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

/**
 * The saved config as the stream on this host will use it. Pure, and never
 * written back: the saved choice is the user's, and a strict host (or a
 * stricter home policy) must not overwrite it for every later stream. Only an
 * explicit click in the quality controls saves.
 *
 * - height: nearest allowed numeric height; a disallowed `'native'` becomes the
 *   highest allowed one; with only `'native'` allowed, `'native'`.
 * - fps: nearest allowed frame rate.
 * - customBitrateKbps: null where the host allows no custom bitrate, else
 *   clamped to the host's range.
 * An empty allowlist leaves its value alone. Returns `config` itself when
 * nothing changes, so callers can compare by reference.
 */
export function effectiveScreenShareConfig(
  config: ScreenShareConfig,
  limits: InstanceStreamingLimits,
): ScreenShareConfig {
  let { height, fps, customBitrateKbps } = config;
  if (limits.allowedResolutions.length > 0 && !limits.allowedResolutions.includes(height)) {
    const numeric = limits.allowedResolutions.filter((r): r is number => r !== 'native');
    if (numeric.length === 0) height = 'native';
    else height = height === 'native' ? Math.max(...numeric) : nearest(numeric, height);
  }
  if (limits.allowedFramerates.length > 0 && !limits.allowedFramerates.includes(fps)) {
    fps = nearest(limits.allowedFramerates, fps);
  }
  if (customBitrateKbps != null) {
    customBitrateKbps = limits.allowCustomBitrate
      ? Math.min(Math.max(customBitrateKbps, limits.minBitrateKbps), limits.maxBitrateKbps)
      : null;
  }
  if (height === config.height && fps === config.fps && customBitrateKbps === config.customBitrateKbps) return config;
  return { ...config, height, fps, customBitrateKbps };
}

export function buildScreenShareOptions(savedConfig: ScreenShareConfig): ScreenShareBuildResult {
  const limits = getStreamHostLimits();
  const config = effectiveScreenShareConfig(savedConfig, limits);
  const { height, fps, mode, customBitrateKbps } = config;
  const isNative = height === 'native';
  const overrides = limits.bitrateMatrixOverrides;

  // Capture dimensions: sentinel 0 for native (caller skips resolution constraint)
  const captureWidth = isNative ? 0 : WIDTH_MAP[height as StandardResolution] ?? 1920;
  const captureHeight = isNative ? 0 : (height as number);

  // Resolve bitrate in kbps: custom (already dropped if not allowed) > override > default > native estimate
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
  savedConfig: ScreenShareConfig,
  opts: ScreenShareBuildResult,
): void {
  const limits = getStreamHostLimits();
  const config = effectiveScreenShareConfig(savedConfig, limits);
  if (config.height !== 'native' || config.customBitrateKbps != null || !mediaTrack) return;
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

/**
 * The room whose full reconnect withdrew the live share's publication. A
 * full reconnect republishes every local track while the room is
 * Reconnecting (the SDK's order is in docs/systems/voice.md, "A share, not a
 * publication"), so an unpublish then is not a stop; whether the share came
 * back is settled at Connected or Disconnected by
 * `settleScreenShareAfterReconnect`.
 */
let _reconnectingRoom: Room | null = null;

function isReconnecting(room: Room): boolean {
  return room.state === ConnectionState.Reconnecting;
}

/**
 * True while stopScreenShare() is unpublishing. livekit-client emits
 * `LocalTrackUnpublished` synchronously inside `unpublishTrack`, so the
 * explicit stop path reaches handleScreenShareUnpublished mid-teardown; the
 * flag keeps that from broadcasting a second `voice_status` for the one stop.
 */
let _stopping = false;

export interface PublishScreenShareOptions {
  /**
   * The desktop source id the capture was taken from, when the app listed it
   * (ScreenShareSetup's `selectedId`). Lets System Audio be added to the
   * running share later without a prompt. Null for browser and portal captures.
   */
  sourceId?: string | null;
  /** Who picked the source (`getScreenSharePickerMode`); only `'app'` can be preselected again. */
  pickerMode?: ScreenSharePickerMode | null;
}

export async function publishScreenShare(
  room: Room,
  stream: MediaStream,
  options: PublishScreenShareOptions = {},
): Promise<boolean> {
  const config = useVoiceStore.getState().screenShareConfig;
  const opts = buildScreenShareOptions(config);
  const needsH264SdpPatch = config.codec === 'h264';
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack || videoTrack.readyState !== 'live') return false;
  const capturedAudio = stream.getAudioTracks().find((t) => t.readyState === 'live') ?? null;
  // The toggle as it stands now, not as it stood at capture: audio captured
  // before the user turned System Audio off is not sent.
  const audioToPublish = config.shareAudio ? capturedAudio : null;
  const source: LiveSource | null = options.sourceId
    ? { id: options.sourceId, pickerMode: options.pickerMode ?? null }
    : null;

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
    if (audioToPublish) await publishScreenShareAudioTrack(room, audioToPublish);

    _requestedPublishedScreenShareCodec = opts.publish.videoCodec;
    _publishedScreenShareCodec = null;
    _liveSource = source;
    // A published share is settled: nothing is left to wait for.
    _reconnectingRoom = null;
    if (capturedAudio && !audioToPublish) setAsideScreenShareAudio(capturedAudio);
    useVoiceStore.setState({
      isScreenSharing: true,
      screenShareAudio: audioToPublish ? 'published' : idleScreenShareAudioState(),
    });
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
    if (audioToPublish && err instanceof Error && err.name !== 'NotAllowedError') {
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

  // Tell viewers first, so they read the unpublish below as this swap and pick
  // up the next publication, rather than as the share ending. Sent before the
  // unpublish because that is the order viewers must see; if it cannot be sent
  // the swap still goes ahead and viewers see the share end, as before.
  try {
    await room.localParticipant.publishData(encodeShareSignal('stream_republish'), { reliable: true });
  } catch (err) {
    console.warn('[ScreenShare] Could not announce the republish to viewers:', err);
  }

  _republishing = true;
  try {
    await room.localParticipant.unpublishTrack(videoPub.track, false);
    if (audioPub?.track) await room.localParticipant.unpublishTrack(audioPub.track, false);
  } finally {
    _republishing = false;
  }
  _publishedScreenShareCodec = null;
  _requestedPublishedScreenShareCodec = null;

  const ok = await publishScreenShare(room, stream, {
    sourceId: _liveSource?.id ?? null,
    pickerMode: _liveSource?.pickerMode ?? null,
  });
  if (!ok) {
    deactivateHwOverdrive();
    endScreenShareAudio(room);
    useVoiceStore.setState({ isScreenSharing: false });
    announceShare(room, 'stream_stop');
    // The swap suppressed handleScreenShareUnpublished, and a video publish
    // that never landed emits no rollback unpublish either, so nothing else
    // will carry the stop to the clients outside the LiveKit room. Without
    // this their channel lists keep the sharing indicator up indefinitely
    // while the sharer's own UI says they stopped.
    broadcastVoiceStatus();
  }
}

// ---------------------------------------------------------------------------
// Live system audio — the System Audio toggle while a share is running
//
// The toggle used to be read only when the capture was taken, so changing it
// mid-stream did nothing. `syncScreenShareAudio` makes the publication follow
// it, driven by the screenShareConfig effect in useLiveKit, without touching
// the video publication:
//
//   off: the ScreenShareAudio publication is withdrawn. On the desktop app,
//        which can capture loopback audio again without a prompt, the track is
//        stopped, so nothing stays captured. Where it cannot (browsers, portal
//        and prompted pickers) the track is set aside: still captured, sent
//        nowhere, so turning it back on does not need a new capture.
//   on:  a set-aside track is published again. With none, the desktop app
//        takes a second capture of the same source for its loopback audio
//        alone (preselected, so no picker) and drops that capture's video.
//        Elsewhere the state is `unavailable` and the switch says so.
//
// The audio's lifetime is the share's: every end of a share, including the
// video ending by itself, unpublishes and stops every screen-share audio track
// (`endScreenShareAudio`).
// ---------------------------------------------------------------------------

type ScreenSharePickerMode = 'app' | 'system';

interface LiveSource {
  id: string;
  pickerMode: ScreenSharePickerMode | null;
}

/** Desktop source of the live share, when the app listed it. */
let _liveSource: LiveSource | null = null;
/** Audio captured for the live share, withdrawn by the toggle, kept only where it cannot be captured again. */
let _heldAudio: MediaStreamTrack | null = null;
/** Bumped when a share ends, so a capture that lands afterwards is dropped. */
let _audioGeneration = 0;

/** A loopback capture that has not answered by then is given up on. */
export const SCREEN_SHARE_AUDIO_CAPTURE_TIMEOUT_MS = 10_000;

function liveOrNull(track: MediaStreamTrack | null): MediaStreamTrack | null {
  return track && track.readyState === 'live' ? track : null;
}

/**
 * Whether loopback audio can be added later, without a prompt, to a share of
 * this source: only the desktop app can, only for a source it listed itself
 * (picker mode `'app'`; a portal or an unknown mode would prompt again), and
 * only on a build that can preselect. The setup screen asks the same question
 * before Start.
 */
export function canAddScreenShareAudioLater(
  sourceId: string | null,
  pickerMode: ScreenSharePickerMode | null,
): boolean {
  return sourceId !== null
    && pickerMode === 'app'
    && isElectron()
    && isScreenCaptureSupported()
    && typeof getElectronAPI()?.preselectScreenSource === 'function';
}

/** The live share's source, when audio can be added to it. */
function acquirableSourceId(): string | null {
  if (!_liveSource) return null;
  return canAddScreenShareAudioLater(_liveSource.id, _liveSource.pickerMode) ? _liveSource.id : null;
}

/** The state of a share whose audio is not on the publication. */
function idleScreenShareAudioState(): ScreenShareAudioState {
  if (liveOrNull(_heldAudio)) return 'held';
  return acquirableSourceId() !== null ? 'acquirable' : 'unavailable';
}

/**
 * Audio the toggle withdrew: stopped where it can be captured again silently,
 * kept (captured, sent nowhere) only where it cannot.
 */
function setAsideScreenShareAudio(track: MediaStreamTrack): void {
  if (acquirableSourceId() !== null) {
    track.stop();
    return;
  }
  if (_heldAudio && _heldAudio !== track) _heldAudio.stop();
  _heldAudio = track;
}

function setScreenShareAudioState(state: ScreenShareAudioState): void {
  useVoiceStore.setState({ screenShareAudio: state });
}

/**
 * End of a share: unpublish and stop the screen-share audio, whatever
 * captured it, stop what was set aside, and forget the source. The state is
 * cleared first so the unpublish this causes reads as part of the stop.
 */
function endScreenShareAudio(room: Room): void {
  _audioGeneration++;
  _heldAudio?.stop();
  _heldAudio = null;
  _liveSource = null;
  useVoiceStore.setState({ screenShareAudio: null });
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
  if (!pub?.track) return;
  // Stopped here as well as by the unpublish, so the audio ends even if the
  // unpublish fails.
  pub.track.mediaStreamTrack?.stop();
  room.localParticipant.unpublishTrack(pub.track, true).catch((err: unknown) => {
    console.error('[ScreenShare] Failed to unpublish the screen-share audio:', err);
  });
}

async function publishScreenShareAudioTrack(room: Room, track: MediaStreamTrack): Promise<void> {
  const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
  await room.localParticipant.publishTrack(track, {
    source: Track.Source.ScreenShareAudio,
    audioPreset: opts.publish.audioPreset,
    dtx: opts.publish.dtx,
    red: opts.publish.red,
    forceStereo: opts.publish.forceStereo,
  });
}

/**
 * Resolve with `promise` if it settles within `ms`, else reject with a
 * TimeoutError; a result that arrives after that is handed to `discard`.
 */
function settleWithin<T>(promise: Promise<T>, ms: number, discard: (late: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new DOMException('The capture did not answer in time', 'TimeoutError'));
    }, ms);
    promise.then(
      (value) => {
        if (settled) { discard(value); return; }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Take loopback audio for the running share: preselect the same source with
 * audio, capture it again, and keep only the audio track. The main process
 * answers a preselected request without a picker.
 */
async function acquireScreenShareAudio(sourceId: string): Promise<MediaStreamTrack> {
  const api = getElectronAPI();
  if (!api?.preselectScreenSource) throw new DOMException('Source preselection is not available', 'NotSupportedError');
  await api.preselectScreenSource(sourceId, true);
  const config = useVoiceStore.getState().screenShareConfig;
  const stream = await navigator.mediaDevices.getDisplayMedia(
    buildCaptureConstraints({ ...config, shareAudio: true }, buildScreenShareOptions(config)),
  );
  stream.getVideoTracks().forEach((t) => t.stop());
  const audio = stream.getAudioTracks().find((t) => t.readyState === 'live');
  if (!audio) {
    stopStagedCapture(stream);
    throw new DOMException('The capture returned no audio track', 'NotFoundError');
  }
  return audio;
}

/** Adding audio failed: the toggle goes back to what is actually sent, and says why. */
function failScreenShareAudio(err: unknown): void {
  console.warn('[ScreenShare] Could not add system audio to the live share:', err);
  useVoiceStore.getState().setScreenShareConfig({ shareAudio: false });
  setScreenShareAudioState(idleScreenShareAudioState());
  useUIStore.getState().addToast(i18n.t('voice:streamSettings.systemAudioAddFailed'), 'warning', 8000);
}

/**
 * Make the live share's audio publication match the System Audio toggle.
 * Idempotent; callers serialize it with the other live-config updates.
 */
export async function syncScreenShareAudio(room: Room): Promise<void> {
  if (!useVoiceStore.getState().isScreenSharing) return;
  const wanted = useVoiceStore.getState().screenShareConfig.shareAudio;
  const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);

  if (pub?.track) {
    if (wanted) {
      setScreenShareAudioState('published');
      return;
    }
    const mediaTrack = pub.track.mediaStreamTrack;
    const canCaptureAgain = acquirableSourceId() !== null;
    await room.localParticipant.unpublishTrack(pub.track, canCaptureAgain);
    const kept = canCaptureAgain ? null : liveOrNull(mediaTrack);
    if (kept) setAsideScreenShareAudio(kept);
    setScreenShareAudioState(idleScreenShareAudioState());
    return;
  }

  if (!wanted) {
    setScreenShareAudioState(idleScreenShareAudioState());
    return;
  }

  const held = liveOrNull(_heldAudio);
  if (held) {
    _heldAudio = null;
    try {
      await publishScreenShareAudioTrack(room, held);
      setScreenShareAudioState('published');
    } catch (err) {
      setAsideScreenShareAudio(held);
      failScreenShareAudio(err);
    }
    return;
  }

  const sourceId = acquirableSourceId();
  if (sourceId === null) {
    setScreenShareAudioState('unavailable');
    return;
  }

  const generation = _audioGeneration;
  setScreenShareAudioState('acquiring');
  let track: MediaStreamTrack;
  try {
    // Bounded: this runs on the queue every live-settings change waits on.
    track = await settleWithin(
      acquireScreenShareAudio(sourceId),
      SCREEN_SHARE_AUDIO_CAPTURE_TIMEOUT_MS,
      (late) => late.stop(),
    );
  } catch (err) {
    if (generation === _audioGeneration) failScreenShareAudio(err);
    return;
  }
  // The share ended while the capture was taken: nothing may keep it.
  if (generation !== _audioGeneration || !useVoiceStore.getState().isScreenSharing) {
    track.stop();
    return;
  }
  // Turned off again meanwhile: not sent, and on the desktop app not kept.
  if (!useVoiceStore.getState().screenShareConfig.shareAudio) {
    setAsideScreenShareAudio(track);
    setScreenShareAudioState(idleScreenShareAudioState());
    return;
  }
  try {
    await publishScreenShareAudioTrack(room, track);
    setScreenShareAudioState('published');
  } catch (err) {
    track.stop();
    failScreenShareAudio(err);
  }
}

/**
 * `LocalTrackUnpublished` for ScreenShareAudio. The paths in this module set
 * the state themselves; this catches the ones that do not go through them,
 * such as livekit-client unpublishing an audio track whose source ended, so
 * the switch never reads on while nothing is sent.
 */
export function handleScreenShareAudioUnpublished(room: Room): void {
  if (_republishing || _stopping) return;
  const { isScreenSharing, screenShareAudio } = useVoiceStore.getState();
  if (!isScreenSharing || screenShareAudio !== 'published') return;
  if (isReconnecting(room)) {
    // Part of a full reconnect's republish: settled once the room is back.
    _reconnectingRoom = room;
    return;
  }
  setScreenShareAudioState(idleScreenShareAudioState());
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
  // Sent first and not awaited: a stop must not wait on the data channel.
  // Viewers handle the message on either side of the removal.
  announceShare(room, 'stream_stop');
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
  endScreenShareAudio(room);
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

/**
 * The video publication went away without stopScreenShare: the OS or browser
 * stop bar, or the source itself ending (the shared window closed, a display
 * unplugged), after which livekit-client unpublishes the ended track. Takes the
 * room so the screen-share audio ends with it: audio added mid-stream comes
 * from a second capture that does not end with the video.
 *
 * Returns whether the share is over. False for a republish of the same share,
 * our codec swap or a full reconnect's; the caller keeps its per-share state.
 */
export function handleScreenShareUnpublished(room: Room): boolean {
  // A codec swap: the same share, published again by republishScreenShare.
  if (_republishing) return false;
  // The explicit stop path unpublishes synchronously, so this handler runs from
  // inside stopScreenShare(), which clears the same state and broadcasts once
  // its publications are gone. Returning here keeps a single stop to a single
  // `voice_status` fan-out instead of two.
  if (_stopping) return true;
  // A full reconnect republishing every track (see _reconnectingRoom).
  if (isReconnecting(room) && useVoiceStore.getState().isScreenSharing) {
    _reconnectingRoom = room;
    return false;
  }
  endLocalShare(room);
  return true;
}

/**
 * The room came back from a full reconnect (Connected) or gave up
 * (Disconnected). A share whose publication was withdrawn by the reconnect
 * goes on only if the reconnect published it again; otherwise it ends here,
 * with the broadcast every other end of a share makes. Audio that did not
 * come back turns the switch off. A no-op for any other room or when no
 * reconnect touched the share.
 */
export function settleScreenShareAfterReconnect(room: Room): void {
  if (_reconnectingRoom !== room) return;
  _reconnectingRoom = null;
  if (!useVoiceStore.getState().isScreenSharing) return;
  if (!room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track) {
    endLocalShare(room);
    return;
  }
  const audioBack = !!room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
  if (useVoiceStore.getState().screenShareAudio === 'published' && !audioBack) {
    setScreenShareAudioState(idleScreenShareAudioState());
  }
  // The reconnect replaced this participant for everyone else, so viewers
  // saw the share end. Those who were watching it watch again.
  if (room.state === ConnectionState.Connected) announceShare(room, 'stream_resume');
}

/**
 * Tell the room's viewers about this share (`ShareSignal`). Fire and forget:
 * a viewer that misses it forgets the share when its window runs out, and a
 * room that is gone has nobody to tell.
 */
function announceShare(room: Room, signal: ShareSignal): void {
  if (room.state === ConnectionState.Disconnected) return;
  const warn = (err: unknown) => console.warn('[ScreenShare] Could not send %s to viewers:', signal, err);
  try {
    room.localParticipant.publishData(encodeShareSignal(signal), { reliable: true }).catch(warn);
  } catch (err) {
    warn(err);
  }
}

/** The share is over without stopScreenShare: the OS stop bar, a source that ended, a reconnect that lost it. */
function endLocalShare(room: Room): void {
  _reconnectingRoom = null;
  announceShare(room, 'stream_stop');
  deactivateHwOverdrive();
  endScreenShareAudio(room);
  _publishedScreenShareCodec = null;
  _requestedPublishedScreenShareCodec = null;
  useVoiceStore.setState({ isScreenSharing: false });
  // `voice_status` is what carries isScreenSharing to people who are not in the
  // LiveKit room (channel lists, join sheets). Every stop path funnels through
  // here or through handleScreenShareUnpublished, so both must broadcast.
  broadcastVoiceStatus();
}
