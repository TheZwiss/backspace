import { Track, type Room, type VideoCaptureOptions } from 'livekit-client';
import type { InstanceStreamingLimits } from '@backspace/shared';
import { WIDTH_MAP, type StandardResolution } from '@backspace/shared/src/constants';
import { resolveCameraLimits } from '../stores/settingsStore';
import { useVoiceStore, type CameraConfig } from '../stores/voiceStore';
import { applyOverdrive, type OverdriveOptions } from './screenShare';
import { getStreamHostLimits } from './streamHostLimits';
import { markIntentionalCameraOff } from './cameraFlags';

export interface CameraBuildResult {
  capture: { width: number; height: number; frameRate: number };
  publish: {
    videoCodec: 'h264';
    videoEncoding: { maxBitrate: number; maxFramerate: number };
    simulcast: true;
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
    },
    overdrive: {
      maxBitrate: bitrateBps,
      maxFramerate: config.fps,
      degradationPreference: 'maintain-framerate',
    },
  };
}

async function republishCamera(room: Room, options: CameraBuildResult): Promise<void> {
  const deviceId = useVoiceStore.getState().cameraDeviceId;
  const capture: VideoCaptureOptions = {
    resolution: options.capture,
    frameRate: options.capture.frameRate,
  };
  if (deviceId) capture.deviceId = deviceId;

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
    await mediaTrack.applyConstraints({
      width: { ideal: options.capture.width },
      height: { ideal: options.capture.height },
      frameRate: { ideal: options.capture.frameRate },
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
