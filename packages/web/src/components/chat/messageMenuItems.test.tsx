import { describe, expect, it, vi } from 'vitest';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn(), playSound: vi.fn(() => Promise.resolve(null)) }) },
}));

import { buildMessageMenuItems } from './messageMenuItems';
import type { MessageWithUser } from '@backspace/shared';

const baseMessage: MessageWithUser = {
  id: 'msg-1',
  channelId: 'ch-1',
  userId: 'user-1',
  content: 'Hello world',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  user: {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
  },
};

const defaultParams = {
  message: baseMessage,
  selectedText: '',
  previousMessageId: null,
  isAuthor: false,
  isDm: false,
  canAddReactions: false,
  canSendMessages: true,
  canManageMessages: false,
  onReply: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onReaction: vi.fn(),
  onOpenEmojiPicker: vi.fn(),
  onMarkUnread: vi.fn(),
};

describe('messageMenuItems translation actions', () => {
  it('shows translate action when not translated', () => {
    const onTranslate = vi.fn();
    const items = buildMessageMenuItems({
      ...defaultParams,
      onTranslate,
    });
    const translateItem = items.find((i) => i.key === 'translate');
    expect(translateItem).toBeDefined();
    if (translateItem && translateItem.type === 'action') {
      translateItem.onClick();
      expect(onTranslate).toHaveBeenCalledTimes(1);
    }
  });

  it('shows collapse/expand translation in showOriginal mode (WeChat style)', () => {
    const toggleCollapse = vi.fn();
    // 1. Not collapsed -> shows collapseTranslation
    const expandedItems = buildMessageMenuItems({
      ...defaultParams,
      translationStatus: {
        isTranslated: true,
        showOriginal: true,
        isCollapsed: false,
        toggleCollapse,
      },
    });
    const collapseItem = expandedItems.find((i) => i.key === 'collapse-translation');
    expect(collapseItem).toBeDefined();
    if (collapseItem && collapseItem.type === 'action') {
      collapseItem.onClick();
      expect(toggleCollapse).toHaveBeenCalledTimes(1);
    }

    // 2. Collapsed -> shows expandTranslation
    const collapsedItems = buildMessageMenuItems({
      ...defaultParams,
      translationStatus: {
        isTranslated: true,
        showOriginal: true,
        isCollapsed: true,
        toggleCollapse,
      },
    });
    const expandItem = collapsedItems.find((i) => i.key === 'expand-translation');
    expect(expandItem).toBeDefined();
    if (expandItem && expandItem.type === 'action') {
      expandItem.onClick();
      expect(toggleCollapse).toHaveBeenCalledTimes(2);
    }
  });

  it('shows cancelTranslation / translate in replace mode (Telegram style)', () => {
    const toggleCollapse = vi.fn();
    // 1. Showing translation -> shows cancelTranslation
    const translatingItems = buildMessageMenuItems({
      ...defaultParams,
      translationStatus: {
        isTranslated: true,
        showOriginal: false,
        isCollapsed: false,
        toggleCollapse,
      },
    });
    const cancelItem = translatingItems.find((i) => i.key === 'cancel-translation');
    expect(cancelItem).toBeDefined();
    if (cancelItem && cancelItem.type === 'action') {
      cancelItem.onClick();
      expect(toggleCollapse).toHaveBeenCalledTimes(1);
    }

    // 2. Viewing original -> shows translate
    const viewingOriginalItems = buildMessageMenuItems({
      ...defaultParams,
      translationStatus: {
        isTranslated: true,
        showOriginal: false,
        isCollapsed: true,
        toggleCollapse,
      },
    });
    const translateAgainItem = viewingOriginalItems.find((i) => i.key === 'translate');
    expect(translateAgainItem).toBeDefined();
    if (translateAgainItem && translateAgainItem.type === 'action') {
      translateAgainItem.onClick();
      expect(toggleCollapse).toHaveBeenCalledTimes(2);
    }
  });
});
