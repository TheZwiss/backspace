import React from 'react';
import type { ContextMenuItem } from '../../stores/contextMenuStore';
import type { MessageWithUser } from '@backspace/shared';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮'];

interface MessageMenuParams {
  message: MessageWithUser;
  selectedText: string;
  previousMessageId: string | null;
  isAuthor: boolean;
  isDm: boolean;
  canAddReactions: boolean;
  canSendMessages: boolean;
  canManageMessages: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReaction: (emoji: string) => void;
  onOpenEmojiPicker: () => void;
  onMarkUnread: (messageId: string) => void;
}

export function buildMessageMenuItems(params: MessageMenuParams): ContextMenuItem[] {
  const {
    message,
    selectedText,
    previousMessageId,
    isAuthor,
    isDm,
    canAddReactions,
    canSendMessages,
    canManageMessages,
    onReply,
    onEdit,
    onDelete,
    onReaction,
    onOpenEmojiPicker,
    onMarkUnread,
  } = params;

  const items: ContextMenuItem[] = [];

  // ── Quick Reaction Row ──────────────────────────────────────────────────
  if (canAddReactions) {
    items.push({
      key: 'quick-reactions',
      type: 'custom',
      render: () => (
        <div className="flex items-center gap-1 px-2 py-1.5">
          {QUICK_EMOJIS.map(emoji => (
            <button
              key={emoji}
              onClick={(e) => {
                e.stopPropagation();
                onReaction(emoji);
              }}
              className="glass-pill w-9 h-9 flex items-center justify-center text-lg hover:bg-interactive-hover rounded-lg transition-colors"
            >
              {emoji}
            </button>
          ))}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenEmojiPicker();
            }}
            className="glass-pill w-9 h-9 flex items-center justify-center text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover rounded-lg transition-colors"
            title="Add reaction"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm1-13h-2v4H7v2h4v4h2v-4h4v-2h-4V7z" />
            </svg>
          </button>
        </div>
      ),
    });
    items.push({ key: 'reactions-sep', type: 'separator' });
  }

  // ── Reply ───────────────────────────────────────────────────────────────
  const canReply = isDm || canSendMessages;
  if (canReply) {
    items.push({
      key: 'reply',
      type: 'action',
      label: 'Reply',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M10 9V5L3 12L10 19V14.9C15 14.9 18.5 16.5 21 20C20 15 17 10 10 9Z" />
        </svg>
      ),
      onClick: onReply,
    });
    items.push({ key: 'reply-sep', type: 'separator' });
  }

  // ── Clipboard group ─────────────────────────────────────────────────────
  items.push({
    key: 'copy-selected',
    type: 'action',
    label: 'Copy Selected Text',
    hidden: selectedText.length === 0,
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
      </svg>
    ),
    onClick: () => {
      navigator.clipboard.writeText(selectedText);
    },
  });

  items.push({
    key: 'copy-text',
    type: 'action',
    label: 'Copy Text',
    hidden: !message.content,
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
      </svg>
    ),
    onClick: () => {
      navigator.clipboard.writeText(message.content ?? '');
    },
  });

  items.push({ key: 'clipboard-sep', type: 'separator' });

  // ── Mark Unread ─────────────────────────────────────────────────────────
  items.push({
    key: 'mark-unread',
    type: 'action',
    label: 'Mark Unread',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" />
        <circle cx="12" cy="12" r="5" />
      </svg>
    ),
    onClick: () => {
      // '0' sentinel marks the entire channel as unread (when no previous message exists)
      onMarkUnread(previousMessageId ?? '0');
    },
  });

  items.push({ key: 'unread-sep', type: 'separator' });

  // ── Edit Message (author only) ──────────────────────────────────────────
  if (isAuthor) {
    items.push({
      key: 'edit',
      type: 'action',
      label: 'Edit Message',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
        </svg>
      ),
      onClick: onEdit,
    });
  }

  // ── Delete Message (author or moderator) ────────────────────────────────
  const canDelete = isAuthor || canManageMessages;
  if (canDelete) {
    items.push({
      key: 'delete',
      type: 'action',
      label: 'Delete Message',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
        </svg>
      ),
      onClick: onDelete,
      danger: true,
    });
  }

  return items;
}
