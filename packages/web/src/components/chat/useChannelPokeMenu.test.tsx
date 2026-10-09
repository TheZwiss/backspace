import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import type { ContextMenuItem } from '../../stores/contextMenuStore';
const mocks = vi.hoisted(() => ({ open: vi.fn(), send: vi.fn(), toast: vi.fn() }));
vi.mock('../../stores/contextMenuStore', () => ({ useContextMenuStore: { getState: () => ({ open: mocks.open }) } }));
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: mocks.toast }) } }));
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: mocks.send }));
import { useChannelPokeStore } from './channelPokeStore';
import { useChannelPokeMenu } from './useChannelPokeMenu';
const options = { channelId: 'chat', targetUserId: 'target', origin: 'https://host.test', enabled: true, pending: false };
function openMenu(change = {}) {
  const { result } = renderHook(() => useChannelPokeMenu({ ...options, ...change }));
  result.current({ preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 5, clientY: 6 } as unknown as MouseEvent);
  return mocks.open.mock.calls[0]![1] as ContextMenuItem[];
}
beforeEach(() => { vi.clearAllMocks(); useChannelPokeStore.getState().reset(); });
describe('poke-only author menu', () => {
  it('disables unsupported hosts and DMs without adding other feature actions', () => {
    const items = openMenu();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'poke-author', disabled: true });
    mocks.open.mockClear(); useChannelPokeStore.getState().setHost(options.origin, true);
    expect(openMenu({ enabled: false })[0]).toMatchObject({ disabled: true });
  });
  it('sends to the serving host and exposes a disconnected socket', () => {
    useChannelPokeStore.getState().setHost(options.origin, true);
    const item = openMenu()[0];
    if (item?.type !== 'action') throw Error('Expected poke action');
    expect(item.disabled).toBe(false);
    mocks.send.mockReturnValue(false); item.onClick();
    expect(mocks.send).toHaveBeenCalledWith({ type: 'channel_poke', channelId: 'chat', targetUserId: 'target' }, options.origin);
    expect(mocks.toast).toHaveBeenCalled();
  });
});
