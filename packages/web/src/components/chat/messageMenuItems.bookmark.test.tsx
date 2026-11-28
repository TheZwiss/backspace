import { describe, expect, it, vi } from 'vitest';
import type { MessageWithUser } from '@backspace/shared';

// jsdom has no AudioWorkletNode; the menu's imports reach the voice stack.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
vi.mock('../../i18n', () => ({ default: { t: (key: string) => key } }));

const { buildMessageMenuItems } = await import('./messageMenuItems');

const message = { id: 'm-1', channelId: 'ch-1', content: 'hello', type: 'user', createdAt: 1 } as unknown as MessageWithUser;

function build(over: { canBookmark?: boolean; isBookmarked?: boolean; onToggleBookmark?: () => void }) {
  return buildMessageMenuItems({
    message,
    selectedText: '',
    previousMessageId: null,
    isAuthor: false,
    isDm: false,
    canAddReactions: false,
    canSendMessages: false,
    canManageMessages: false,
    onReply: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onReaction: () => {},
    onOpenEmojiPicker: () => {},
    onMarkUnread: () => {},
    canBookmark: over.canBookmark ?? true,
    isBookmarked: over.isBookmarked ?? false,
    onToggleBookmark: over.onToggleBookmark ?? (() => {}),
  });
}

describe('message menu: bookmark', () => {
  it('offers to bookmark a message that is not bookmarked', () => {
    const item = build({}).find((i) => i.key === 'bookmark');
    expect(item).toMatchObject({ type: 'action', label: 'bookmarks:menu.add' });
  });

  it('offers to remove the bookmark of one that is', () => {
    const item = build({ isBookmarked: true }).find((i) => i.key === 'bookmark');
    expect(item).toMatchObject({ label: 'bookmarks:menu.remove' });
  });

  it('runs the toggle when chosen', () => {
    const toggle = vi.fn();
    const item = build({ onToggleBookmark: toggle }).find((i) => i.key === 'bookmark');
    if (!item || item.type !== 'action') throw new Error('no bookmark item');
    item.onClick();
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('leaves the item out for a message that cannot be bookmarked', () => {
    expect(build({ canBookmark: false }).some((i) => i.key === 'bookmark')).toBe(false);
  });
});
