import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDelayedLoading } from '../useDelayedLoading';

const THRESHOLD = 200;
const MIN_DISPLAY = 300;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDelayedLoading', () => {
  it('does not show before threshold elapses', () => {
    const { result } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(THRESHOLD - 1); });
    expect(result.current).toBe(false);
  });

  it('shows after threshold elapses while loading is true', () => {
    const { result } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    act(() => { vi.advanceTimersByTime(THRESHOLD); });
    expect(result.current).toBe(true);
  });

  it('cancels threshold if loading flips false before it fires', () => {
    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    act(() => { vi.advanceTimersByTime(THRESHOLD - 50); });
    rerender({ loading: false });
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe(false);
  });

  it('keeps shown for at least minDisplay after first becoming visible', () => {
    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    act(() => { vi.advanceTimersByTime(THRESHOLD); });
    expect(result.current).toBe(true);
    rerender({ loading: false });
    act(() => { vi.advanceTimersByTime(MIN_DISPLAY - 1); });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Hypothesised bug: every threshold-timer fire calls
  //   displayStartRef.current = Date.now()
  // unconditionally — even when `show` is already true. If `isLoading` cycles
  // true → false → true → false with each `true` segment ≥ threshold, every
  // cycle fires the threshold timer again, refreshes displayStart, and the
  // following `false` schedules minDisplay from that refreshed timestamp. The
  // skeleton therefore never reaches its real minDisplay deadline.
  //
  // Intent of the hook: once shown, hide as soon as `isLoading` goes false AND
  // at least minDisplay ms have passed since the *first* time it became visible.
  // ---------------------------------------------------------------------------

  it('REGRESSION: rapid true→false→true→false cycles must clear within bounded time', () => {
    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });

    // First show: threshold elapses, show becomes true at t = 200.
    act(() => { vi.advanceTimersByTime(THRESHOLD); });
    expect(result.current).toBe(true);

    // Cycle pattern:
    //   - 50 ms of false   (short, never long enough to clear minDisplay alone)
    //   - 200 ms of true   (exactly enough to re-fire the threshold timer)
    // Each iteration is 250 ms of wall time. After ~10 cycles (2.5 s of wall
    // time) the skeleton has been visible for two and a half full seconds with
    // many opportunities to clear, since `loading=false` segments occur
    // repeatedly and each is well past the minDisplay deadline measured from
    // the *original* displayStart at t=200.
    for (let i = 0; i < 10; i++) {
      rerender({ loading: false });
      act(() => { vi.advanceTimersByTime(50); });
      rerender({ loading: true });
      act(() => { vi.advanceTimersByTime(THRESHOLD); });
    }

    // Now end on `loading=false` and let any pending minDisplay timer drain.
    rerender({ loading: false });
    act(() => { vi.advanceTimersByTime(MIN_DISPLAY * 2); });

    // After all cycling stops and we wait long enough for any scheduled
    // minDisplay timer to fire, the skeleton MUST be hidden. If this fails
    // with `result.current === true`, the displayStart-refresh bug is real:
    // the hook keeps moving its own deadline forward and the skeleton stays
    // visible indefinitely under this input pattern.
    expect(result.current).toBe(false);
  });

  it('REGRESSION: minDisplay deadline measured from FIRST show, not refreshed by re-fired threshold', () => {
    // Simpler, more focused variant of the above. One re-fire of the threshold
    // timer is enough to demonstrate the bug:
    //   t=0   loading=true  → schedule threshold (fires t=200)
    //   t=200 threshold fires → show=true, displayStart=200
    //   t=250 loading=false  → schedule minDisplay (remaining=250, fires t=500)
    //   t=300 loading=true   → cancel minDisplay, schedule threshold (fires t=500)
    //   t=500 threshold fires AGAIN → show=true (no-op), displayStart=500 (BUG: refreshed)
    //   t=550 loading=false  → schedule minDisplay (remaining=250 from refreshed start, fires t=800)
    //
    // Intent: skeleton was first shown at t=200. minDisplay window is 300 ms,
    // so it should be eligible to hide at t=500. With the final `loading=false`
    // at t=550 (well past t=500), it should hide essentially immediately.
    //
    // Bug: hook waits until t=800 because displayStart was clobbered.

    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });

    act(() => { vi.advanceTimersByTime(200); });   // t=200, threshold fires
    expect(result.current).toBe(true);

    rerender({ loading: false });                  // t=200, schedule M1
    act(() => { vi.advanceTimersByTime(100); });   // t=300

    rerender({ loading: true });                   // t=300, cancel M1, schedule T2
    act(() => { vi.advanceTimersByTime(200); });   // t=500, T2 fires (refreshes displayStart)

    rerender({ loading: false });                  // t=500, schedule M2
    act(() => { vi.advanceTimersByTime(50); });    // t=550

    // At t=550 we are 350 ms past the original show-time (t=200), well beyond
    // the 300 ms minDisplay floor. The skeleton should be hidden by now.
    expect(result.current).toBe(false);
  });

  it('honors a custom threshold passed via options', () => {
    const { result } = renderHook(
      ({ loading }) => useDelayedLoading(loading, { threshold: 50 }),
      { initialProps: { loading: true } },
    );
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(49); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
  });

  it('default 200ms threshold does not fire at t=50ms (negative control for the custom-threshold test above)', () => {
    // Negative control: same conditions with the default would still be false at t=50.
    const { result: defaultThresholdResult } = renderHook(
      ({ loading }) => useDelayedLoading(loading),
      { initialProps: { loading: true } },
    );
    act(() => { vi.advanceTimersByTime(50); });
    expect(defaultThresholdResult.current).toBe(false);
  });
});
