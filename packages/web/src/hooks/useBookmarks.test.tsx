import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const addToast = vi.fn();
const list = vi.fn();
const keys = vi.fn();
const add = vi.fn();
const remove = vi.fn();
let channelOrigins = new Map<string, string>();
const dmIds = new Set<string>();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { reason?: string }) => (options?.reason ? `${key}:${options.reason}` : key) }),
}));
vi.mock('../i18n/errors', () => ({ describeError: (err: unknown) => (err instanceof Error ? err.message : 'generic') }));
vi.mock('../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast }) } }));
vi.mock('../stores/spaceStore', () => ({
  isDmChannel: (channelId: string) => dmIds.has(channelId),
  useSpaceStore: (select: (state: { channelOriginMap: Map<string, string> }) => unknown) => select({ channelOriginMap: channelOrigins }),
}));
vi.mock('../utils/crossStoreResolvers', () => ({
  getApiForOrigin: () => ({ bookmarks: { list, keys, add, remove } }),
}));

const { bookmarkKindOf, useBookmarkedConversation, useMessageBookmark } = await import('./useBookmarks');
const { useBookmarkStore } = await import('../stores/bookmarkStore');

const HOME = 'https://home.example';

function saved(messageId: string, kind: 'channel' | 'dm' = 'channel') {
  return {
    id: `b-${messageId}`, kind, messageId, channelId: 'ch-1', spaceId: 'sp-1', content: 'x', authorId: 'u', authorName: 'U',
    spaceName: 'S', channelName: 'c', instanceOrigin: HOME, messageCreatedAt: 1, createdAt: 1, attachments: [], status: 'ok' as const,
  };
}

beforeEach(() => {
  useBookmarkStore.getState().reset();
  [addToast, list, keys, add, remove].forEach((fn) => fn.mockReset());
  channelOrigins = new Map([['ch-1', HOME], ['dm-1', HOME]]);
  dmIds.clear();
  dmIds.add('dm-1');
});

describe('bookmarkKindOf', () => {
  it('names the table a conversation\'s messages are in', () => {
    expect(bookmarkKindOf('ch-1')).toBe('channel');
    expect(bookmarkKindOf('dm-1')).toBe('dm');
  });
});

describe('useBookmarkedConversation', () => {
  it('reads the conversation\'s bookmarked messages once its origin is known', async () => {
    keys.mockResolvedValue(['m-1']);
    renderHook(() => useBookmarkedConversation('ch-1'));
    await waitFor(() => expect(keys).toHaveBeenCalledWith('channel', 'ch-1'));
    await waitFor(() => expect(useBookmarkStore.getState().loadedConversations.size).toBe(1));
    expect(keys).toHaveBeenCalledTimes(1);
  });

  it('asks the DM table for a DM', async () => {
    keys.mockResolvedValue([]);
    renderHook(() => useBookmarkedConversation('dm-1'));
    await waitFor(() => expect(keys).toHaveBeenCalledWith('dm', 'dm-1'));
  });

  it('reads the conversations of the page\'s own instance, whose origin is the empty string', async () => {
    channelOrigins = new Map([['ch-1', '']]);
    keys.mockResolvedValue(['m-1']);
    renderHook(() => useBookmarkedConversation('ch-1'));
    await waitFor(() => expect(keys).toHaveBeenCalledWith('channel', 'ch-1'));
    await waitFor(() => expect(useBookmarkStore.getState().loadedConversations.size).toBe(1));
  });

  it('does nothing for a channel whose instance is unknown', () => {
    channelOrigins = new Map();
    renderHook(() => useBookmarkedConversation('ch-1'));
    expect(keys).not.toHaveBeenCalled();
  });

  it('reads again after the instance\'s socket reconnected', async () => {
    keys.mockResolvedValue([]);
    renderHook(() => useBookmarkedConversation('ch-1'));
    await waitFor(() => expect(useBookmarkStore.getState().loadedConversations.size).toBe(1));
    act(() => useBookmarkStore.getState().resync(HOME));
    await waitFor(() => expect(keys).toHaveBeenCalledTimes(2));
  });
});

describe('useMessageBookmark', () => {
  const params = { origin: HOME, channelId: 'ch-1', messageId: 'm-1' };

  it('saves an unbookmarked message and then shows it as bookmarked', async () => {
    add.mockResolvedValue(saved('m-1'));
    const { result } = renderHook(() => useMessageBookmark(params));
    expect(result.current.bookmarked).toBe(false);
    await act(() => result.current.toggle());
    expect(add).toHaveBeenCalledWith('channel', 'm-1');
    expect(result.current.bookmarked).toBe(true);
  });

  it('removes the bookmark of a bookmarked message', async () => {
    useBookmarkStore.getState().applyAdded(HOME, saved('m-1'));
    remove.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useMessageBookmark(params));
    expect(result.current.bookmarked).toBe(true);
    await act(() => result.current.toggle());
    expect(remove).toHaveBeenCalledWith('channel', 'm-1');
    expect(result.current.bookmarked).toBe(false);
  });

  it('uses the DM table for a DM message', async () => {
    add.mockResolvedValue(saved('m-1', 'dm'));
    const { result } = renderHook(() => useMessageBookmark({ ...params, channelId: 'dm-1' }));
    await act(() => result.current.toggle());
    expect(add).toHaveBeenCalledWith('dm', 'm-1');
  });

  it('shows the reason as a toast when saving fails, and leaves the message unmarked', async () => {
    add.mockRejectedValue(new Error('too slow'));
    const { result } = renderHook(() => useMessageBookmark(params));
    await act(() => result.current.toggle());
    expect(addToast).toHaveBeenCalledWith('toast.addFailed:too slow', 'warning');
    expect(result.current.bookmarked).toBe(false);
    expect(result.current.busy).toBe(false);
  });

  it('shows the removal toast when removing fails, and keeps the mark', async () => {
    useBookmarkStore.getState().applyAdded(HOME, saved('m-1'));
    remove.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useMessageBookmark(params));
    await act(() => result.current.toggle());
    expect(addToast).toHaveBeenCalledWith('toast.removeFailed:offline', 'warning');
    expect(result.current.bookmarked).toBe(true);
  });

  it('ignores a second click while the first request is in flight', async () => {
    let finish!: () => void;
    add.mockReturnValue(new Promise((resolve) => { finish = () => resolve(saved('m-1')); }));
    const { result } = renderHook(() => useMessageBookmark(params));
    let first!: Promise<void>;
    act(() => { first = result.current.toggle(); });
    await act(() => result.current.toggle());
    expect(add).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    finish();
    await act(() => first);
    expect(result.current.busy).toBe(false);
  });

  it('does nothing while the message\'s instance is unknown', async () => {
    const { result } = renderHook(() => useMessageBookmark({ ...params, origin: undefined }));
    expect(result.current.bookmarked).toBe(false);
    await act(() => result.current.toggle());
    expect(add).not.toHaveBeenCalled();
  });

  it('works on the page\'s own instance, whose origin is the empty string', async () => {
    add.mockResolvedValue(saved('m-1'));
    const { result } = renderHook(() => useMessageBookmark({ ...params, origin: '' }));
    await act(() => result.current.toggle());
    expect(add).toHaveBeenCalledWith('channel', 'm-1');
    expect(result.current.bookmarked).toBe(true);
  });
});
