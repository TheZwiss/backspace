import { describe, it, expect } from 'vitest';
import { utcDay, addDays, isIsoDay } from './day.js';

describe('day helpers', () => {
  it('formats a UTC calendar day', () => {
    expect(utcDay(new Date('2026-09-06T23:59:59Z'))).toBe('2026-09-06');
    expect(utcDay(new Date('2026-09-06T00:00:00Z'))).toBe('2026-09-06');
  });
  it('adds and subtracts days across month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('recognises only YYYY-MM-DD', () => {
    expect(isIsoDay('2026-09-06')).toBe(true);
    expect(isIsoDay('2026-9-6')).toBe(false);
    expect(isIsoDay(20260906)).toBe(false);
  });
  it('rejects days that do not exist in the calendar', () => {
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('2026-04-31')).toBe(false);
    expect(isIsoDay('2026-13-01')).toBe(false);
    expect(isIsoDay('2024-02-29')).toBe(true);
  });
});
