import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyStreamHealth, useStreamHealthWarning } from './useStreamHealthWarning';

afterEach(() => vi.useRealTimers());

describe('stream health warning', () => {
  it('classifies publisher CPU, viewer network, and ambiguous degradation', () => {
    const base = {
      reconnecting: false,
      isLocal: false,
      publisherConnectionQuality: 'excellent' as const,
      localConnectionQuality: 'excellent' as const,
      outboundReason: null,
      packetLoss: null,
      jitter: null,
      freezeCountDelta: null,
    };

    expect(classifyStreamHealth({ ...base, isLocal: true, outboundReason: 'cpu' })).toBe('publisherCpu');
    expect(classifyStreamHealth({ ...base, packetLoss: 6 })).toBe('viewerNetwork');
    expect(classifyStreamHealth({
      ...base,
      publisherConnectionQuality: 'poor',
      localConnectionQuality: 'lost',
    })).toBe('unknown');
  });

  it('requires three bad samples and clears after five stable seconds', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ candidate, sample }) => useStreamHealthWarning(candidate, sample),
      { initialProps: { candidate: 'publisherNetwork' as const | null, sample: 1 } },
    );

    expect(result.current).toBeNull();
    rerender({ candidate: 'publisherNetwork', sample: 2 });
    expect(result.current).toBeNull();
    rerender({ candidate: 'publisherNetwork', sample: 3 });
    expect(result.current).toBe('publisherNetwork');

    rerender({ candidate: null, sample: 4 });
    act(() => vi.advanceTimersByTime(4999));
    expect(result.current).toBe('publisherNetwork');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBeNull();
  });

  it('surfaces reconnecting without waiting for sampled stats', () => {
    const { result } = renderHook(() => useStreamHealthWarning('reconnecting', null));
    expect(result.current).toBe('reconnecting');
  });
});
