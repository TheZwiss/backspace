import { Track, VideoPresets, type Room, type VideoCaptureOptions } from 'livekit-client';
import type { InstanceStreamingLimits } from '@backspace/shared';
import { WIDTH_MAP, type StandardResolution } from '@backspace/shared/src/constants';
import { resolveCameraLimits } from '../stores/settingsStore';
import { useVoiceStore, type CameraConfig } from '../stores/voiceStore';
import { applyOverdrive, type OverdriveOptions } from './screenShare';
import { getStreamHostLimits } from './streamHostLimits';
import { markIntentionalCameraOff } from './cameraFlags';
import { getCachedCameraModes, pickCameraCapture, resolveCameraModes, type CameraCapture } from './cameraModes';

export interface CameraBuildResult {
  capture: { width: number; height: number; frameRate: number };
  publish: {
    videoCodec: 'h264';
    videoEncoding: { maxBitrate: number; maxFramerate: number };
    /**
     * Two encodings: the chosen quality and one 360p layer for tiles that are
     * out of focus. LiveKit's default adds a third (720p) layer, which is what
     * showed up as three simultaneous sources; `dynacast` pauses whichever
     * layer nobody is watching.
     */
    simulcast: true;
    videoSimulcastLayers: [typeof VideoPresets.h360];
    /** No second-codec copy of the camera either (LiveKit adds a VP8 one by default). */
    backupCodec: false;
  };
  overdrive: OverdriveOptions;
}

export { resolveCameraLimits };

function nearest(values: readonly number[], target: number): number {
  return values.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

/**
 * The saved choice fitted to the host's limits, without writing it back. In
 * `fixed` mode the admin's default is the whole policy and the saved choice is
 * ignored, which is what keeps the pre-policy behaviour available.
 */
export function effectiveCameraConfig(
  saved: CameraConfig,
  limits: InstanceStreamingLimits | null | undefined,
): CameraConfig {
  const camera = resolveCameraLimits(limits);
  if (camera.mode === 'fixed') {
    return {
      height: camera.defaultResolution,
      fps: camera.defaultFramerate,
      customBitrateKbps: null,
    };
  }

  let { height, fps, customBitrateKbps } = saved;
  if (camera.allowedResolutions.length > 0 && !camera.allowedResolutions.includes(height)) {
    height = nearest(camera.allowedResolutions, height);
  }
  if (camera.allowedFramerates.length > 0 && !camera.allowedFramerates.includes(fps)) {
    fps = nearest(camera.allowedFramerates, fps);
  }
  if (customBitrateKbps != null) {
    customBitrateKbps = camera.allowCustomBitrate
      ? Math.min(Math.max(customBitrateKbps, camera.minBitrateKbps), camera.maxBitrateKbps)
      : null;
  }
  return { height, fps, customBitrateKbps };
}

export function buildCameraOptions(
  limits: InstanceStreamingLimits = getStreamHostLimits(),
  saved: CameraConfig = useVoiceStore.getState().cameraConfig,
): CameraBuildResult {
  const camera = resolveCameraLimits(limits);
  const config = effectiveCameraConfig(saved, limits);
  const width = WIDTH_MAP[config.height as StandardResolution] ?? 1280;
  const bitrateBps = (config.customBitrateKbps ?? camera.defaultBitrateKbps) * 1000;

  return {
    capture: { width, height: config.height, frameRate: config.fps },
    publish: {
      videoCodec: 'h264',
      videoEncoding: { maxBitrate: bitrateBps, maxFramerate: config.fps },
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h360],
      backupCodec: false,
    },
    overdrive: {
      maxBitrate: bitrateBps,
      maxFramerate: config.fps,
      degradationPreference: 'maintain-framerate',
      // Below the screen share's 'high': a short uplink starves the webcam
      // before the screen share.
      priority: 'low',
    },
  };
}

/** Camera frames are 16:9; asked as an `ideal` it steers a camera without the exact size away from 4:3. */
const CAMERA_ASPECT = 16 / 9;

/**
 * The capture options for the camera, with the wanted size fitted to a 16:9
 * mode the device was measured to deliver. Without that fit the browser treats
 * the size as a preference and settles on the nearest mode it has, which on
 * many webcams is 4:3.
 *
 * `measure: false` never measures: it fits only to modes already known and
 * otherwise asks for the wanted size with an `ideal` 16:9 aspect ratio. Starting
 * the camera uses it, because measuring a camera that has never been seen takes
 * seconds (every size is applied in turn) and the person is waiting on the
 * click. The measurement still happens, off the click path, in the settings
 * preview and on a live quality change.
 */
export async function buildCameraCaptureOptions(
  options: CameraBuildResult,
  deviceId: string | null,
  { measure = true }: { measure?: boolean } = {},
): Promise<{ capture: VideoCaptureOptions; fitted: CameraCapture }> {
  const modes = measure ? await resolveCameraModes(deviceId) : (getCachedCameraModes(deviceId) ?? []);
  const fitted = pickCameraCapture(modes, options.capture.height, options.capture.frameRate) ?? options.capture;
  const capture: VideoCaptureOptions = { resolution: { ...fitted, aspectRatio: CAMERA_ASPECT }, frameRate: fitted.frameRate };
  if (deviceId) capture.deviceId = deviceId;
  return { capture, fitted };
}

async function republishCamera(room: Room, options: CameraBuildResult): Promise<void> {
  const { capture } = await buildCameraCaptureOptions(options, useVoiceStore.getState().cameraDeviceId);

  markIntentionalCameraOff();
  await room.localParticipant.setCameraEnabled(false);
  await room.localParticipant.setCameraEnabled(true, capture, options.publish);
}

let cameraQualityGeneration = 0;
let cameraQualityQueue: Promise<void> = Promise.resolve();

async function applyCameraQuality(room: Room): Promise<void> {
  const generation = ++cameraQualityGeneration;
  const options = buildCameraOptions(getStreamHostLimits());

  const publication = room.localParticipant
    .getTrackPublications()
    .find((p) => p.source === Track.Source.Camera);
  const mediaTrack = publication?.track?.mediaStreamTrack;
  if (!publication?.track || !mediaTrack) return;

  try {
    const { fitted } = await buildCameraCaptureOptions(options, useVoiceStore.getState().cameraDeviceId);
    await mediaTrack.applyConstraints({
      width: { ideal: fitted.width },
      height: { ideal: fitted.height },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: fitted.frameRate },
    });
  } catch (err) {
    console.warn('[Camera] applyConstraints failed; republishing the camera', err);
    if (generation === cameraQualityGeneration) await republishCamera(room, options);
    return;
  }

  if (generation !== cameraQualityGeneration) return;
  await applyOverdrive(room, Track.Source.Camera, options.overdrive);

  window.setTimeout(() => {
    if (generation !== cameraQualityGeneration) return;
    void applyOverdrive(room, Track.Source.Camera, options.overdrive);
  }, 5000);
}

/**
 * Apply the effective camera quality to a live publication. Calls are queued
 * so rapid control changes cannot interleave their constraints and sender
 * parameters; the newest call owns the 5 s re-assert.
 */
export function requestCameraQuality(room: Room): Promise<void> {
  const run = cameraQualityQueue.then(() => applyCameraQuality(room));
  cameraQualityQueue = run.catch(() => {});
  return run;
}
