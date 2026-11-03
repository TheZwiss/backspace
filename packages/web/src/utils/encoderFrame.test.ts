import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEncoderFrameNormalizer } from './encoderFrame';
const draw = vi.fn();
const surfaces: { width: number; height: number; getContext: ReturnType<typeof vi.fn> }[] = [];
beforeEach(() => {
  surfaces.length = 0; draw.mockClear();
  vi.stubGlobal('OffscreenCanvas', class {
    getContext = vi.fn(() => ({ drawImage: draw }));
    constructor(public width: number, public height: number) { surfaces.push(this); }
  });
  vi.stubGlobal('VideoFrame', class {
    codedWidth: number; codedHeight: number; timestamp: number; duration?: number;
    constructor(surface: OffscreenCanvas, init: VideoFrameInit) {
      this.codedWidth = surface.width; this.codedHeight = surface.height;
      this.timestamp = init.timestamp!; this.duration = init.duration;
    }
  });
});
afterEach(() => vi.unstubAllGlobals());
function frame(codedHeight = 1088, displayWidth = 1920, displayHeight = 1080): VideoFrame {
  return { codedWidth: displayWidth, codedHeight, displayWidth, displayHeight,
    visibleRect: { x: 0, y: 0, width: displayWidth, height: displayHeight }, timestamp: 32000, duration: 16667 } as VideoFrame;
}
describe('encoder surface geometry', () => {
  it('materializes all 1080 visible rows without leaking the padded 1088 surface into the encoder', () => {
    const input = frame();
    const output = createEncoderFrameNormalizer()(input);
    expect(output).not.toBe(input);
    expect(output.codedWidth).toBe(1920); expect(output.codedHeight).toBe(1080);
    expect(output.timestamp).toBe(32000); expect(output.duration).toBe(16667);
    expect(draw).toHaveBeenCalledWith(input, 0, 0, 1920, 1080);
  });
  it('does not allocate or convert unpadded frames', () => {
    const input = frame(1080);
    expect(createEncoderFrameNormalizer()(input)).toBe(input);
    expect(surfaces).toHaveLength(0); expect(draw).not.toHaveBeenCalled();
  });
  it('reuses its surface and updates dimensions after a resolution change', () => {
    const normalize = createEncoderFrameNormalizer();
    normalize(frame()); normalize(frame());
    const output = normalize(frame(736, 1280, 720));
    expect(surfaces).toHaveLength(1);
    expect(output.codedWidth).toBe(1280); expect(output.codedHeight).toBe(720);
  });
  it('normalizes nonzero visible offsets even when dimensions otherwise match', () => {
    const input = frame(1080); Object.assign(input, { visibleRect: { x: 2, y: 0, width: 1918, height: 1080 } });
    expect(createEncoderFrameNormalizer()(input)).not.toBe(input);
  });
});
