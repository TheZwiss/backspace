import { describe, expect, it } from 'vitest';
import {
  MAX_CLIP_SECONDS,
  centreSelection,
  computePeaks,
  defaultSelection,
  findAudibleRange,
  isValidSelection,
  moveEnd,
  moveStart,
  selectAudible,
  slideSelection,
} from './audioTrim';

describe('defaultSelection', () => {
  it('keeps a short file whole', () => {
    expect(defaultSelection(3.2)).toEqual({ start: 0, end: 3.2 });
  });

  it('caps a long file at the limit', () => {
    expect(defaultSelection(42)).toEqual({ start: 0, end: MAX_CLIP_SECONDS });
  });
});

describe('moveStart', () => {
  it('cannot cross the end handle', () => {
    const result = moveStart({ start: 1, end: 3 }, 9, 10);
    expect(result.start).toBeLessThan(3);
    expect(result.end).toBe(3);
  });

  it('cannot make the clip longer than the limit', () => {
    expect(moveStart({ start: 4, end: 8 }, 0, 10)).toEqual({ start: 3, end: 8 });
  });

  it('cannot go before the beginning', () => {
    expect(moveStart({ start: 1, end: 3 }, -5, 10).start).toBe(0);
  });
});

describe('moveEnd', () => {
  it('cannot cross the start handle', () => {
    const result = moveEnd({ start: 4, end: 6 }, 0, 10);
    expect(result.end).toBeGreaterThan(4);
  });

  it('cannot make the clip longer than the limit', () => {
    expect(moveEnd({ start: 1, end: 3 }, 10, 12)).toEqual({ start: 1, end: 1 + MAX_CLIP_SECONDS });
  });

  it('cannot pass the end of the source', () => {
    expect(moveEnd({ start: 1, end: 3 }, 99, 4).end).toBe(4);
  });
});

describe('slideSelection and centreSelection', () => {
  it('keeps the length and stays inside the source', () => {
    expect(slideSelection({ start: 2, end: 5 }, 100, 10)).toEqual({ start: 7, end: 10 });
    expect(slideSelection({ start: 2, end: 5 }, -100, 10)).toEqual({ start: 0, end: 3 });
  });

  it('centres on a point without shrinking', () => {
    const result = centreSelection({ start: 0, end: 4 }, 6, 20);
    expect(result.start).toBeCloseTo(4);
    expect(result.end).toBeCloseTo(8);
  });
});

describe('isValidSelection', () => {
  it('accepts a cut inside the limit and rejects one over it or outside the source', () => {
    expect(isValidSelection({ start: 1, end: 6 }, 20)).toBe(true);
    expect(isValidSelection({ start: 1, end: 6.5 }, 20)).toBe(false);
    expect(isValidSelection({ start: -1, end: 2 }, 20)).toBe(false);
    expect(isValidSelection({ start: 18, end: 21 }, 20)).toBe(false);
  });
});

describe('computePeaks', () => {
  it('summarises the loudest sample of every bucket across channels', () => {
    const left = new Float32Array([0, 0.5, 0, 0]);
    const right = new Float32Array([0, 0, 0, -0.8]);
    expect(computePeaks([left, right], 2)).toEqual([0.5, 0.800000011920929]);
  });

  it('returns zeros for an empty source', () => {
    expect(computePeaks([], 4)).toEqual([0, 0, 0, 0]);
  });
});

describe('audible range', () => {
  const rate = 10;
  const samples = new Float32Array(100);
  samples[20] = 0.5;
  samples[39] = -0.5;

  it('finds the first and last audible moments', () => {
    expect(findAudibleRange([samples], rate)).toEqual({ start: 2, end: 4 });
  });

  it('is null for silence', () => {
    expect(findAudibleRange([new Float32Array(10)], rate)).toBeNull();
  });

  it('selectAudible frames the sound with a little padding and never exceeds the limit', () => {
    const framed = selectAudible([samples], rate, 10, 0.1);
    expect(framed.start).toBeCloseTo(1.9);
    expect(framed.end).toBeCloseTo(4.1);

    const long = new Float32Array(1000);
    long[0] = 1; long[999] = 1;
    const limited = selectAudible([long], 10, 100, 0);
    expect(limited.end - limited.start).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
  });

  it('falls back to the default cut for silence', () => {
    expect(selectAudible([new Float32Array(10)], 10, 1)).toEqual({ start: 0, end: 1 });
  });
});
