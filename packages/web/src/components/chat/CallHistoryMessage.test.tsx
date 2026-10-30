import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallHistoryMessage } from './CallHistoryMessage';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }) }));
afterEach(() => vi.useRealTimers());
describe('call history message', () => {
  it('counts live duration, then shows the persisted dates and stops counting', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T14:00:00Z'));
    const start = Date.now() - 65000;
    const view = render(<CallHistoryMessage actorName="Alice" event={{ event: 'call_history', startedAt: start - 1000, connectedAt: start, endedAt: null, status: 'active' }} />);
    expect(screen.getByText('1:05')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('1:07')).toBeTruthy();
    const end = Date.now();
    view.rerender(<CallHistoryMessage actorName="Alice" event={{ event: 'call_history', startedAt: start - 1000, connectedAt: start, endedAt: end, status: 'ended' }} />);
    expect(document.querySelectorAll('time')).toHaveLength(2);
    expect(document.querySelectorAll('time')[1]?.getAttribute('datetime')).toBe(new Date(end).toISOString());
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText('1:07')).toBeTruthy();
  });
});
