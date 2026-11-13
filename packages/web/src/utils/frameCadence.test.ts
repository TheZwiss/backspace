import { describe, expect, it } from 'vitest';
import { FrameCadence } from './frameCadence';

function sampleCount(rate: number, seconds: number): number {
  const cadence = new FrameCadence(rate);
  let draws = 0;
  for (let frame = 0; frame < 60 * seconds; frame += 1) {
    if (cadence.shouldDraw(frame * (1000 / 60))) draws += 1;
  }
  return draws;
}

describe('FrameCadence', () => {
  it.each([30, 45, 60])('produces about %i FPS from a 60 Hz source', rate => {
    expect(sampleCount(rate, 10)).toBe(rate * 10);
  });

  it('uses a valid 60 FPS fallback for invalid constructor rates', () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cadence = new FrameCadence(invalid);
      expect(cadence.rate).toBe(60);
      expect(cadence.shouldDraw(0)).toBe(true);
      expect(cadence.shouldDraw(1000 / 60)).toBe(true);
    }
  });

  it('ignores invalid rate changes and applies valid changes from the last draw', () => {
    const cadence = new FrameCadence(30);
    expect(cadence.shouldDraw(0)).toBe(true);
    cadence.setRate(45);
    expect(cadence.rate).toBe(45);
    expect(cadence.shouldDraw(20)).toBe(false);
    expect(cadence.shouldDraw(23)).toBe(true);

    cadence.setRate(Number.NaN);
    cadence.setRate(0);
    expect(cadence.rate).toBe(45);
    expect(cadence.shouldDraw(40)).toBe(false);
  });

  it('does not reset the phase when setting the current rate again', () => {
    const cadence = new FrameCadence(30);
    expect(cadence.shouldDraw(0)).toBe(true);
    expect(cadence.shouldDraw(16)).toBe(false);
    cadence.setRate(30);
    expect(cadence.shouldDraw(33)).toBe(false);
    expect(cadence.shouldDraw(34)).toBe(true);
  });

  it('draws once after a long stall without bursting or drifting from the cadence', () => {
    const cadence = new FrameCadence(30);
    expect(cadence.shouldDraw(0)).toBe(true);
    expect(cadence.shouldDraw(10_000)).toBe(true);
    expect(cadence.shouldDraw(10_001)).toBe(false);
    expect(cadence.shouldDraw(10_034)).toBe(true);
  });

  it('does not impose a maximum rate cap', () => {
    const cadence = new FrameCadence(120);
    expect(cadence.shouldDraw(0)).toBe(true);
    expect(cadence.shouldDraw(8.34)).toBe(true);
  });
});
