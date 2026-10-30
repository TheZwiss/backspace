import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const addToast = vi.fn();
const resolveDm = vi.fn<(rawId: string) => string | null>();
let spaces: Array<{ id: string }> = [];

vi.mock('../i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('./spaceStore', () => ({
  resolveDmChannelId: (rawId: string) => resolveDm(rawId),
  useSpaceStore: { getState: () => ({ spaces }) },
}));
vi.mock('./uiStore', () => ({
  useUIStore: { getState: () => ({ addToast }) },
}));

const { JUMP_REQUEST_TTL_MS, useActiveJump, useJumpStore } = await import('./jumpStore');

describe('jumpStore', () => {
  beforeEach(() => {
    spaces = [{ id: 'sp-1' }];
    useJumpStore.setState({ request: null });
    addToast.mockClear();
    resolveDm.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('records a jump into a channel of a space the user belongs to', () => {
    const ok = useJumpStore.getState().requestJump({ kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' }, 'm-1');
    expect(ok).toBe(true);
    expect(useJumpStore.getState().request).toMatchObject({ spaceId: 'sp-1', channelId: 'ch-1', messageId: 'm-1' });
    expect(addToast).not.toHaveBeenCalled();
  });

  it('refuses a space the user is not in, with the "message unavailable" toast', () => {
    const ok = useJumpStore.getState().requestJump({ kind: 'channel', spaceId: 'sp-gone', channelId: 'ch-1' }, 'm-1');
    expect(ok).toBe(false);
    expect(useJumpStore.getState().request).toBeNull();
    expect(addToast).toHaveBeenCalledWith('chat:list.jump.unavailable', 'info', 4000);
  });

  it('opens a DM through the row it is pinned to, whichever copy\'s id was given', () => {
    resolveDm.mockReturnValue('dm-pinned');
    const ok = useJumpStore.getState().requestJump({ kind: 'dm', channelId: 'dm-copy' }, 'm-9');
    expect(ok).toBe(true);
    expect(resolveDm).toHaveBeenCalledWith('dm-copy');
    expect(useJumpStore.getState().request).toMatchObject({ spaceId: '@me', channelId: 'dm-pinned', messageId: 'm-9' });
  });

  it('refuses a DM that is not in the list', () => {
    resolveDm.mockReturnValue(null);
    expect(useJumpStore.getState().requestJump({ kind: 'dm', channelId: 'dm-x' }, 'm-9')).toBe(false);
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it('gives a second request for the same message its own sequence number', () => {
    const target = { kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' } as const;
    useJumpStore.getState().requestJump(target, 'm-1');
    const first = useJumpStore.getState().request?.seq;
    useJumpStore.getState().requestJump(target, 'm-1');
    expect(useJumpStore.getState().request?.seq).not.toBe(first);
  });

  it('clearJump drops the request', () => {
    useJumpStore.getState().requestJump({ kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' }, 'm-1');
    useJumpStore.getState().clearJump();
    expect(useJumpStore.getState().request).toBeNull();
  });

  describe('useActiveJump', () => {
    it('hands the message only to the list of the requested channel', () => {
      useJumpStore.getState().requestJump({ kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' }, 'm-1');
      expect(renderHook(() => useActiveJump('ch-1')).result.current).toBe('m-1');
      expect(renderHook(() => useActiveJump('ch-2')).result.current).toBeNull();
      expect(renderHook(() => useActiveJump(null)).result.current).toBeNull();
    });

    it('stops offering a request nobody took in time', () => {
      vi.useFakeTimers();
      useJumpStore.getState().requestJump({ kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' }, 'm-1');
      vi.advanceTimersByTime(JUMP_REQUEST_TTL_MS + 1);
      expect(renderHook(() => useActiveJump('ch-1')).result.current).toBeNull();
    });
  });
});
