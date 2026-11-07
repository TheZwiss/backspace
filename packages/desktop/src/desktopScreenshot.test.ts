import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ nativeImage: {} }));
import { regionForDisplay } from './desktopScreenshot';

const display = (id: number, x: number, y: number, width: number, height: number) => ({ id, bounds: { x, y, width, height } }) as never;

describe('regionForDisplay', () => {
  it('maps two side-by-side monitors with a vertical offset into one 3840x1171 image', () => {
    const left = display(1, 0, 0, 1920, 1080);
    const right = display(2, 1920, 91, 1920, 1080);
    expect(regionForDisplay(left, [left, right], 3840)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(regionForDisplay(right, [left, right], 3840)).toEqual({ x: 1920, y: 91, width: 1920, height: 1080 });
  });

  it('handles a monitor placed at negative coordinates', () => {
    const left = display(1, -1920, 0, 1920, 1080);
    const main = display(2, 0, -200, 2560, 1440);
    expect(regionForDisplay(left, [left, main], 4480)).toEqual({ x: 0, y: 200, width: 1920, height: 1080 });
    expect(regionForDisplay(main, [left, main], 4480)).toEqual({ x: 1920, y: 0, width: 2560, height: 1440 });
  });

  it('scales the regions when the image has more pixels than the logical desktop', () => {
    const only = display(1, 0, 0, 1920, 1080);
    expect(regionForDisplay(only, [only], 3840)).toEqual({ x: 0, y: 0, width: 3840, height: 2160 });
  });
});
