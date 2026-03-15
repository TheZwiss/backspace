import React, { useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { EmojiPicker } from './EmojiPicker';
import { GifPicker } from './GifPicker';
import { StickerPicker } from './StickerPicker';
import type { Sticker } from '@backspace/shared';

export type InputPopoverTab = 'emoji' | 'gif' | 'stickers';

interface InputPopoverProps {
  activeTab: InputPopoverTab;
  onClose: () => void;
  onEmojiSelect: (emoji: { native: string }) => void;
  onGifSelect: (url: string) => void;
  onStickerSelect: (sticker: Sticker) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  gifEnabled: boolean;
  stickersEnabled: boolean;
  onTabChange: (tab: InputPopoverTab) => void;
}

export function InputPopover({
  activeTab,
  onClose,
  onEmojiSelect,
  onGifSelect,
  onStickerSelect,
  anchorRef,
  gifEnabled,
  stickersEnabled,
  onTabChange,
}: InputPopoverProps) {
  const floatingRef = useRef<HTMLDivElement>(null);

  // Position above the anchor
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    if (!anchor || !floating) return;

    const anchorRect = anchor.getBoundingClientRect();
    const floatingRect = floating.getBoundingClientRect();
    const vw = window.innerWidth;

    let left = anchorRect.right - floatingRect.width;
    let top = anchorRect.top - floatingRect.height - 8;

    // Flip below if no room above
    if (top < 8) {
      top = anchorRect.bottom + 8;
    }

    // Clamp horizontal
    left = Math.max(8, Math.min(left, vw - floatingRect.width - 8));

    floating.style.top = `${top}px`;
    floating.style.left = `${left}px`;
  }, [anchorRef]);

  useEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition, activeTab]);

  // Re-position after the picker renders (it may change height)
  useEffect(() => {
    const frame = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(frame);
  }, [activeTab, updatePosition]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const floating = floatingRef.current;
      const anchor = anchorRef.current;
      if (!floating) return;
      if (floating.contains(e.target as Node)) return;
      if (anchor && anchor.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, anchorRef]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const availableTabs: { key: InputPopoverTab; label: string }[] = [
    { key: 'emoji', label: 'Emoji' },
  ];
  if (gifEnabled) {
    availableTabs.splice(0, 0, { key: 'gif', label: 'GIF' });
  }
  if (stickersEnabled) {
    availableTabs.push({ key: 'stickers', label: 'Stickers' });
  }

  const showTabs = availableTabs.length > 1;

  return createPortal(
    <div
      ref={floatingRef}
      className="fixed z-[300] animate-slide-up"
      style={{ top: -9999, left: -9999 }}
    >
      <div className="glass rounded-xl overflow-hidden flex flex-col" style={{ width: 352, maxHeight: 435 }}>
        {/* Tab bar */}
        {showTabs && (
          <div className="flex items-center gap-0.5 px-2 pt-2 pb-1">
            {availableTabs.map((t) => (
              <button
                key={t.key}
                onClick={() => onTabChange(t.key)}
                className={`px-3 py-1 rounded-md text-[13px] font-medium transition-colors ${
                  activeTab === t.key
                    ? 'bg-interactive-selected text-txt-primary'
                    : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === 'emoji' && (
            <EmojiPicker onEmojiSelect={onEmojiSelect} />
          )}
          {activeTab === 'gif' && gifEnabled && (
            <GifPicker onGifSelect={onGifSelect} />
          )}
          {activeTab === 'stickers' && stickersEnabled && (
            <StickerPicker onStickerSelect={onStickerSelect} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
