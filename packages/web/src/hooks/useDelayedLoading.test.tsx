import { act, renderHook } from '@testing-library/react';
import { startTransition } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDelayedLoading } from './useDelayedLoading';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('delayed loading', () => {
 it('hides when completion overtakes a pending skeleton update', () => {
  const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), { initialProps: { loading: true } });
  act(() => {
    startTransition(() => vi.advanceTimersByTime(200));
    rerender({ loading: false });
  });
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current).toBe(false);
 });
 it('avoids flashes for fast loads and keeps visible placeholders briefly', () => {
  const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), { initialProps: { loading: true } });
  act(() => vi.advanceTimersByTime(100)); rerender({ loading: false });
  act(() => vi.advanceTimersByTime(1000)); expect(result.current).toBe(false);
  rerender({ loading: true }); act(() => vi.advanceTimersByTime(200)); expect(result.current).toBe(true);
  rerender({ loading: false }); act(() => vi.advanceTimersByTime(299)); expect(result.current).toBe(true);
  act(() => vi.advanceTimersByTime(1)); expect(result.current).toBe(false);
 });
});
