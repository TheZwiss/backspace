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
import { useVoiceStore } from '../stores/voiceStore';
import { setLanguage } from '../i18n';

vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

class BrowserNotification {
  static permission = 'granted';
  static instances: BrowserNotification[] = [];
  onclick?: () => void;
  close = vi.fn();
  body: string | undefined;
  constructor(public title: string, public options?: { body?: string }) {
    this.body = options?.body;
    BrowserNotification.instances.push(this);
  }
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
  useAuthStore.setState({ myRowIds: new Map() });
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
    useAuthStore.getState().recordMyRow('https://remote.example', 'remote-me');
    const view = mount();
    act(() => vi.advanceTimersByTime(1000));
    act(() => useChatStore.setState({ realtimeMessageEvents: [...oldEvents.slice(1), {
      channelId: 'remote-chat',
      message: { id: 'new', channelId: 'remote-chat', userId: 'other', content: 'Hello <@remote-me>' } as MessageWithUser,
    }] }));
    expect(BrowserNotification.instances).toHaveLength(1);
    act(() => BrowserNotification.instances[0]!.onclick?.());
    expect(view.getByTestId('route')).toHaveTextContent('/channels/remote-space/remote-chat');
  });

  it('opens the DM a notification was raised for, although a DM message has no channelId of its own (#332)', () => {
    const view = mount();
    act(() => vi.advanceTimersByTime(1000));
    // A DM message as the server sends it: `dmChannelId`, no `channelId`.
    const message = { id: 'dm-1', dmChannelId: 'dm', userId: 'other', content: 'hi' } as unknown as MessageWithUser;
    act(() => useChatStore.setState({ realtimeMessageEvents: [{ channelId: 'dm', message }] }));
    expect(BrowserNotification.instances).toHaveLength(1);
    act(() => BrowserNotification.instances[0]!.onclick?.());
    expect(view.getByTestId('route')).toHaveTextContent('/channels/@me/dm');
  });

  it('shows emoji shortcodes in the notification text as emoji (issue #252)', () => {
    mount();
    act(() => vi.advanceTimersByTime(1000));
    act(() => useChatStore.setState({ realtimeMessageEvents: [{
      channelId: 'dm',
      message: { id: 'emoji', channelId: 'dm', userId: 'other', content: 'on fire :heart_on_fire:' } as MessageWithUser,
    }] }));
    expect(BrowserNotification.instances[0]!.options?.body).toBe('on fire ❤️‍🔥');
  });

  it('leaves shortcodes inside code spans unconverted in the notification text', () => {
    mount();
    act(() => vi.advanceTimersByTime(1000));
    act(() => useChatStore.setState({ realtimeMessageEvents: [{
      channelId: 'dm',
      message: { id: 'code', channelId: 'dm', userId: 'other', content: 'type `:smile:` for :smile:' } as MessageWithUser,
    }] }));
    // The notification strips Markdown punctuation (backticks, underscores) after conversion.
    expect(BrowserNotification.instances[0]!.options?.body).toBe('type :smile: for 😄');
  });
});

describe('which messages raise a notification (#317)', () => {
  const event = (id: string, channelId: string, content: string, userId = 'other') => ({
    channelId,
    message: { id, channelId, userId, content } as MessageWithUser,
  });

  function mountSettled(status: 'online' | 'dnd' = 'online') {
    useAuthStore.setState({ user: { id: 'me', status } as User });
    useSpaceStore.setState({
      channelToSpaceMap: new Map([['general', 'home-space'], ['remote-chat', 'remote-space']]),
      channelOriginMap: new Map([['remote-chat', 'https://remote.example'], ['remote-dm', 'https://remote.example']]),
      dmChannels: [{ id: 'dm' } as DmChannel, { id: 'remote-dm' } as DmChannel],
    });
    useAuthStore.getState().recordMyRow('https://remote.example', 'remote-me');
    mount();
    act(() => vi.advanceTimersByTime(1000));
  }

  it('raises none for a space channel message that does not mention the user', () => {
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [event('m1', 'general', 'Hello everyone')] }));
    expect(BrowserNotification.instances).toHaveLength(0);
  });

  it('raises one for a DM', () => {
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [event('m1', 'dm', 'Hello')] }));
    expect(BrowserNotification.instances).toHaveLength(1);
  });

  it('raises one for a space channel message that mentions the user', () => {
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [event('m1', 'general', 'Look <@me>')] }));
    expect(BrowserNotification.instances).toHaveLength(1);
  });

  it('raises one for a mention by the id the user has on a remote instance', () => {
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [event('m1', 'remote-chat', 'Look <@remote-me>')] }));
    expect(BrowserNotification.instances).toHaveLength(1);
  });

  it('raises none for the user\'s own message in a remote DM', () => {
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [event('m1', 'remote-dm', 'Hi', 'remote-me')] }));
    expect(BrowserNotification.instances).toHaveLength(0);
  });

  it('looks past a non-alerting message to an alerting one in the same batch', () => {
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [
      event('m1', 'general', 'Hello everyone'),
      event('m2', 'general', 'Look <@me>'),
    ] }));
    expect(BrowserNotification.instances).toHaveLength(1);
  });

  it('is not widened by the "play sound for every message" preference', () => {
    useVoiceStore.setState({ messageSoundAllChannels: true });
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [event('m1', 'general', 'Hello everyone')] }));
    expect(BrowserNotification.instances).toHaveLength(0);
    useVoiceStore.setState({ messageSoundAllChannels: false });
  });

  it('withholds a mention on Do Not Disturb, as the sound does', () => {
    mountSettled('dnd');
    act(() => useChatStore.setState({ realtimeMessageEvents: [event('m1', 'general', 'Look <@me>')] }));
    expect(BrowserNotification.instances).toHaveLength(0);
  });
});

describe('Do Not Disturb', () => {
  const incoming = (id: string, channelId = 'dm') => ({
    channelId,
    message: { id, channelId, userId: 'other', content: 'Hello' } as MessageWithUser,
  });

  function mountSettled() {
    const view = mount();
    act(() => vi.advanceTimersByTime(1000));
    return view;
  }

  it.each([
    ['online', 1],
    ['idle', 1],
    ['dnd', 0],
  ] as const)('raises %s message notifications: %i', (status, expected) => {
    useAuthStore.setState({ user: { id: 'me', status } as User });
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [incoming('m1')] }));
    expect(BrowserNotification.instances).toHaveLength(expected);
  });

  it('reads the status the user set on the home account, not a remote copy', () => {
    // A message on a remote instance's channel: the remote holds its own
    // replicated view of this user, but the decision follows the home account.
    useAuthStore.setState({ user: { id: 'me', status: 'dnd' } as User });
    useSpaceStore.setState({
      userViews: new Map([['me', {
        user: { id: 'remote-me', homeUserId: 'me', status: 'online' } as User,
        deliveredBy: 'https://remote.example',
        isHome: false,
        updatedAt: 1,
      }]]),
    });
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [incoming('m1', 'remote-chat')] }));
    expect(BrowserNotification.instances).toHaveLength(0);
  });

  it('follows a status change made while the app is running', () => {
    useAuthStore.setState({ user: { id: 'me', status: 'dnd' } as User });
    mountSettled();
    act(() => useChatStore.setState({ realtimeMessageEvents: [incoming('m1')] }));
    expect(BrowserNotification.instances).toHaveLength(0);
    act(() => useAuthStore.setState({ user: { id: 'me', status: 'online' } as User }));
    act(() => useChatStore.setState({ realtimeMessageEvents: [incoming('m1'), incoming('m2')] }));
    expect(BrowserNotification.instances).toHaveLength(1);
  });

  it('suppresses the incoming call notification on dnd and raises it otherwise', () => {
    useAuthStore.setState({ user: { id: 'me', status: 'dnd' } as User });
    mountSettled();
    const call = { dmChannelId: 'dm', callerId: 'other', callerName: 'Other' };
    act(() => useVoiceStore.setState({ incomingCall: call }));
    expect(BrowserNotification.instances).toHaveLength(0);
    act(() => useVoiceStore.setState({ incomingCall: null }));
    act(() => useAuthStore.setState({ user: { id: 'me', status: 'online' } as User }));
    act(() => useVoiceStore.setState({ incomingCall: { ...call } }));
    expect(BrowserNotification.instances).toHaveLength(1);
    act(() => useVoiceStore.setState({ incomingCall: null }));
  });

  it('keeps the unread badge counting on dnd', () => {
    useAuthStore.setState({ user: { id: 'me', status: 'dnd' } as User });
    const setBadgeCount = vi.fn();
    window.backspace = {
      onNotificationClick: vi.fn(() => () => {}), onWindowFocusChange: vi.fn(),
      showNotification: vi.fn(), setBadgeCount,
    } as unknown as NonNullable<Window['backspace']>;
    mountSettled();
    act(() => useChatStore.setState({
      realtimeMessageEvents: [incoming('m1')], unreadChannels: new Set(['dm']),
    }));
    expect(window.backspace.showNotification).not.toHaveBeenCalled();
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
  });
});

describe('notification text follows the selected language', () => {
  afterEach(async () => {
    await setLanguage('en');
  });

  async function mountInGerman() {
    await setLanguage('de');
    useAuthStore.setState({ user: { id: 'me', status: 'online' } as User });
    mount();
    act(() => vi.advanceTimersByTime(1000));
  }

  it('names an unknown sender and an attachment-only message in German', async () => {
    await mountInGerman();
    act(() => useChatStore.setState({ realtimeMessageEvents: [{
      channelId: 'dm',
      message: { id: 'm1', channelId: 'dm', userId: 'other', content: '' } as MessageWithUser,
    }] }));
    expect(BrowserNotification.instances.map(n => [n.title, n.body])).toEqual([
      ['Jemand', 'Hat einen Anhang gesendet'],
    ]);
  });

  it('announces an incoming call in German', async () => {
    await mountInGerman();
    act(() => useVoiceStore.setState({ incomingCall: { dmChannelId: 'dm', callerId: 'other', callerName: 'Olle' } }));
    expect(BrowserNotification.instances.map(n => [n.title, n.body])).toEqual([
      ['Eingehender Anruf', 'Olle ruft dich an'],
    ]);
    act(() => useVoiceStore.setState({ incomingCall: null }));
  });
});
