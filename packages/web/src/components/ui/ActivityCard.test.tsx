import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from '@backspace/shared';
import { setLanguage } from '../../i18n';
import { ActivityCard } from './ActivityCard';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
});

afterEach(async () => {
  await setLanguage('en');
  vi.useRealTimers();
});

describe('ActivityCard', () => {
  it('localizes the elapsed activity time', async () => {
    await setLanguage('ru');
    const activity: Activity = {
      type: 'playing',
      name: 'Escape from Tarkov',
      timestamps: { start: Date.now() - 32 * 60 * 1000 },
    };

    render(<ActivityCard activities={[activity]} />);

    const titleEl = screen.getByText('Escape from Tarkov');
    expect(titleEl).toBeInTheDocument();
    expect(titleEl).toHaveAttribute('title', 'Escape from Tarkov');
    expect(screen.getByText('Прошло 32 мин.')).toBeInTheDocument();
  });

  it('renders emoji shortcodes in a custom status (issue #252)', () => {
    render(<ActivityCard activities={[{ type: 'custom', name: 'on call :pager:' }]} />);
    const el = screen.getByText('on call 📟');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('title', 'on call 📟');
  });

  it('renders emoji shortcodes in the fallback custom status', () => {
    render(<ActivityCard activities={[]} fallbackCustomStatus="on call :pager:" />);
    const el = screen.getByText('on call 📟');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('title', 'on call 📟');
  });
});
