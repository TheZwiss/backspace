import React from 'react';
import type { ContextMenuItem } from '../../stores/contextMenuStore';
import type { MessageWithUser } from '@backspace/shared';
import { saveImage, copyImageToClipboard } from '../../utils/imageActions';
import { useUIStore } from '../../stores/uiStore';

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
  imageUrl?: string | null;
  sourceUrl?: string | null;
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
    imageUrl,
    sourceUrl,
  } = params;

  const items: ContextMenuItem[] = [];

  // ── Image Actions (when right-clicking an image) ──────────────────────
  if (imageUrl) {
    items.push({
      key: 'save-image',
      type: 'action',
      label: 'Save Image',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
        </svg>
      ),
      onClick: () => saveImage(imageUrl),
    });
    items.push({
      key: 'copy-image',
      type: 'action',
      label: 'Copy Image',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 9v10c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2h7l6 6zm-2 1h-5V4H8v15h11V10zM3 15V3c0-1.1.9-2 2-2h9v2H5v12H3z" />
        </svg>
      ),
      onClick: () => {
        copyImageToClipboard(imageUrl);
      },
    });
    items.push({
      key: 'open-original',
      type: 'action',
      label: 'Open Original',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
        </svg>
      ),
      onClick: () => {
        window.open(imageUrl, '_blank', 'noopener');
      },
    });
    items.push({ key: 'image-sep', type: 'separator' });
  }

  // ── Link Actions (when URL text is suppressed) ──────────────────────
  if (sourceUrl) {
    items.push({
      key: 'copy-link',
      type: 'action',
      label: 'Copy Link',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z" />
        </svg>
      ),
      onClick: () => {
        navigator.clipboard.writeText(sourceUrl);
        useUIStore.getState().addToast('Copied link', 'success', 3000);
      },
    });
    items.push({
      key: 'open-link',
      type: 'action',
      label: 'Open Link',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
        </svg>
      ),
      onClick: () => {
        window.open(sourceUrl, '_blank', 'noopener');
      },
    });
    items.push({ key: 'link-sep', type: 'separator' });
  }

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
        <path d="M3 5h2V3c-1.1 0-2 .9-2 2zm0 8h2v-2H3v2zm4 8h2v-2H7v2zM3 9h2V7H3v2zm10-6h-2v2h2V3zm6 0v2h2c0-1.1-.9-2-2-2zM5 21v-2H3c0 1.1.9 2 2 2zm-2-4h2v-2H3v2zM9 3H7v2h2V3zm2 18h2v-2h-2v2zm8-8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2zm0-12h2V7h-2v2zm0 8h2v-2h-2v2zm-4 4h2v-2h-2v2zm0-16h2V3h-2v2z" />
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
    hidden: !message.content || !!sourceUrl,
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
