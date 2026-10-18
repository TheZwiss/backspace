import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const addToast = vi.fn();
const list = vi.fn();
const remove = vi.fn();
const requestJump = vi.fn();
let userViews = new Map<string, unknown>();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { name?: string; reason?: string }) => (options?.name ? `${key}:${options.name}` : key) }),
}));
vi.mock('../../i18n/errors', () => ({ describeError: () => 'boom' }));
vi.mock('../../i18n/formatters', () => ({
  useFormatters: () => ({ formatDateTime: (ts: number) => `dt${ts}`, formatBytes: (n: number) => `${n}B` }),
}));
vi.mock('../../utils/stickerMessages', () => ({ messageTextForPreview: (text: string) => text }));
vi.mock('../ui/Avatar', () => ({
  Avatar: ({ name, src }: { name: string; src?: string }) => <span data-testid="avatar" data-src={src ?? ''}>{name}</span>,
}));
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast }) } }));
vi.mock('../../stores/jumpStore', () => ({ useJumpStore: { getState: () => ({ requestJump }) } }));
vi.mock('../../stores/instanceStore', () => ({
  useInstanceStore: (select: (state: { instances: { origin: string; status: string }[] }) => unknown) => select({ instances: [] }),
}));
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: (select: (state: { userViews: Map<string, unknown> }) => unknown) => select({ userViews }),
}));
vi.mock('../../utils/crossStoreResolvers', () => ({
  getApiForOrigin: () => ({ bookmarks: { list, remove } }),
}));

const { BookmarkList } = await import('./BookmarkList');
const { useBookmarkStore } = await import('../../stores/bookmarkStore');

const ORIGIN = 'https://home.example';

function bookmark(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind: 'channel', messageId: `m-${id}`, channelId: 'ch-1', spaceId: 'sp-1', content: `text ${id}`, authorId: 'u-1',
    authorName: 'Saved Name', spaceName: 'Space', channelName: 'general', instanceOrigin: ORIGIN, messageCreatedAt: 5,
    createdAt: Number(id.replace('b', '')), attachments: [], status: 'ok', ...extra,
  };
}

beforeEach(() => {
  useBookmarkStore.getState().reset();
  [addToast, list, remove, requestJump].forEach((fn) => fn.mockReset());
  userViews = new Map();
});

describe('BookmarkList', () => {
  it('shows where each bookmark came from, newest saved first', async () => {
    list.mockResolvedValue({ items: [bookmark('b1'), bookmark('b2')], nextCursor: null });
    render(<BookmarkList />);
    await screen.findByText('text b2');
    const texts = screen.getAllByText(/^text b/).map((el) => el.textContent);
    expect(texts).toEqual(['text b2', 'text b1']);
    expect(screen.getAllByText('home.example · Space · general')).toHaveLength(2);
    expect(screen.getAllByText('dt5')).toHaveLength(2);
  });

  it('draws the author live when the client knows them, and by the saved name otherwise', async () => {
    userViews = new Map([['k', { deliveredBy: '', user: { id: 'u-1', username: 'alice', displayName: 'Alice', avatar: 'a.png', avatarColor: null, homeUserId: null } }]]);
    list.mockResolvedValue({ items: [bookmark('b1')], nextCursor: null });
    render(<BookmarkList />);
    await screen.findByText('text b1');
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    expect(screen.getByTestId('avatar').getAttribute('data-src')).toBe('a.png');
  });

  it('warns about a deleted original and keeps the saved text', async () => {
    list.mockResolvedValue({ items: [bookmark('b1', { status: 'deleted' })], nextCursor: null });
    render(<BookmarkList />);
    await screen.findByText('status.deleted');
    expect(screen.getByText('text b1')).toBeTruthy();
  });

  it('lists attachments by name and marks a deleted file', async () => {
    const attachment = { id: 'a1', originalName: 'photo.png', mimetype: 'image/png', size: 10, width: null, height: null, duration: null, playable: null, state: 'gone', filename: null, thumbnailFilename: null };
    list.mockResolvedValue({ items: [bookmark('b1', { attachments: [attachment] })], nextCursor: null });
    render(<BookmarkList />);
    await screen.findByText('photo.png');
    expect(screen.getByText('attachment.gone')).toBeTruthy();
  });

  it('opens the original message and tells its holder', async () => {
    requestJump.mockReturnValue(true);
    const onOpened = vi.fn();
    list.mockResolvedValue({ items: [bookmark('b1')], nextCursor: null });
    render(<BookmarkList onOpened={onOpened} />);
    fireEvent.click(await screen.findByLabelText('list.open:Saved Name'));
    expect(requestJump).toHaveBeenCalledWith({ kind: 'channel', spaceId: 'sp-1', channelId: 'ch-1' }, 'm-b1');
    expect(onOpened).toHaveBeenCalled();
  });

  it('opens a DM bookmark by its channel only, and stays open when the jump is refused', async () => {
    requestJump.mockReturnValue(false);
    const onOpened = vi.fn();
    list.mockResolvedValue({ items: [bookmark('b1', { kind: 'dm', spaceId: null })], nextCursor: null });
    render(<BookmarkList onOpened={onOpened} />);
    fireEvent.click(await screen.findByLabelText('list.open:Saved Name'));
    expect(requestJump).toHaveBeenCalledWith({ kind: 'dm', channelId: 'ch-1' }, 'm-b1');
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('removes a bookmark from the list', async () => {
    remove.mockResolvedValue({ success: true });
    list.mockResolvedValue({ items: [bookmark('b1')], nextCursor: null });
    render(<BookmarkList />);
    fireEvent.click(await screen.findByLabelText('list.remove'));
    await waitFor(() => expect(screen.queryByText('text b1')).toBeNull());
    expect(remove).toHaveBeenCalledWith('channel', 'm-b1');
    expect(screen.getByText('list.empty')).toBeTruthy();
  });

  it('toasts when removing fails and keeps the row', async () => {
    remove.mockRejectedValue(new Error('x'));
    list.mockResolvedValue({ items: [bookmark('b1')], nextCursor: null });
    render(<BookmarkList />);
    fireEvent.click(await screen.findByLabelText('list.remove'));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith('toast.removeFailed', 'warning'));
    expect(screen.getByText('text b1')).toBeTruthy();
  });

  it('reads the next page on request', async () => {
    list.mockResolvedValueOnce({ items: [bookmark('b2')], nextCursor: 'c1' });
    list.mockResolvedValueOnce({ items: [bookmark('b1')], nextCursor: null });
    render(<BookmarkList />);
    fireEvent.click(await screen.findByText('list.showMore'));
    await screen.findByText('text b1');
    expect(list).toHaveBeenLastCalledWith({ cursor: 'c1', limit: 30 });
    expect(screen.queryByText('list.showMore')).toBeNull();
  });

  it('leaves out an instance that did not answer, without an error message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    list.mockRejectedValue(new Error('down'));
    render(<BookmarkList />);
    await screen.findByText('list.empty');
    expect(screen.queryByText('list.error')).toBeNull();
    expect(screen.queryByText('list.retry')).toBeNull();
  });
});
