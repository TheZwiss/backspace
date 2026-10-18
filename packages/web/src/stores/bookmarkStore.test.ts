import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bookmark } from '@backspace/shared/src/bookmarks';

const list = vi.fn();
const keys = vi.fn();
const add = vi.fn();
const remove = vi.fn();
vi.mock('../utils/crossStoreResolvers', () => ({
  getApiForOrigin: () => ({ bookmarks: { list, keys, add, remove } }),
}));

const { bookmarkConversationKey, bookmarkKey, selectIsBookmarked, useBookmarkStore } = await import('./bookmarkStore');

const HOME = 'https://home.example';
const NOVA = 'https://nova.example';

function bookmark(over: Partial<Bookmark> & Pick<Bookmark, 'id'>): Bookmark {
  return {
    kind: 'channel', messageId: `m-${over.id}`, channelId: 'ch-1', spaceId: 'sp-1', content: 'text', authorId: 'u',
    authorName: 'U', spaceName: 'S', channelName: 'c', instanceOrigin: HOME, messageCreatedAt: 1, createdAt: 1,
    attachments: [], status: 'ok', ...over,
  } as Bookmark;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const isOn = (origin: string, id: string, kind: 'channel' | 'dm' = 'channel') =>
  selectIsBookmarked(useBookmarkStore.getState(), origin, kind, id);

beforeEach(() => {
  useBookmarkStore.getState().reset();
  list.mockReset();
  keys.mockReset();
  add.mockReset();
  remove.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('bookmarked messages of a conversation', () => {
  it('reads them once, per instance, and marks them', async () => {
    keys.mockResolvedValue(['m-1', 'm-2']);
    await useBookmarkStore.getState().loadConversation(HOME, 'channel', 'ch-1');
    await useBookmarkStore.getState().loadConversation(HOME, 'channel', 'ch-1');
    expect(keys).toHaveBeenCalledTimes(1);
    expect(isOn(HOME, 'm-1')).toBe(true);
    expect(isOn(NOVA, 'm-1')).toBe(false);
    expect(isOn(HOME, 'm-1', 'dm')).toBe(false);
    expect(isOn(HOME, 'm-3')).toBe(false);
  });

  it('does not start a second read while one is in flight', async () => {
    const pending = deferred<string[]>();
    keys.mockReturnValue(pending.promise);
    const first = useBookmarkStore.getState().loadConversation(HOME, 'channel', 'ch-1');
    const second = useBookmarkStore.getState().loadConversation(HOME, 'channel', 'ch-1');
    pending.resolve([]);
    await Promise.all([first, second]);
    expect(keys).toHaveBeenCalledTimes(1);
  });

  it('lays changes that arrived during the read over its answer', async () => {
    const pending = deferred<string[]>();
    keys.mockReturnValue(pending.promise);
    const read = useBookmarkStore.getState().loadConversation(HOME, 'channel', 'ch-1');
    useBookmarkStore.getState().applyAdded(HOME, bookmark({ id: 'b-new', messageId: 'm-new' }));
    useBookmarkStore.getState().applyRemoved(HOME, 'channel', 'ch-1', 'm-old');
    pending.resolve(['m-old']);
    await read;
    expect(isOn(HOME, 'm-new')).toBe(true);
    expect(isOn(HOME, 'm-old')).toBe(false);
  });

  it('leaves nothing marked and reads again on next use when the read fails', async () => {
    keys.mockRejectedValueOnce(new Error('down'));
    await useBookmarkStore.getState().loadConversation(HOME, 'channel', 'ch-1');
    expect(useBookmarkStore.getState().loadedConversations.size).toBe(0);
    keys.mockResolvedValueOnce(['m-1']);
    await useBookmarkStore.getState().loadConversation(HOME, 'channel', 'ch-1');
    expect(isOn(HOME, 'm-1')).toBe(true);
  });

  it('treats an instance without bookmarks (404) as having none marked, and does not ask again', async () => {
    vi.mocked(console.error).mockClear();
    keys.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    await useBookmarkStore.getState().loadConversation(NOVA, 'channel', 'ch-9');
    await useBookmarkStore.getState().loadConversation(NOVA, 'channel', 'ch-9');
    expect(keys).toHaveBeenCalledTimes(1);
    expect(useBookmarkStore.getState().loadedConversations.has(bookmarkConversationKey(NOVA, 'channel', 'ch-9'))).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('drops an answer that belongs to the previous session', async () => {
    const pending = deferred<string[]>();
    keys.mockReturnValue(pending.promise);
    const read = useBookmarkStore.getState().loadConversation(HOME, 'channel', 'ch-1');
    useBookmarkStore.getState().reset();
    pending.resolve(['m-1']);
    await read;
    expect(isOn(HOME, 'm-1')).toBe(false);
  });
});

describe('add and remove', () => {
  it('marks the message from the answer and lists the bookmark', async () => {
    list.mockResolvedValue({ items: [], nextCursor: null });
    await useBookmarkStore.getState().loadList([HOME]);
    add.mockResolvedValue(bookmark({ id: 'b-1', messageId: 'm-1' }));
    const saved = await useBookmarkStore.getState().add(HOME, 'channel', 'm-1');
    expect(saved.id).toBe('b-1');
    expect(isOn(HOME, 'm-1')).toBe(true);
    expect(useBookmarkStore.getState().lists.get(HOME)?.items.map((b) => b.id)).toEqual(['b-1']);
  });

  it('lists a bookmark once when the push repeats the answer', async () => {
    list.mockResolvedValue({ items: [], nextCursor: null });
    await useBookmarkStore.getState().loadList([HOME]);
    const saved = bookmark({ id: 'b-1', messageId: 'm-1' });
    add.mockResolvedValue(saved);
    await useBookmarkStore.getState().add(HOME, 'channel', 'm-1');
    useBookmarkStore.getState().applyAdded(HOME, saved);
    expect(useBookmarkStore.getState().lists.get(HOME)?.items).toHaveLength(1);
  });

  it('rejects with the API error and changes nothing', async () => {
    add.mockRejectedValue(new Error('nope'));
    await expect(useBookmarkStore.getState().add(HOME, 'channel', 'm-1')).rejects.toThrow('nope');
    expect(isOn(HOME, 'm-1')).toBe(false);
  });

  it('removes the mark and the list entry', async () => {
    list.mockResolvedValue({ items: [bookmark({ id: 'b-1', messageId: 'm-1' }), bookmark({ id: 'b-2', messageId: 'm-2' })], nextCursor: null });
    await useBookmarkStore.getState().loadList([HOME]);
    useBookmarkStore.getState().applyAdded(HOME, bookmark({ id: 'b-1', messageId: 'm-1' }));
    remove.mockResolvedValue({ success: true });
    await useBookmarkStore.getState().remove(HOME, 'channel', 'ch-1', 'm-1');
    expect(remove).toHaveBeenCalledWith('channel', 'm-1');
    expect(isOn(HOME, 'm-1')).toBe(false);
    expect(useBookmarkStore.getState().lists.get(HOME)?.items.map((b) => b.id)).toEqual(['b-2']);
  });

  it('keeps a channel message and a DM message with the same id apart', () => {
    useBookmarkStore.getState().applyAdded(HOME, bookmark({ id: 'b-1', messageId: 'same', kind: 'dm', channelId: 'dm-1' }));
    expect(isOn(HOME, 'same', 'dm')).toBe(true);
    expect(isOn(HOME, 'same', 'channel')).toBe(false);
  });
});

describe('the list', () => {
  it('reads one page per instance and appends the next page without repeats', async () => {
    list.mockResolvedValueOnce({ items: [bookmark({ id: 'b-3' }), bookmark({ id: 'b-2' })], nextCursor: '5:b-2' });
    await useBookmarkStore.getState().loadList([HOME]);
    expect(useBookmarkStore.getState().lists.get(HOME)).toMatchObject({ status: 'loaded', nextCursor: '5:b-2' });

    list.mockResolvedValueOnce({ items: [bookmark({ id: 'b-2' }), bookmark({ id: 'b-1' })], nextCursor: null });
    await useBookmarkStore.getState().loadMore(HOME);
    expect(list).toHaveBeenLastCalledWith({ cursor: '5:b-2', limit: 30 });
    const state = useBookmarkStore.getState().lists.get(HOME);
    expect(state?.items.map((b) => b.id)).toEqual(['b-3', 'b-2', 'b-1']);
    expect(state?.nextCursor).toBeNull();

    await useBookmarkStore.getState().loadMore(HOME);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('marks one instance as failed without touching the others', async () => {
    list.mockImplementation(async () => { throw new Error('down'); });
    list.mockResolvedValueOnce({ items: [bookmark({ id: 'b-1' })], nextCursor: null });
    await useBookmarkStore.getState().loadList([HOME, NOVA]);
    expect(useBookmarkStore.getState().lists.get(HOME)?.status).toBe('loaded');
    expect(useBookmarkStore.getState().lists.get(NOVA)?.status).toBe('error');
  });

  it('shows an instance that runs a version without bookmarks (404) as empty, not as failed', async () => {
    vi.mocked(console.error).mockClear();
    list.mockImplementation(async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); });
    list.mockResolvedValueOnce({ items: [bookmark({ id: 'b-1' })], nextCursor: null });
    await useBookmarkStore.getState().loadList([HOME, NOVA]);
    expect(useBookmarkStore.getState().lists.get(NOVA)).toEqual({ items: [], nextCursor: null, status: 'loaded', loadingMore: false });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('ignores an older read of the same instance that lands late', async () => {
    const slow = deferred<{ items: Bookmark[]; nextCursor: string | null }>();
    list.mockReturnValueOnce(slow.promise);
    const first = useBookmarkStore.getState().loadList([HOME]);
    list.mockResolvedValueOnce({ items: [bookmark({ id: 'b-fresh' })], nextCursor: null });
    await useBookmarkStore.getState().loadList([HOME]);
    slow.resolve({ items: [bookmark({ id: 'b-stale' })], nextCursor: null });
    await first;
    expect(useBookmarkStore.getState().lists.get(HOME)?.items.map((b) => b.id)).toEqual(['b-fresh']);
  });
});

describe('instances', () => {
  it('resync forgets what one instance said and leaves the others', async () => {
    keys.mockResolvedValue(['m-1']);
    await useBookmarkStore.getState().loadConversation(HOME, 'channel', 'ch-1');
    await useBookmarkStore.getState().loadConversation(NOVA, 'channel', 'ch-9');
    useBookmarkStore.getState().resync(HOME);
    expect(isOn(HOME, 'm-1')).toBe(false);
    expect(useBookmarkStore.getState().loadedConversations.has(bookmarkConversationKey(HOME, 'channel', 'ch-1'))).toBe(false);
    expect(useBookmarkStore.getState().keys.has(bookmarkKey(NOVA, 'channel', 'm-1'))).toBe(true);
  });

  it('forgetOrigin drops its list too', async () => {
    list.mockResolvedValue({ items: [bookmark({ id: 'b-1' })], nextCursor: null });
    await useBookmarkStore.getState().loadList([HOME, NOVA]);
    useBookmarkStore.getState().forgetOrigin(NOVA);
    expect(useBookmarkStore.getState().lists.has(NOVA)).toBe(false);
    expect(useBookmarkStore.getState().lists.has(HOME)).toBe(true);
  });
});
