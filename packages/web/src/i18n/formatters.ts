import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from './index';

/**
 * Every date, time, number and byte size the UI shows goes through here, so
 * that the locale is the language the user selected in settings rather than
 * whatever the browser happens to report. The consistency check fails any
 * direct `toLocale*` or `Intl.*` use elsewhere in the web package.
 *
 * Formatters are cached per locale and option set: constructing an `Intl`
 * formatter is expensive enough to matter in a message list.
 */
export interface Formatters {
  /** `2:05 PM` / `14:05` */
  formatTime: (timestamp: number) => string;
  /** `Mar 15` this year, `Dec 14, 2025` otherwise. */
  formatShortDate: (timestamp: number, now?: Date) => string;
  /** `March 15, 2026` */
  formatLongDate: (timestamp: number) => string;
  /** `Mar 15, 2026, 2:05 PM` */
  formatDateTime: (timestamp: number) => string;
  /** `5 minutes ago`, `20 hours ago`, `in 3 days`: elapsed time in the largest whole unit that fits. */
  formatRelativeTime: (timestamp: number, now?: Date) => string;
  /** `today`, `yesterday`, `3 days ago`: the calendar day, so 11 pm and 1 am are a day apart. */
  formatRelativeDay: (timestamp: number, now?: Date) => string;
  formatNumber: (value: number) => string;
  /** `1.5 kB`, `3 MB`; binary steps of 1024 with the conventional SI labels. */
  formatBytes: (bytes: number) => string;
}

type DateTimeOptions = Intl.DateTimeFormatOptions;

const RELATIVE_UNITS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
];

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

export function createFormatters(getLocale: () => string): Formatters {
  const dateCache = new Map<string, Intl.DateTimeFormat>();
  const numberCache = new Map<string, Intl.NumberFormat>();
  const relativeCache = new Map<string, Intl.RelativeTimeFormat>();

  function dateFormat(options: DateTimeOptions): Intl.DateTimeFormat {
    const locale = getLocale();
    const key = `${locale}|${JSON.stringify(options)}`;
    let formatter = dateCache.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, options);
      dateCache.set(key, formatter);
    }
    return formatter;
  }

  function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
    const locale = getLocale();
    const key = `${locale}|${JSON.stringify(options)}`;
    let formatter = numberCache.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, options);
      numberCache.set(key, formatter);
    }
    return formatter;
  }

  function relativeFormat(): Intl.RelativeTimeFormat {
    const locale = getLocale();
    let formatter = relativeCache.get(locale);
    if (!formatter) {
      formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      relativeCache.set(locale, formatter);
    }
    return formatter;
  }

  return {
    formatTime: (timestamp) => dateFormat({ hour: 'numeric', minute: '2-digit' }).format(timestamp),

    formatShortDate: (timestamp, now = new Date()) => {
      const sameYear = new Date(timestamp).getFullYear() === now.getFullYear();
      return dateFormat(
        sameYear
          ? { month: 'short', day: 'numeric' }
          : { month: 'short', day: 'numeric', year: 'numeric' },
      ).format(timestamp);
    },

    formatLongDate: (timestamp) => dateFormat({ day: 'numeric', month: 'long', year: 'numeric' }).format(timestamp),

    formatDateTime: (timestamp) => dateFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(timestamp),

    formatRelativeTime: (timestamp, now = new Date()) => {
      const delta = timestamp - now.getTime();
      const magnitude = Math.abs(delta);
      for (const { unit, ms } of RELATIVE_UNITS) {
        if (magnitude >= ms) {
          return relativeFormat().format(Math.round(delta / ms), unit);
        }
      }
      return relativeFormat().format(0, 'second');
    },

    formatRelativeDay: (timestamp, now = new Date()) => {
      const dayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const days = Math.round((dayOf(new Date(timestamp)) - dayOf(now)) / (24 * 60 * 60 * 1000));
      return relativeFormat().format(days, 'day');
    },

    formatNumber: (value) => numberFormat({}).format(value),

    formatBytes: (bytes) => {
      let value = Math.max(0, bytes);
      let index = 0;
      while (value >= 1024 && index < BYTE_UNITS.length - 1) {
        value /= 1024;
        index += 1;
      }
      return numberFormat({
        style: 'unit',
        unit: BYTE_UNITS[index],
        unitDisplay: 'short',
        maximumFractionDigits: index === 0 ? 0 : 1,
      }).format(value);
    },
  };
}

/** The app-wide formatters, bound to the selected language. */
export const formatters: Formatters = createFormatters(() => i18n.resolvedLanguage ?? i18n.language ?? 'en');

/**
 * The same formatters for components. Subscribes to language changes so a
 * component re-renders with the new locale when the user switches language.
 */
export function useFormatters(): Formatters {
  const { i18n: instance } = useTranslation();
  const language = instance.resolvedLanguage ?? instance.language;
  return useMemo(() => formatters, [language]);
}
