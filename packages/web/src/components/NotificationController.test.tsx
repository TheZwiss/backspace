import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { DmChannel, MessageWithUser, User } from '@backspace/shared';
import { NotificationController } from './NotificationController';
import { sendNotification } from '../platform/notifications';
import { useAuthStore } from '../stores/authStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useChatStore } from '../stores/chatStore';
import { useUIStore } from '../stores/uiStore';

vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

class BrowserNotification {
  static permission = 'granted';
  static instances: BrowserNotification[] = [];
  onclick?: () => void;
  close = vi.fn();
  constructor(public title: string) { BrowserNotification.instances.push(this); }
}

function Location() {
  return <output data-testid="route">{useLocation().pathname}</output>;
}

function mount() {
  return render(<MemoryRouter initialEntries={['/channels/other/old']}>
    <NotificationController /><Location />
  </MemoryRouter>);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Notification', BrowserNotification);
  BrowserNotification.instances = [];
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  useAuthStore.setState({ user: { id: 'me' } as User });
  useSpaceStore.setState({
    channelToSpaceMap: new Map([['remote-chat', 'remote-space']]),
    channelOriginMap: new Map([['remote-chat', 'https://remote.example']]),
    dmChannels: [{ id: 'dm' } as DmChannel],
  });
  useChatStore.setState({ realtimeMessageEvents: [] });
  useUIStore.setState({ isMobile: false, mobileStack: [] });
});

afterEach(() => {
  cleanup();
  delete window.backspace;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('notification clicks', () => {
  it.each([
    ['dm', undefined, '/channels/@me/dm'],
    ['remote-chat', 'remote-space', '/channels/remote-space/remote-chat'],
  ])('opens %s through the router and closes the browser notification', (channelId, spaceId, route) => {
    const view = mount();
    sendNotification('Message', 'Hello', { channelId, spaceId, userId: 'me' });
    const notification = BrowserNotification.instances[0]!;
    act(() => notification.onclick?.());
    expect(view.getByTestId('route')).toHaveTextContent(route);
    expect(window.focus).toHaveBeenCalled();
    expect(notification.close).toHaveBeenCalledOnce();
  });

  it('routes an Electron click and removes its IPC listener on unmount', () => {
    const off = vi.fn();
    let click: ((options: { channelId: string; userId: string }) => void) | undefined;
    window.backspace = {
      onNotificationClick: vi.fn(callback => { click = callback; return off; }),
      onWindowFocusChange: vi.fn(), showNotification: vi.fn(), setBadgeCount: vi.fn(),
    } as unknown as NonNullable<Window['backspace']>;
    const view = mount();
    sendNotification('Message', 'Hello', { channelId: 'dm', userId: 'me' });
    expect(window.backspace.showNotification).toHaveBeenCalledWith('Message', 'Hello', { channelId: 'dm', userId: 'me' });
    act(() => click?.({ channelId: 'dm', userId: 'me' }));
    expect(view.getByTestId('route')).toHaveTextContent('/channels/@me/dm');
    view.unmount();
    expect(off.mock.calls.length).toBe(vi.mocked(window.backspace.onNotificationClick!).mock.calls.length);
  });

  it('supports an older Electron bridge without the click API', () => {
    window.backspace = { onWindowFocusChange: vi.fn() } as unknown as NonNullable<Window['backspace']>;
    expect(() => mount().unmount()).not.toThrow();
  });

  it.each([
    { channelId: 'deleted', userId: 'me' },
    { channelId: 'dm', userId: 'previous-account' },
    { channelId: 'remote-chat', spaceId: 'wrong-space', userId: 'me' },
  ])('ignores stale context %j', options => {
    const view = mount();
    sendNotification('Message', 'Hello', options);
    act(() => BrowserNotification.instances[0]!.onclick?.());
    expect(view.getByTestId('route')).toHaveTextContent('/channels/other/old');
  });

  it('brings the mobile chat back above settings without duplicate chat entries', () => {
    useUIStore.setState({ isMobile: true, mobileStack: [{ screen: 'settings' }] });
    mount();
    sendNotification('Message', 'Hello', { channelId: 'dm', userId: 'me' });
    act(() => BrowserNotification.instances[0]!.onclick?.());
    act(() => BrowserNotification.instances[0]!.onclick?.());
    expect(useUIStore.getState().mobileStack).toEqual([
      { screen: 'settings' }, { screen: 'channel-chat', params: { channelId: 'dm', spaceId: '@me' } },
    ]);
  });

  it('keeps notifying once the 50-event buffer is full, retaining the remote space', () => {
    const oldEvents = Array.from({ length: 50 }, (_, i) => ({
      channelId: 'remote-chat', message: { id: String(i) } as MessageWithUser,
    }));
    useChatStore.setState({ realtimeMessageEvents: oldEvents });
    const view = mount();
    act(() => vi.advanceTimersByTime(1000));
    act(() => useChatStore.setState({ realtimeMessageEvents: [...oldEvents.slice(1), {
      channelId: 'remote-chat',
      message: { id: 'new', channelId: 'remote-chat', userId: 'other', content: 'Hello' } as MessageWithUser,
    }] }));
    expect(BrowserNotification.instances).toHaveLength(1);
    act(() => BrowserNotification.instances[0]!.onclick?.());
    expect(view.getByTestId('route')).toHaveTextContent('/channels/remote-space/remote-chat');
  });
});
