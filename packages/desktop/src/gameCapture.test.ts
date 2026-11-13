import { describe, expect, it } from 'vitest';
import { buildGameCaptureArgs, isValidDisplayCaptureRequest, type GameCaptureRequest } from './gameCapture';

const request: GameCaptureRequest = {
  sourceId: 'screen:0:0', frameRate: 60, cursorMode: 'hide',
  width: 1280, height: 720, sourceWidth: 1920, sourceHeight: 1080,
  bitrateKbps: 4_000,
};

describe('DXGI game capture command', () => {
  it('rejects non-screen IDs and mismatched display IDs', () => {
    expect(isValidDisplayCaptureRequest('screen:1:0')).toBe(true);
    expect(isValidDisplayCaptureRequest('screen:1:0', 'screen:1:0')).toBe(true);
    expect(isValidDisplayCaptureRequest('screen:1:0', 'screen:2:0')).toBe(false);
    expect(isValidDisplayCaptureRequest('window:123:0', 'screen:1:0')).toBe(false);
  });

  it('builds a cursor-free ddagrab input with bounded H.264 output', () => {
    const args = buildGameCaptureArgs(request, 'h264_nvenc');
    expect(args.slice(args.indexOf('-i') + 1, args.indexOf('-i') + 2)[0])
      .toContain('ddagrab=output_idx=0:draw_mouse=0:framerate=60');
    expect(args).toContain('hwdownload,format=bgra,scale=1280:720,format=nv12');
    expect(args).toContain('h264_metadata=aud=insert');
    expect(args.at(-2)).toBe('h264');
  });

  it('supports a crop and clamps invalid rate and bitrate values', () => {
    const args = buildGameCaptureArgs({
      ...request, frameRate: 0, bitrateKbps: 99_000,
      crop: { x: 20, y: 30, width: 800, height: 600 },
    }, 'libx264');
    expect(args).toContain('ddagrab=output_idx=0:draw_mouse=0:framerate=30:offset_x=20:offset_y=30:video_size=800x600');
    expect(args).toContain('50000k');
    expect(args.join(' ')).toContain('scale=1280:720');
    expect(args).toContain('libx264');
  });

  it('uses display zero and safe defaults for malformed optional values', () => {
    const args = buildGameCaptureArgs({
      sourceId: 'screen:0:0', frameRate: Number.NaN, bitrateKbps: Number.NaN,
      cursorMode: 'auto',
    });
    expect(args).toContain('ddagrab=output_idx=0:draw_mouse=1:framerate=30');
    expect(args).toContain('6000k');
    expect(args).toContain('libx264');
  });

  it('draws the desktop cursor for Auto and Show, hiding it only for Hide', () => {
    for (const cursorMode of ['auto', 'show'] as const) {
      const args = buildGameCaptureArgs({ ...request, cursorMode });
      expect(args.join(' ')).toContain('ddagrab=output_idx=0:draw_mouse=1:framerate=60');
    }
    const hidden = buildGameCaptureArgs({ ...request, cursorMode: 'hide' });
    expect(hidden.join(' ')).toContain('ddagrab=output_idx=0:draw_mouse=0:framerate=60');
  });

  it('supports capture and encoder output at 120 fps', () => {
    const args = buildGameCaptureArgs({ ...request, frameRate: 120 });
    expect(args).toContain('ddagrab=output_idx=0:draw_mouse=0:framerate=120');
    expect(args.slice(args.indexOf('-g') + 1, args.indexOf('-g') + 2)).toEqual(['60']);
  });

  it('caps finite rates at 120 and preserves the fallback for non-finite rates', () => {
    const aboveLimit = buildGameCaptureArgs({ ...request, frameRate: 240 });
    const nonFinite = buildGameCaptureArgs({ ...request, frameRate: Number.POSITIVE_INFINITY });
    expect(aboveLimit).toContain('ddagrab=output_idx=0:draw_mouse=0:framerate=120');
    expect(nonFinite).toContain('ddagrab=output_idx=0:draw_mouse=0:framerate=30');
  });
});


it('keeps same-size native crops on the GPU instead of downloading them for a redundant scale', () => {
  const args = buildGameCaptureArgs({ ...request, width: 800, height: 600, crop: { x: 0, y: 0, width: 800, height: 600 } }, 'h264_nvenc');
  expect(args[args.indexOf('-vf') + 1]).toBe('format=d3d11');
});
