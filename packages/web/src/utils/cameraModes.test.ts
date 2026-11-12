import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearCameraModeCache,
  getCachedCameraModes,
  pickCameraCapture,
  probeAndCacheTrack,
  probeCameraTrack,
  supportedCameraChoices,
  type CameraMode,
} from './cameraModes';

/** A camera that delivers only the listed [width, height, maxFps] modes. */
function fakeTrack(
  modes: Array<[number, number, number]>,
  caps: { height: { max: number }; frameRate: { max: number } } = { height: { max: 2160 }, frameRate: { max: 120 } },
): MediaStreamTrack {
  let current = { width: 640, height: 480, frameRate: 30 };
  const track = {
    readyState: 'live',
    getCapabilities: () => caps,
    getSettings: () => current,
    applyConstraints: vi.fn(async (c: MediaTrackConstraints) => {
      const w = (c.width as { exact?: number } | undefined)?.exact;
      const h = (c.height as { exact?: number } | undefined)?.exact;
      const fps = (c.frameRate as { exact?: number } | undefined)?.exact;
      const mode = modes.find(([mw, mh]) => mw === w && mh === h);
      if (!mode || (fps !== undefined && fps > mode[2])) throw new Error('OverconstrainedError');
      current = { width: mode[0], height: mode[1], frameRate: fps ?? 30 };
    }),
  };
  return track as unknown as MediaStreamTrack;
}

afterEach(() => clearCameraModeCache());

describe('probeCameraTrack', () => {
  it('reports only the 16:9 modes the camera accepts, with their top frame rate', async () => {
    const track = fakeTrack([[1920, 1080, 30], [1280, 720, 60], [640, 480, 30]]);
    const modes = await probeCameraTrack(track);
    expect(modes).toEqual([
      { width: 1920, height: 1080, maxFps: 30 },
      { width: 1280, height: 720, maxFps: 60 },
    ]);
  });

  it('spends one capture restart per size on a camera that cannot exceed 30 fps', async () => {
    const track = fakeTrack([[1920, 1080, 30], [1280, 720, 30]], { height: { max: 1080 }, frameRate: { max: 30 } });
    const modes = await probeCameraTrack(track);
    expect(modes).toEqual([
      { width: 1920, height: 1080, maxFps: 30 },
      { width: 1280, height: 720, maxFps: 30 },
    ]);
    // 1080, 720 accepted, 540 and 360 refused: four applies, with no frame-rate probe on top.
    expect(track.applyConstraints).toHaveBeenCalledTimes(4);
  });

  it('still probes frame rates downward on a camera that can exceed 30 fps', async () => {
    const track = fakeTrack([[1280, 720, 60]], { height: { max: 720 }, frameRate: { max: 60 } });
    expect(await probeCameraTrack(track)).toEqual([{ width: 1280, height: 720, maxFps: 60 }]);
  });

  it('returns nothing for a camera with no 16:9 mode', async () => {
    expect(await probeCameraTrack(fakeTrack([[640, 480, 30]]))).toEqual([]);
  });
});

describe('probeAndCacheTrack', () => {
  it('caches per device and does not probe again', async () => {
    const track = fakeTrack([[1280, 720, 30]]);
    await probeAndCacheTrack('cam-1', track);
    const calls = (track.applyConstraints as ReturnType<typeof vi.fn>).mock.calls.length;
    await probeAndCacheTrack('cam-1', track);
    expect((track.applyConstraints as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    expect(getCachedCameraModes('cam-1')).toEqual([{ width: 1280, height: 720, maxFps: 30 }]);
    expect(getCachedCameraModes('cam-2')).toBeNull();
  });
});

describe('pickCameraCapture', () => {
  const modes: CameraMode[] = [
    { width: 1280, height: 720, maxFps: 60 },
    { width: 1920, height: 1080, maxFps: 30 },
  ];

  it('keeps an exactly supported request', () => {
    expect(pickCameraCapture(modes, 720, 60)).toEqual({ width: 1280, height: 720, frameRate: 60 });
  });

  it('clamps the frame rate to what the chosen size holds', () => {
    expect(pickCameraCapture(modes, 1080, 60)).toEqual({ width: 1920, height: 1080, frameRate: 30 });
  });

  it('steps down to the largest mode below an unsupported size', () => {
    expect(pickCameraCapture(modes, 1440, 30)).toEqual({ width: 1920, height: 1080, frameRate: 30 });
  });

  it('uses the smallest mode when every mode is larger than the request', () => {
    expect(pickCameraCapture(modes, 540, 30)).toEqual({ width: 1280, height: 720, frameRate: 30 });
  });

  it('returns null when nothing is known', () => {
    expect(pickCameraCapture([], 720, 30)).toBeNull();
  });
});

describe('supportedCameraChoices', () => {
  it('lists the heights and the top frame rate per height', () => {
    const choices = supportedCameraChoices([{ width: 1280, height: 720, maxFps: 60 }]);
    expect(choices.heights.has(720)).toBe(true);
    expect(choices.maxFpsByHeight.get(720)).toBe(60);
  });
});
