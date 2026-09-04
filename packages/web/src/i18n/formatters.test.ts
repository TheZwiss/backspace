import { describe, it, expect } from 'vitest';
import { createFormatters } from './formatters';

// 15 March 2026, 14:05 local time. Built with the Date constructor so the
// assertions do not depend on the machine's time zone.
const march15 = new Date(2026, 2, 15, 14, 5).getTime();
const dec14LastYear = new Date(2025, 11, 14, 9, 30).getTime();

describe('createFormatters', () => {
  it('formats a short date in the selected language, not the browser default', () => {
    expect(createFormatters(() => 'en').formatShortDate(march15, new Date(2026, 5, 1))).toBe('Mar 15');
    expect(createFormatters(() => 'de').formatShortDate(march15, new Date(2026, 5, 1))).toBe('15. März');
    expect(createFormatters(() => 'ru').formatShortDate(march15, new Date(2026, 5, 1))).toBe('15 мар.');
  });

  it('adds the year to a short date from a previous year', () => {
    expect(createFormatters(() => 'en').formatShortDate(dec14LastYear, new Date(2026, 5, 1))).toBe('Dec 14, 2025');
    expect(createFormatters(() => 'de').formatShortDate(dec14LastYear, new Date(2026, 5, 1))).toBe('14. Dez. 2025');
  });

  it('formats a long date', () => {
    expect(createFormatters(() => 'en').formatLongDate(march15)).toBe('March 15, 2026');
    expect(createFormatters(() => 'de').formatLongDate(march15)).toBe('15. März 2026');
    expect(createFormatters(() => 'ru').formatLongDate(march15)).toBe('15 марта 2026 г.');
  });

  it('formats a time of day using the language\'s clock convention', () => {
    expect(createFormatters(() => 'en').formatTime(march15)).toBe('2:05 PM');
    expect(createFormatters(() => 'de').formatTime(march15)).toBe('14:05');
  });

  it('formats a date with time', () => {
    expect(createFormatters(() => 'en').formatDateTime(march15)).toBe('Mar 15, 2026, 2:05 PM');
    expect(createFormatters(() => 'de').formatDateTime(march15)).toBe('15.03.2026, 14:05');
  });

  it('names a calendar day relative to today, regardless of the hours between', () => {
    const now = new Date(2026, 2, 16, 10, 0);
    expect(createFormatters(() => 'en').formatRelativeDay(march15, now)).toBe('yesterday');
    expect(createFormatters(() => 'de').formatRelativeDay(march15, now)).toBe('gestern');
    expect(createFormatters(() => 'ru').formatRelativeDay(march15, now)).toBe('вчера');
    expect(createFormatters(() => 'en').formatRelativeDay(march15, new Date(2026, 2, 15, 23, 59))).toBe('today');
    expect(createFormatters(() => 'en').formatRelativeDay(march15, new Date(2026, 2, 18, 0, 1))).toBe('3 days ago');
  });

  it('measures relative time as elapsed time, so 20 hours is hours, not a day', () => {
    const now = new Date(2026, 2, 16, 10, 0);
    expect(createFormatters(() => 'en').formatRelativeTime(march15, now)).toBe('20 hours ago');
    expect(createFormatters(() => 'en').formatRelativeTime(new Date(2026, 2, 13, 10, 0).getTime(), now)).toBe('3 days ago');
  });

  it('formats relative time in minutes and hours below a day', () => {
    const now = new Date(2026, 2, 15, 14, 5);
    const fiveMinutesAgo = new Date(2026, 2, 15, 14, 0).getTime();
    const threeHoursAgo = new Date(2026, 2, 15, 11, 5).getTime();
    expect(createFormatters(() => 'en').formatRelativeTime(fiveMinutesAgo, now)).toBe('5 minutes ago');
    expect(createFormatters(() => 'de').formatRelativeTime(threeHoursAgo, now)).toBe('vor 3 Stunden');
    expect(createFormatters(() => 'ru').formatRelativeTime(threeHoursAgo, now)).toBe('3 часа назад');
  });

  it('formats numbers with the language\'s separators', () => {
    expect(createFormatters(() => 'en').formatNumber(1234567)).toBe('1,234,567');
    expect(createFormatters(() => 'de').formatNumber(1234567)).toBe('1.234.567');
  });

  it('formats byte sizes with a localized unit', () => {
    const en = createFormatters(() => 'en');
    expect(en.formatBytes(0)).toBe('0 byte');
    expect(en.formatBytes(1536)).toBe('1.5 kB');
    expect(en.formatBytes(3 * 1024 * 1024)).toBe('3 MB');
    expect(createFormatters(() => 'de').formatBytes(1536)).toBe('1,5 kB');
  });

  it('formats a percentage from a whole-number percent value', () => {
    expect(createFormatters(() => 'en').formatPercent(150)).toBe('150%');
    expect(createFormatters(() => 'de').formatPercent(150)).toBe('150\u00a0%');
    expect(createFormatters(() => 'ru').formatPercent(0)).toBe('0\u00a0%');
  });

  it('re-reads the language on every call so a language change takes effect', () => {
    let language = 'en';
    const formatters = createFormatters(() => language);
    expect(formatters.formatNumber(1000)).toBe('1,000');
    language = 'de';
    expect(formatters.formatNumber(1000)).toBe('1.000');
  });
});
