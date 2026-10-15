import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatDatePicker } from './ChatDatePicker';

vi.mock('../../hooks/usePortalContainer', () => ({
  usePortalContainer: () => document.body,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../../i18n/formatters', () => ({
  useFormatters: () => ({
    formatMonthYear: (year: number, month: number) => `${year}年${month + 1}月`,
    formatWeekdayShort: (idx: number) => ['日', '一', '二', '三', '四', '五', '六'][idx] ?? '',
  }),
}));

describe('ChatDatePicker', () => {
  const sampleMessageDates = new Set(['2026-10-10', '2026-10-12']);

  it('renders trigger button displaying the value', () => {
    render(
      <ChatDatePicker
        value="2026-10-12"
        onChange={vi.fn()}
        messageDates={sampleMessageDates}
      />,
    );

    expect(screen.getByRole('button', { name: /selectDate/i })).toHaveTextContent('2026-10-12');
  });

  it('opens calendar popover when clicked and shows dots for dates with messages', () => {
    render(
      <ChatDatePicker
        value="2026-10-12"
        onChange={vi.fn()}
        messageDates={sampleMessageDates}
      />,
    );

    const trigger = screen.getByRole('button', { name: /selectDate/i });
    fireEvent.click(trigger);

    // Popover is visible
    expect(screen.getByText('2026年10月')).toBeInTheDocument();
    expect(screen.getByText('日')).toBeInTheDocument();

    // Check message dots
    expect(screen.getByTestId('dot-2026-10-10')).toBeInTheDocument();
    expect(screen.getByTestId('dot-2026-10-12')).toBeInTheDocument();
    expect(screen.queryByTestId('dot-2026-10-11')).not.toBeInTheDocument();
  });

  it('calls onChange with selected date and closes popover', () => {
    const handleChange = vi.fn();
    render(
      <ChatDatePicker
        value="2026-10-12"
        onChange={handleChange}
        messageDates={sampleMessageDates}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /selectDate/i }));

    const targetDateBtn = screen.getByRole('button', { name: /^2026-10-10/ });
    fireEvent.click(targetDateBtn);

    expect(handleChange).toHaveBeenCalledWith('2026-10-10');
    // Popover should close
    expect(screen.queryByText('2026年10月')).not.toBeInTheDocument();
  });

  it('allows clicking today button to select current date', () => {
    const handleChange = vi.fn();
    render(
      <ChatDatePicker
        value="2026-10-01"
        onChange={handleChange}
        messageDates={sampleMessageDates}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /selectDate/i }));
    fireEvent.click(screen.getByText('today'));

    expect(handleChange).toHaveBeenCalled();
  });
});
