import { describe, it, expect } from 'vitest';
import { applyWindowGeometry, computeCropRegion, computeDestinationSize, easeCrop, isCaptureActive, isWindowSourceId } from './windowCropCapture';

describe('isWindowSourceId', () => {
  it('accepts window ids and rejects screens', () => {
    expect(isWindowSourceId('window:1234:0')).toBe(true);
    expect(isWindowSourceId('screen:0:0')).toBe(false);
    expect(isWindowSourceId(null)).toBe(false);
  });
});

describe('computeCropRegion', () => {
  it('maps physical display pixels onto a 1:1 frame', () => {
    expect(computeCropRegion({ x: 100, y: 50, width: 800, height: 600 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }))
      .toEqual({ x: 100, y: 50, width: 800, height: 600 });
  });

  it('rescales when the capture is not the display size', () => {
    // 3840x2160 display captured at 1920x1080: every coordinate halves.
    expect(computeCropRegion({ x: 200, y: 100, width: 800, height: 600 }, { width: 3840, height: 2160 }, { width: 1920, height: 1080 }))
      .toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  it('clamps a crop that reaches past the frame', () => {
    const region = computeCropRegion({ x: 1800, y: 1000, width: 400, height: 400 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 });
    expect(region.x).toBe(1800);
    expect(region.x + region.width).toBeLessThanOrEqual(1920);
    expect(region.y + region.height).toBeLessThanOrEqual(1080);
  });

  it('never produces a zero-sized region', () => {
    const region = computeCropRegion({ x: 5, y: 5, width: 1, height: 1 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 });
    expect(region.width).toBeGreaterThanOrEqual(2);
    expect(region.height).toBeGreaterThanOrEqual(2);
  });
});

describe('computeDestinationSize', () => {
  it('keeps the crop size when no resolution is configured', () => {
    expect(computeDestinationSize({ x: 0, y: 0, width: 801, height: 601 })).toEqual({ width: 800, height: 600 });
  });

  it('fits the window aspect into the configured resolution', () => {
    expect(computeDestinationSize({ x: 0, y: 0, width: 1000, height: 1000 }, { width: 1920, height: 1080 }))
      .toEqual({ width: 1080, height: 1080 });
    expect(computeDestinationSize({ x: 0, y: 0, width: 1600, height: 900 }, { width: 1280, height: 720 }))
      .toEqual({ width: 1280, height: 720 });
  });
});
describe('isCaptureActive', () => {
  it('shows the window while it is the focused one', () => {
    expect(isCaptureActive({ foreground: true, minimized: false })).toBe(true);
  });

  it('pauses when another window took focus', () => {
    expect(isCaptureActive({ foreground: false, minimized: false })).toBe(false);
  });

  it('pauses when the window is minimized', () => {
    expect(isCaptureActive({ foreground: true, minimized: true })).toBe(false);
  });
});
describe('applyWindowGeometry', () => {
  const target = {
    screenSourceId: 'screen:0:0',
    monitor: { x: 0, y: 0, width: 1920, height: 1080 },
    crop: { x: 100, y: 100, width: 800, height: 600 },
    minimized: false,
    foreground: true,
  };
  const snapshot = (window, extra = {}) => ({ window, monitor: [0, 0, 1920, 1080], minimized: false, foreground: true, ...extra });

  it('moves the crop with the window', () => {
    const next = applyWindowGeometry(target, snapshot([300, 200, 800, 600]));
    expect(next?.crop).toEqual({ x: 300, y: 200, width: 800, height: 600 });
  });

  it('clamps a window hanging off the display', () => {
    const next = applyWindowGeometry(target, snapshot([1800, 1000, 400, 400]));
    expect(next?.crop).toEqual({ x: 1800, y: 1000, width: 120, height: 80 });
  });

  it('carries focus and minimized', () => {
    const next = applyWindowGeometry(target, snapshot([100, 100, 800, 600], { foreground: false, minimized: true }));
    expect(next?.foreground).toBe(false);
    expect(next?.minimized).toBe(true);
  });

  it('gives up when the window moved to another display', () => {
    expect(applyWindowGeometry(target, { window: [2100, 100, 800, 600], monitor: [1920, 0, 1920, 1080], minimized: false, foreground: true })).toBeNull();
  });

  it('gives up on a window too small to show', () => {
    expect(applyWindowGeometry(target, snapshot([100, 100, 10, 10]))).toBeNull();
  });

  it('rejects a malformed line', () => {
    expect(applyWindowGeometry(target, { window: [1, 2], monitor: [0, 0, 1920, 1080] })).toBeNull();
    expect(applyWindowGeometry(target, null)).toBeNull();
  });
});

describe('easeCrop', () => {
  it('moves part of the way towards the target', () => {
    const eased = easeCrop({ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 100, height: 100 }, 0.5);
    expect(eased).toEqual({ x: 50, y: 0, width: 100, height: 100 });
  });

  it('snaps a jump too large to be a drag', () => {
    const to = { x: 600, y: 0, width: 100, height: 100 };
    expect(easeCrop({ x: 0, y: 0, width: 100, height: 100 }, to, 0.5)).toEqual(to);
  });
});
