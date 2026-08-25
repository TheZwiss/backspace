import { describe, it, expect, beforeEach } from 'vitest';
import { computeFloatingPosition } from './useFloatingPosition';

function rect(left: number, top: number, w = 40, h = 40): DOMRect {
  return { left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe('computeFloatingPosition', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  });

  it('places a right-anchored surface just past the anchor', () => {
    expect(computeFloatingPosition(rect(100, 100), 340, 420, 'right', 8)).toMatchObject({
      left: 148,
      actualPlacement: 'right',
    });
  });

  it('flips left when the surface would overflow the right edge', () => {
    const pos = computeFloatingPosition(rect(900, 100), 340, 420, 'right', 8);
    expect(pos.actualPlacement).toBe('left');
    expect(pos.left).toBe(900 - 340 - 8);
  });

  it("aligns to the anchor's leading edge when asked, instead of centring on it", () => {
    // The profile card lines its top edge up with the row it was opened from;
    // centring a 420px card on a 32px avatar would drag it far up the screen.
    const pos = computeFloatingPosition(rect(100, 300), 340, 420, 'right', 8, 'start');
    expect(pos.top).toBe(300);
  });

  it('centres on the anchor by default', () => {
    const pos = computeFloatingPosition(rect(100, 300), 340, 420, 'right', 8);
    expect(pos.top).toBe(300 + 20 - 210);
  });

  it('clamps a surface taller than the space below its anchor', () => {
    const pos = computeFloatingPosition(rect(100, 700), 340, 420, 'right', 8);
    expect(pos.top + 420).toBeLessThanOrEqual(800 - 8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });
});
