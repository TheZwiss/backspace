import { describe, it, expect } from 'vitest';
import { roundTwoSignificant } from './rounding.js';

describe('roundTwoSignificant', () => {
  it('keeps values under 100 exact', () => {
    expect(roundTwoSignificant(0)).toBe(0);
    expect(roundTwoSignificant(7)).toBe(7);
    expect(roundTwoSignificant(99)).toBe(99);
  });
  it('rounds larger values to two significant digits', () => {
    expect(roundTwoSignificant(101)).toBe(100);
    expect(roundTwoSignificant(12345)).toBe(12000);
    expect(roundTwoSignificant(12500)).toBe(13000);
    expect(roundTwoSignificant(999)).toBe(1000);
  });
  it('never returns negatives or fractions', () => {
    expect(roundTwoSignificant(-5)).toBe(0);
    expect(roundTwoSignificant(3.7)).toBe(3);
  });
});
