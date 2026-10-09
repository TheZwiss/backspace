import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Space } from '@backspace/shared';
import { useChannelActivityStore } from '../../stores/channelActivityStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useNotificationSettingsStore } from '../../stores/notificationSettingsStore';
import { SpaceUnreadBadge } from './SpaceUnreadBadge';
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
beforeEach(() => {
  useChannelActivityStore.getState().reset();
  useNotificationSettingsStore.getState().reset();
  useSpaceStore.setState({ spaces: [{ id: 'space' } as Space], channelToSpaceMap: new Map([['a', 'space'], ['b', 'space'], ['c', 'other']]) });
  useChatStore.setState({ unreadChannels: new Set(['a', 'b', 'c']) });
});
describe('space unread message badge', () => {
  it('sums message counts, not unread channels, and caps display at 99+', () => {
    useChannelActivityStore.getState().hydrate('', { counts: { a: 80, b: 25, c: 999 } });
    render(<SpaceUnreadBadge spaceId="space" />);
    expect(screen.getByText('99+')).toHaveClass('bg-red-500');
  });
  it('excludes already-read channels', () => {
    useChannelActivityStore.getState().hydrate('', { counts: { a: 3, b: 4 } });
    useChatStore.setState({ unreadChannels: new Set(['a']) });
    render(<SpaceUnreadBadge spaceId="space" />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });
  it('shows a gray badge when muted without changing unread state', () => {
    useChannelActivityStore.getState().hydrate('', { counts: { a: 7 } });
    useNotificationSettingsStore.getState().apply('', { spaceId: 'space', channelId: null, level: null, muted: true, mutedUntil: Date.now() + 60000, updatedAt: Date.now() });
    render(<SpaceUnreadBadge spaceId="space" />);
    expect(screen.getByText('7')).toHaveClass('bg-gray-500');
    expect(screen.getByText('7')).not.toHaveClass('bg-red-500');
    expect(useChannelActivityStore.getState().counts[''].a).toBe(7);
    expect(useChatStore.getState().unreadChannels.has('a')).toBe(true);
  });
  it('does not invent a count for an older host', () => {
    useChannelActivityStore.getState().hydrate('', {});
    expect(render(<SpaceUnreadBadge spaceId="space" />).container).toBeEmptyDOMElement();
  });
});
