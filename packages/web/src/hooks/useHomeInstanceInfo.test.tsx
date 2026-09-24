import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { InstanceInfoResponse } from '@backspace/shared';
import { api } from '../api/client';
import {
  useHomeInstanceInfo,
  invalidateHomeInstanceInfo,
  __resetHomeInstanceInfoForTests,
} from './useHomeInstanceInfo';

function info(over: Partial<InstanceInfoResponse> = {}): InstanceInfoResponse {
  return {
    name: 'Home',
    version: '1.5.1',
    registrationOpen: true,
    federatedRegistrationOpen: true,
    instanceId: 'instance-1',
    sourceCodeUrl: 'https://github.com/TheZwiss/backspace',
    commit: null,
    directoryConfigured: false,
    directoryAvailable: false,
    directoryEnabled: false,
    supportCardEnabled: true,
    ...over,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetHomeInstanceInfoForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetHomeInstanceInfoForTests();
});

describe('useHomeInstanceInfo', () => {
  it('shares one request between two concurrent subscribers', async () => {
    const pending = deferred<InstanceInfoResponse>();
    const spy = vi.spyOn(api.instance, 'info').mockReturnValue(pending.promise);

    const first = renderHook(() => useHomeInstanceInfo());
    const second = renderHook(() => useHomeInstanceInfo());
    expect(first.result.current).toBeNull();
    expect(second.result.current).toBeNull();

    await act(async () => { pending.resolve(info()); await pending.promise; });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(first.result.current?.version).toBe('1.5.1');
    expect(second.result.current?.version).toBe('1.5.1');
  });

  it('caches a success for the session: a remount reads it without a request', async () => {
    const spy = vi.spyOn(api.instance, 'info').mockResolvedValue(info());

    const first = renderHook(() => useHomeInstanceInfo());
    await waitFor(() => expect(first.result.current).not.toBeNull());
    first.unmount();

    const again = renderHook(() => useHomeInstanceInfo());
    expect(again.result.current?.version).toBe('1.5.1');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves null after a failure and retries on the next mount', async () => {
    const spy = vi.spyOn(api.instance, 'info').mockRejectedValueOnce(new Error('offline'));

    const first = renderHook(() => useHomeInstanceInfo());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(first.result.current).toBeNull();
    first.unmount();

    spy.mockResolvedValueOnce(info({ version: '1.5.2' }));
    const again = renderHook(() => useHomeInstanceInfo());
    await waitFor(() => expect(again.result.current?.version).toBe('1.5.2'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not retry on its own while a failed subscriber stays mounted', async () => {
    const spy = vi.spyOn(api.instance, 'info').mockRejectedValue(new Error('offline'));

    const hook = renderHook(() => useHomeInstanceInfo());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    hook.rerender();
    expect(hook.result.current).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refetches at once on invalidate while subscribed', async () => {
    const spy = vi.spyOn(api.instance, 'info').mockResolvedValueOnce(info({ supportCardEnabled: true }));

    const hook = renderHook(() => useHomeInstanceInfo());
    await waitFor(() => expect(hook.result.current?.supportCardEnabled).toBe(true));

    spy.mockResolvedValueOnce(info({ supportCardEnabled: false }));
    act(() => { invalidateHomeInstanceInfo(); });

    await waitFor(() => expect(hook.result.current?.supportCardEnabled).toBe(false));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('only drops the cache on invalidate when nothing is subscribed; the next mount fetches', async () => {
    const spy = vi.spyOn(api.instance, 'info').mockResolvedValueOnce(info({ supportCardEnabled: true }));

    const first = renderHook(() => useHomeInstanceInfo());
    await waitFor(() => expect(first.result.current).not.toBeNull());
    first.unmount();

    invalidateHomeInstanceInfo();
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockResolvedValueOnce(info({ supportCardEnabled: false }));
    const again = renderHook(() => useHomeInstanceInfo());
    expect(again.result.current).toBeNull();
    await waitFor(() => expect(again.result.current?.supportCardEnabled).toBe(false));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('ignores an answer that was in flight when the cache was invalidated', async () => {
    const stale = deferred<InstanceInfoResponse>();
    const fresh = deferred<InstanceInfoResponse>();
    const spy = vi.spyOn(api.instance, 'info')
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    const hook = renderHook(() => useHomeInstanceInfo());
    act(() => { invalidateHomeInstanceInfo(); });
    expect(spy).toHaveBeenCalledTimes(2);

    await act(async () => { fresh.resolve(info({ supportCardEnabled: false })); await fresh.promise; });
    await act(async () => { stale.resolve(info({ supportCardEnabled: true })); await stale.promise; });

    expect(hook.result.current?.supportCardEnabled).toBe(false);
  });
});
