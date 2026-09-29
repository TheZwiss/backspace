import React, { useRef, useState, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { EmojiPicker } from './EmojiPicker';
import { layoutPixels, layoutRect } from '../../platform/interfaceScale';

export interface ReactionPickerPopoverProps {
  anchorEl: HTMLElement | null;
  onEmojiSelect: (emoji: { native: string }) => void;
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;
const DEFAULT_PICKER_WIDTH = 360;
// Default estimated height covers the tabs header (~40px) + emoji picker (~400px) + padding.
const DEFAULT_PICKER_HEIGHT = 450;

/**
 * Floating reaction emoji/sticker picker for chat messages.
 * Positions next to the reaction button, flipping above when close to the viewport bottom
 * and clamping inside viewport bounds to prevent the bottom categories bar from clipping.
 */
export function ReactionPickerPopover({
  anchorEl,
  onEmojiSelect,
  onClose,
}: ReactionPickerPopoverProps) {
  const { t } = useTranslation('chat');
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; flipAbove: boolean }>({
    top: VIEWPORT_MARGIN,
    left: VIEWPORT_MARGIN,
    flipAbove: false,
  });

  const updatePosition = useCallback(() => {
    if (!anchorEl) return;
    const btnRect = layoutRect(anchorEl.getBoundingClientRect());
    const vh = layoutPixels(window.innerHeight);
    const vw = layoutPixels(window.innerWidth);

    // Measure actual rendered size if available to handle tab switching (Emoji vs Stickers),
    // otherwise fallback to safe defaults.
    const actualWidth = popoverRef.current
      ? layoutPixels(popoverRef.current.offsetWidth)
      : DEFAULT_PICKER_WIDTH;
    const actualHeight = popoverRef.current
      ? layoutPixels(popoverRef.current.offsetHeight)
      : DEFAULT_PICKER_HEIGHT;

    const pickerWidth = actualWidth || DEFAULT_PICKER_WIDTH;
    const pickerHeight = actualHeight || DEFAULT_PICKER_HEIGHT;

    const spaceBelow = vh - btnRect.bottom;
    const spaceAbove = btnRect.top;

    const fitsBelow = spaceBelow >= pickerHeight + VIEWPORT_MARGIN;
    const fitsAbove = spaceAbove >= pickerHeight + VIEWPORT_MARGIN;
    const flipAbove = !fitsBelow && (fitsAbove || spaceAbove > spaceBelow);

    let top = flipAbove
      ? btnRect.top - pickerHeight - VIEWPORT_MARGIN
      : btnRect.bottom + VIEWPORT_MARGIN;

    // Safety clamp: keep the entire popover vertically within the viewport bounds.
    // This prevents the bottom navigation buttons from being pushed off-screen when the message is near the bottom.
    const maxTop = Math.max(VIEWPORT_MARGIN, vh - pickerHeight - VIEWPORT_MARGIN);
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop));

    // Align right edge with reaction button and clamp within horizontal bounds.
    let left = btnRect.right - pickerWidth;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - pickerWidth - VIEWPORT_MARGIN));

    setCoords({ top, left, flipAbove });
  }, [anchorEl]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  // Re-check position when content size changes (e.g. switching between Emoji and Stickers tabs)
  useEffect(() => {
    const el = popoverRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      updatePosition();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [updatePosition]);

  // Update on window resize or scroll
  useEffect(() => {
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [anchorEl, onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!anchorEl) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t('message.reactions.picker')}
      className={`fixed z-[300] ${coords.flipAbove ? 'animate-slide-down' : 'animate-slide-up'}`}
      style={{
        top: coords.top,
        left: coords.left,
        maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
      }}
    >
      <div className="glass rounded-xl overflow-hidden max-h-[calc(100vh-16px)] flex flex-col">
        <EmojiPicker onEmojiSelect={onEmojiSelect} />
      </div>
    </div>,
    document.body,
  );
}
