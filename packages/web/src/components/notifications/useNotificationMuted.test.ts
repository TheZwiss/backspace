import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MUTED_FOREVER } from '@backspace/shared';
import { useNotificationMuted } from './useNotificationMuted';
import { useNotificationStore } from '../../stores/notificationStore';
vi.mock('../../utils/crossStoreResolvers', () => ({ getApiForOrigin: vi.fn() }));
vi.mock('../../stores/spaceStore', () => ({ useSpaceStore: (selector: (s: unknown) => unknown) => selector({ channelToSpaceMap: new Map([['channel', 'space']]) }) }));
const target = { origin: '', targetType: 'channel' as const, targetId: 'channel' };
const setting = { targetType: 'space' as const, targetId: 'space', level: null, mutedUntil: 2000, suppressEveryone: false, suppressRoles: false };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); useNotificationStore.getState().reset(); });
afterEach(() => vi.useRealTimers());
it('inherits parent mute and redraws at expiry without new messages', () => {
  useNotificationStore.getState().apply('', setting);
  const { result } = renderHook(() => useNotificationMuted(target));
  expect(result.current).toBe(true);
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current).toBe(false);
});
it('keeps permanent mute until a synchronized setting clears it', () => {
  useNotificationStore.getState().apply('', { ...setting, mutedUntil: MUTED_FOREVER });
  const { result } = renderHook(() => useNotificationMuted(target));
  act(() => vi.advanceTimersByTime(86400000));
  expect(result.current).toBe(true);
  act(() => useNotificationStore.getState().apply('', { ...setting, mutedUntil: null }));
  expect(result.current).toBe(false);
});
