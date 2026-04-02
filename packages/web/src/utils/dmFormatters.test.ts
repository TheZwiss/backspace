import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDmTimestamp } from './dmFormatters';

/** Build a local-time Date: new Date(year, month-1, day, hour, minute) as a timestamp. */
function localTs(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('formatDmTimestamp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows time for today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 16, 0)); // Apr 2 2026, 4:00 PM local

    const twoHoursAgo = localTs(2026, 4, 2, 14, 0); // Apr 2 2026, 2:00 PM local
    const result = formatDmTimestamp(twoHoursAgo);
    // Should be a time string like "2:00 PM" — not "Yesterday" or a date
    expect(result).not.toBe('Yesterday');
    expect(result).not.toMatch(/\d{4}/); // no year
    expect(result).toMatch(/\d{1,2}/); // has a number (hour)
  });

  it('shows "Yesterday" for yesterday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 16, 0)); // Apr 2 2026

    const yesterday = localTs(2026, 4, 1, 12, 0); // Apr 1 2026
    expect(formatDmTimestamp(yesterday)).toBe('Yesterday');
  });

  it('shows month and day for this year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 16, 0)); // Apr 2 2026

    const marchDate = localTs(2026, 3, 15, 12, 0); // Mar 15 2026
    const result = formatDmTimestamp(marchDate);
    expect(result).toMatch(/Mar\s+15/);
  });

  it('shows month, day and year for previous years', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 16, 0)); // Apr 2 2026

    const lastYear = localTs(2025, 12, 14, 12, 0); // Dec 14 2025
    const result = formatDmTimestamp(lastYear);
    expect(result).toMatch(/Dec\s+14/);
    expect(result).toMatch(/2025/);
  });

  it('handles midnight boundary correctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 2, 0, 5)); // Apr 2 2026, 00:05 local

    const lastNight = localTs(2026, 4, 1, 23, 55); // Apr 1 2026, 23:55 local
    expect(formatDmTimestamp(lastNight)).toBe('Yesterday');
  });
});
