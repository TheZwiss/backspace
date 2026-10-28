import { describe, expect, it, vi } from 'vitest';
import { Track, type Room } from 'livekit-client';
import type { CameraStreamingLimits, InstanceStreamingLimits } from '@backspace/shared';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));
vi.mock('./screenShare', () => ({
  applyOverdrive: vi.fn(async () => true),
}));

import {
  buildCameraOptions,
  effectiveCameraConfig,
  requestCameraQuality,
  resolveCameraLimits,
  type CameraBuildResult,
} from './camera';
import { applyOverdrive } from './screenShare';

function limitsWith(camera: Partial<CameraStreamingLimits>): InstanceStreamingLimits {
  return {
    maxBitrateKbps: 20000,
    minBitrateKbps: 500,
    bitrateStepKbps: 500,
    allowedResolutions: [540, 720, 1080],
    allowedFramerates: [30, 45, 60],
    maxResolution: 1080,
    maxFramerate: 60,
    discoveryEnabled: true,
    directoryEnabled: false,
    directoryConfigured: false,
    bitrateMatrixOverrides: null,
    allowCustomBitrate: true,
    camera: {
      mode: 'user-choice',
      defaultResolution: 720,
      defaultFramerate: 30,
      defaultBitrateKbps: 2000,
      allowedResolutions: [540, 720, 1080],
      allowedFramerates: [30, 60],
      minBitrateKbps: 300,
      maxBitrateKbps: 4000,
      allowCustomBitrate: true,
      ...camera,
    },
  };
}

describe('resolveCameraLimits', () => {
  it('falls back to the fixed default when an older host omits the field', () => {
    const legacy: InstanceStreamingLimits = { ...limitsWith({}) };
    delete legacy.camera;
    expect(resolveCameraLimits(legacy).mode).toBe('fixed');
  });
});

describe('effectiveCameraConfig', () => {
  it('ignores the saved choice in fixed mode', () => {
    const config = effectiveCameraConfig(
      { height: 1080, fps: 60, customBitrateKbps: 3500 },
      limitsWith({ mode: 'fixed', defaultResolution: 540, defaultFramerate: 30 }),
    );
    expect(config).toEqual({ height: 540, fps: 30, customBitrateKbps: null });
  });

  it('snaps resolution and frame rate to the allowed values', () => {
    const config = effectiveCameraConfig(
      { height: 900, fps: 45, customBitrateKbps: null },
      limitsWith({ allowedResolutions: [540, 720], allowedFramerates: [30, 60] }),
    );
    expect(config.height).toBe(720);
    expect(config.fps).toBe(30);
  });

  it('clamps a custom bitrate and drops it when the host forbids custom', () => {
    const clamped = effectiveCameraConfig(
      { height: 720, fps: 30, customBitrateKbps: 9000 },
      limitsWith({ maxBitrateKbps: 4000 }),
    );
    expect(clamped.customBitrateKbps).toBe(4000);

    const dropped = effectiveCameraConfig(
      { height: 720, fps: 30, customBitrateKbps: 9000 },
      limitsWith({ allowCustomBitrate: false }),
    );
    expect(dropped.customBitrateKbps).toBeNull();
  });
});

describe('buildCameraOptions', () => {
  it('converts kbps to bps and derives the 16:9 width', () => {
    const options: CameraBuildResult = buildCameraOptions(
      limitsWith({ defaultBitrateKbps: 2500 }),
      { height: 1080, fps: 60, customBitrateKbps: null },
    );
    expect(options.capture).toEqual({ width: 1920, height: 1080, frameRate: 60 });
    expect(options.publish.videoEncoding).toEqual({ maxBitrate: 2_500_000, maxFramerate: 60 });
    expect(options.overdrive.maxBitrate).toBe(2_500_000);
    expect(options.publish.videoCodec).toBe('h264');
  });

  it('uses a custom bitrate when the host allows it', () => {
    const options = buildCameraOptions(
      limitsWith({}),
      { height: 720, fps: 30, customBitrateKbps: 1200 },
    );
    expect(options.publish.videoEncoding.maxBitrate).toBe(1_200_000);
  });
});

describe('requestCameraQuality', () => {
  it('applies capture constraints and sender parameters to the live camera', async () => {
    vi.useFakeTimers();
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const room = {
      localParticipant: {
        getTrackPublications: () => [{
          source: Track.Source.Camera,
          track: { mediaStreamTrack: { applyConstraints } },
        }],
      },
    } as unknown as Room;

    await requestCameraQuality(room);

    expect(applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
    expect(applyOverdrive).toHaveBeenCalledWith(
      room,
      Track.Source.Camera,
      expect.objectContaining({ maxBitrate: 2_000_000, maxFramerate: 30 }),
    );
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
