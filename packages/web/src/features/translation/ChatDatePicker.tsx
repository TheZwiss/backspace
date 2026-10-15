import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';

import { useFormatters } from '../../i18n/formatters';

export interface ChatDatePickerProps {
  value: string; // ISO date 'YYYY-MM-DD'
  onChange: (date: string) => void;
  messageDates: Set<string>;
  disabled?: boolean;
}

function getTodayIsoDate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatIso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function ChatDatePicker({ value, onChange, messageDates, disabled }: ChatDatePickerProps) {
  const { t } = useTranslation('translation');
  const { formatMonthYear, formatWeekdayShort } = useFormatters();
  const [isOpen, setIsOpen] = useState(false);
  const portalContainer = usePortalContainer();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const todayIso = useMemo(() => getTodayIsoDate(), []);
  const todayParts = useMemo(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }, []);

  const [viewYear, setViewYear] = useState<number>(() => {
    const y = parseInt(value.slice(0, 4), 10);
    return Number.isFinite(y) ? y : todayParts.year;
  });
  const [viewMonth, setViewMonth] = useState<number>(() => {
    const m = parseInt(value.slice(5, 7), 10) - 1;
    return Number.isFinite(m) ? m : todayParts.month;
  });

  // Sync viewing month/year when popover opens or value changes externally
  useEffect(() => {
    if (isOpen && value) {
      const parts = value.split('-');
      if (parts.length === 3) {
        const y = parseInt(parts[0]!, 10);
        const m = parseInt(parts[1]!, 10) - 1;
        if (Number.isFinite(y)) setViewYear(y);
        if (Number.isFinite(m)) setViewMonth(m);
      }
    }
  }, [isOpen, value]);

  const { style } = useFloatingPosition(triggerRef, popoverRef, {
    placement: 'bottom',
    offset: 6,
    enabled: isOpen,
  });

  // Click outside to dismiss
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Escape key to dismiss
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const weekdays = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map(formatWeekdayShort), [formatWeekdayShort]);
  const monthTitle = useMemo(() => formatMonthYear(viewYear, viewMonth), [formatMonthYear, viewYear, viewMonth]);

  const isCurrentOrFutureMonth = viewYear > todayParts.year || (viewYear === todayParts.year && viewMonth >= todayParts.month);

  const handlePrevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (isCurrentOrFutureMonth) return;
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const calendarDays = useMemo(() => {
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();

    const blanks = Array.from({ length: firstDayOfWeek });
    const days = Array.from({ length: daysInMonth }, (_, idx) => {
      const day = idx + 1;
      const isoString = formatIso(viewYear, viewMonth, day);
      return {
        day,
        isoString,
        isToday: isoString === todayIso,
        isSelected: isoString === value,
        isFuture: isoString > todayIso,
        hasMessages: messageDates.has(isoString),
      };
    });

    return { blanks, days };
  }, [viewYear, viewMonth, value, todayIso, messageDates]);

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label={t('selectDate')}
        aria-expanded={isOpen}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-all ${
          isOpen
            ? 'bg-accent-primary/10 border-accent-primary/40 text-accent-primary shadow-sm'
            : 'bg-white/[0.04] border-white/[0.08] hover:bg-white/[0.08] text-txt-primary hover:border-white/[0.15]'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span>📅</span>
        <span>{value}</span>
        <svg
          className={`w-3.5 h-3.5 text-txt-tertiary transition-transform ${isOpen ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={popoverRef}
            style={style}
            className="fixed z-[350] w-72 rounded-2xl bg-surface-elevated/95 backdrop-blur-xl border border-white/[0.1] shadow-2xl p-3.5 space-y-3 animate-slide-up text-txt-primary"
          >
            {/* Header: Month switcher */}
            <div className="flex items-center justify-between px-1">
              <button
                type="button"
                onClick={handlePrevMonth}
                className="p-1 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.08] transition-colors"
                aria-label={t('prevMonth')}
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              <span className="text-xs font-semibold text-txt-primary select-none">{monthTitle}</span>
              <button
                type="button"
                disabled={isCurrentOrFutureMonth}
                onClick={handleNextMonth}
                className={`p-1 rounded-lg transition-colors ${
                  isCurrentOrFutureMonth
                    ? 'text-txt-tertiary/20 cursor-not-allowed'
                    : 'text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.08]'
                }`}
                aria-label={t('nextMonth')}
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>

            {/* Weekdays header */}
            <div className="grid grid-cols-7 gap-1 text-center">
              {weekdays.map((w, i) => (
                <div key={i} className="text-[11px] font-medium text-txt-tertiary/70 select-none py-0.5">
                  {w}
                </div>
              ))}
            </div>

            {/* Days grid */}
            <div className="grid grid-cols-7 gap-1 text-center">
              {calendarDays.blanks.map((_, i) => (
                <div key={`blank-${i}`} className="h-8 w-8" />
              ))}

              {calendarDays.days.map(({ day, isoString, isToday, isSelected, isFuture, hasMessages }) => (
                <button
                  key={isoString}
                  type="button"
                  disabled={isFuture}
                  onClick={() => {
                    onChange(isoString);
                    setIsOpen(false);
                  }}
                  aria-label={`${isoString}${hasMessages ? ' - ' + t('hasChatRecords') : ''}`}
                  className={`relative flex flex-col items-center justify-center h-8 w-8 mx-auto rounded-full text-xs transition-colors select-none ${
                    isSelected
                      ? 'bg-accent-primary text-white font-semibold shadow-sm'
                      : isFuture
                        ? 'text-txt-tertiary/25 cursor-not-allowed'
                        : isToday
                          ? 'text-accent-primary font-semibold border border-accent-primary/40 hover:bg-accent-primary/10 cursor-pointer'
                          : hasMessages
                            ? 'text-txt-primary font-medium hover:bg-white/[0.08] cursor-pointer'
                            : 'text-txt-tertiary/70 hover:text-txt-primary hover:bg-white/[0.04] cursor-pointer'
                  }`}
                >
                  <span className="leading-none">{day}</span>
                  {hasMessages && (
                    <span
                      data-testid={`dot-${isoString}`}
                      className={`absolute bottom-1 w-1.5 h-1.5 rounded-full ${
                        isSelected ? 'bg-white' : 'bg-accent-primary'
                      }`}
                    />
                  )}
                </button>
              ))}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-2 border-t border-white/[0.06] text-[11px]">
              <div className="flex items-center gap-1.5 text-txt-tertiary">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-primary" />
                <span>{t('hasChatRecords')}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  onChange(todayIso);
                  setIsOpen(false);
                }}
                className="text-accent-primary hover:underline font-medium"
              >
                {t('today')}
              </button>
            </div>
          </div>,
          portalContainer,
        )}
    </div>
  );
}
