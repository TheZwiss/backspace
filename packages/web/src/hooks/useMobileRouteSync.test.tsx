import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../stores/uiStore';
import { useMobileRouteSync } from './useMobileRouteSync';

afterEach(() => { cleanup(); useUIStore.setState({ mobileStack: [] }); });
const route = '/channels/space/channel';
const chat = { screen: 'channel-chat', params: { spaceId: 'space', channelId: 'channel' } };
const settings = { screen: 'settings-appearance' };

describe('mobile route reconstruction', () => {
  it.each([false, true])('restores chat below settings and back returns to chat (StrictMode=%s)', strict => {
    useUIStore.setState({ mobileStack: [settings] });
    renderHook(() => useMobileRouteSync(route), {
      wrapper: strict ? StrictMode : undefined,
    });
    expect(useUIStore.getState().mobileStack).toEqual([chat, settings]);
    act(() => useUIStore.getState().popMobileScreen());
    expect(useUIStore.getState().mobileStack).toEqual([chat]);
  });
  it('does not duplicate an existing route under settings', () => {
    useUIStore.setState({ mobileStack: [chat, settings] });
    renderHook(() => useMobileRouteSync(route), { wrapper: StrictMode });
    expect(useUIStore.getState().mobileStack).toEqual([chat, settings]);
  });
  it('pushes a changed route once and does not cover unrelated screens on stack updates', () => {
    useUIStore.setState({ mobileStack: [chat] });
    const { rerender } = renderHook(({ path }) => useMobileRouteSync(path), {
      initialProps: { path: route }, wrapper: StrictMode,
    });
    rerender({ path: '/channels/@me/dm' });
    expect(useUIStore.getState().mobileStack).toEqual([
      chat, { screen: 'channel-chat', params: { spaceId: '@me', channelId: 'dm' } },
    ]);
    act(() => useUIStore.getState().pushMobileScreen('user-profile'));
    rerender({ path: '/channels/@me/dm' });
    expect(useUIStore.getState().mobileStack.at(-1)?.screen).toBe('user-profile');
  });
});
