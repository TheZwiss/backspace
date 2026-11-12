import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: vi.fn().mockReturnValue({}) } }));
vi.mock('./screenShare', () => ({ applyOverdrive: vi.fn(async () => true) }));

const { resolveCameraModes, getCachedCameraModes } = vi.hoisted(() => ({
  resolveCameraModes: vi.fn(),
  getCachedCameraModes: vi.fn(),
}));
vi.mock('./cameraModes', async () => {
  const actual = await vi.importActual<typeof import('./cameraModes')>('./cameraModes');
  return { ...actual, resolveCameraModes, getCachedCameraModes };
});

import { buildCameraCaptureOptions, type CameraBuildResult } from './camera';

const options: CameraBuildResult = {
  capture: { width: 1280, height: 720, frameRate: 30 },
  publish: {
    videoCodec: 'h264',
    videoEncoding: { maxBitrate: 2_000_000, maxFramerate: 30 },
    simulcast: true,
    videoSimulcastLayers: [{ width: 640, height: 360, encoding: { maxBitrate: 500_000, maxFramerate: 20 } }] as never,
    backupCodec: false,
  },
  overdrive: { maxBitrate: 2_000_000, maxFramerate: 30, degradationPreference: 'maintain-framerate', priority: 'low' },
};

describe('buildCameraCaptureOptions', () => {
  beforeEach(() => {
    resolveCameraModes.mockReset();
    getCachedCameraModes.mockReset();
  });

  it('with measure: false never measures a camera it has not seen', async () => {
    getCachedCameraModes.mockReturnValue(null);
    const { capture, fitted } = await buildCameraCaptureOptions(options, 'cam-1', { measure: false });
    expect(resolveCameraModes).not.toHaveBeenCalled();
    expect(fitted).toEqual(options.capture);
    expect(capture.deviceId).toBe('cam-1');
    // The wanted size, asked with an ideal 16:9 so a camera without the exact mode does not settle on 4:3.
    expect(capture.resolution).toMatchObject({ width: 1280, height: 720, frameRate: 30 });
    expect(capture.resolution?.aspectRatio).toBeCloseTo(16 / 9);
  });

  it('with measure: false still fits to modes that are already known', async () => {
    getCachedCameraModes.mockReturnValue([
      { width: 960, height: 540, maxFps: 30 },
      { width: 640, height: 360, maxFps: 15 },
    ]);
    const { capture, fitted } = await buildCameraCaptureOptions(options, null, { measure: false });
    expect(resolveCameraModes).not.toHaveBeenCalled();
    expect(fitted).toEqual({ width: 960, height: 540, frameRate: 30 });
    expect(capture.resolution).toMatchObject({ width: 960, height: 540 });
    expect(capture.deviceId).toBeUndefined();
  });

  it('measures by default, so a live quality change keeps its exact fit', async () => {
    resolveCameraModes.mockResolvedValue([{ width: 1280, height: 720, maxFps: 24 }]);
    const { fitted } = await buildCameraCaptureOptions(options, null);
    expect(resolveCameraModes).toHaveBeenCalledWith(null);
    expect(fitted).toEqual({ width: 1280, height: 720, frameRate: 24 });
  });
});
