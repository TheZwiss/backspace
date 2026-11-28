import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

const pushMobileScreen = vi.fn();
const ui = { isMobile: false, mobileStack: [] as Array<{ screen: string; params?: Record<string, string> }>, pushMobileScreen };
const chat = { currentChannelId: null as string | null };
let spaces: Array<{ id: string }> = [];

vi.mock('../i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('../stores/spaceStore', () => ({
  resolveDmChannelId: (rawId: string) => rawId,
  useSpaceStore: { getState: () => ({ spaces }) },
}));
vi.mock('../stores/uiStore', () => ({ useUIStore: { getState: () => ({ ...ui, addToast: vi.fn() }) } }));
vi.mock('../stores/chatStore', () => ({ useChatStore: { getState: () => chat } }));

const { useJumpStore } = await import('../stores/jumpStore');
const { useJumpNavigation } = await import('./useJumpNavigation');

function setup() {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={['/channels/@me']}>{children}</MemoryRouter>;
  return renderHook(() => { useJumpNavigation(); return useLocation().pathname; }, { wrapper });
}

describe('useJumpNavigation', () => {
  beforeEach(() => {
    spaces = [{ id: 'sp-1' }];
    ui.isMobile = false;
    ui.mobileStack = [];
    chat.currentChannelId = null;
    pushMobileScreen.mockClear();
    useJumpStore.setState({ request: null });
  });

  it('writes the route of the requested conversation', () => {
    const { result } = setup();
    act(() => { useJumpStore.getState().requestJump({ kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' }, 'm-1'); });
    expect(result.current).toBe('/channels/sp-1/ch-1');
    expect(pushMobileScreen).not.toHaveBeenCalled();
  });

  it('routes a DM through @me', () => {
    const { result } = setup();
    act(() => { useJumpStore.getState().requestJump({ kind: 'dm', channelId: 'dm-1' }, 'm-1'); });
    expect(result.current).toBe('/channels/@me/dm-1');
  });

  it('leaves the route alone when that channel is already open', () => {
    chat.currentChannelId = 'ch-1';
    const { result } = setup();
    act(() => { useJumpStore.getState().requestJump({ kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' }, 'm-1'); });
    expect(result.current).toBe('/channels/@me');
  });

  it('on a phone also pushes the chat screen, unless it is already on top', () => {
    ui.isMobile = true;
    const { result } = setup();
    act(() => { useJumpStore.getState().requestJump({ kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' }, 'm-1'); });
    expect(result.current).toBe('/channels/sp-1/ch-1');
    expect(pushMobileScreen).toHaveBeenCalledWith('channel-chat', { channelId: 'ch-1', spaceId: 'sp-1' });

    pushMobileScreen.mockClear();
    ui.mobileStack = [{ screen: 'channel-chat', params: { channelId: 'ch-1', spaceId: 'sp-1' } }];
    act(() => { useJumpStore.getState().requestJump({ kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' }, 'm-2'); });
    expect(pushMobileScreen).not.toHaveBeenCalled();
  });
});
