import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel } from '@backspace/shared';
import { useChannelActivityStore } from '../../stores/channelActivityStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { DmUnreadBadge } from './DmUnreadBadge';
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn() }));
beforeEach(() => {
  useChannelActivityStore.getState().reset();
  useSpaceStore.setState({ dmChannels: [{ id: 'a' }, { id: 'b' }] as DmChannel[], channelOriginMap: new Map([['b', 'remote']]) });
  useChatStore.setState({ unreadChannels: new Set(['a', 'b']) });
});
describe('DM unread message badge', () => {
  it('sums only canonical conversations from their serving origin', () => {
    useChannelActivityStore.getState().hydrate('', { counts: { a: 3, b: 999, mirror: 3 } });
    useChannelActivityStore.getState().hydrate('remote', { counts: { b: 5, a: 999 } });
    render(<DmUnreadBadge />);
    expect(screen.getByText('8')).toHaveClass('bg-red-500');
  });
  it('caps at 99+ and clears once read', () => {
    useChannelActivityStore.getState().hydrate('', { counts: { a: 100 } });
    const view = render(<DmUnreadBadge />);
    expect(screen.getByText('99+')).toBeInTheDocument();
    view.unmount();
    useChatStore.setState({ unreadChannels: new Set() });
    expect(render(<DmUnreadBadge />).container).toBeEmptyDOMElement();
  });
  it('does not fabricate counts when the host has no snapshot', () => {
    expect(render(<DmUnreadBadge />).container).toBeEmptyDOMElement();
  });
});
