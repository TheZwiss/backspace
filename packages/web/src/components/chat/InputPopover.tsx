import React, { useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { EmojiPicker } from './EmojiPicker';
import { GifPicker } from './GifPicker';
import { useUIStore } from '../../stores/uiStore';

export type InputPopoverTab = 'emoji' | 'gif';

interface InputPopoverProps {
  activeTab: InputPopoverTab;
  onClose: () => void;
  onEmojiSelect: (emoji: { native: string }) => void;
  onGifSelect: (url: string) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  gifEnabled: boolean;
  onTabChange: (tab: InputPopoverTab) => void;
}

interface SharedTabProps {
  activeTab: InputPopoverTab;
  availableTabs: { key: InputPopoverTab; label: string }[];
  onTabChange: (tab: InputPopoverTab) => void;
}

function TabBar({ activeTab, availableTabs, onTabChange }: SharedTabProps) {
  if (availableTabs.length <= 1) return null;
  return (
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
  );
}

interface DesktopPopoverProps extends InputPopoverProps {
  availableTabs: { key: InputPopoverTab; label: string }[];
}

function DesktopPopover({
  activeTab,
  onClose,
  onEmojiSelect,
  onGifSelect,
  anchorRef,
  gifEnabled,
  onTabChange,
  availableTabs,
}: DesktopPopoverProps) {
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

  return createPortal(
    <div
      ref={floatingRef}
      className="fixed z-[300] animate-slide-up"
      style={{ top: -9999, left: -9999 }}
    >
      <div className="glass rounded-xl overflow-hidden flex flex-col w-fit max-h-[435px]">
        <TabBar activeTab={activeTab} availableTabs={availableTabs} onTabChange={onTabChange} />
        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === 'emoji' && <EmojiPicker onEmojiSelect={onEmojiSelect} />}
          {activeTab === 'gif' && gifEnabled && <GifPicker onGifSelect={onGifSelect} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface MobileSheetProps extends InputPopoverProps {
  availableTabs: { key: InputPopoverTab; label: string }[];
}

function MobileSheet({
  activeTab,
  onClose,
  onEmojiSelect,
  onGifSelect,
  gifEnabled,
  onTabChange,
  availableTabs,
}: MobileSheetProps) {
  // Escape to close (parity with desktop)
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

  return createPortal(
    <>
      {/* Backdrop — single tap (mousedown OR touchstart) closes */}
      <div
        className="fixed inset-0 z-[300] bg-black/30"
        onMouseDown={onClose}
        onTouchStart={onClose}
      />
      {/* Sheet */}
      <div
        className="fixed left-0 right-0 z-[301] rounded-t-2xl glass-modal animate-slide-up-sheet flex flex-col"
        style={{
          // Sit at the bottom of the visible viewport. On iOS 16.4+ the
          // `keyboard-inset-height` env var lifts us above the soft keyboard;
          // on older iOS the 100dvh-based MobileShell layout already shrinks
          // the visual viewport when the keyboard is open, so bottom:0 lands
          // just above the keyboard naturally.
          bottom: 'env(keyboard-inset-height, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          maxHeight: 'min(60dvh, 60vh)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1 shrink-0" />

        {/* Tab bar (only when multiple tabs available) */}
        <TabBar activeTab={activeTab} availableTabs={availableTabs} onTabChange={onTabChange} />

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {activeTab === 'emoji' && <EmojiPicker onEmojiSelect={onEmojiSelect} mobile />}
          {activeTab === 'gif' && gifEnabled && <GifPicker onGifSelect={onGifSelect} mobile />}
        </div>
      </div>
    </>,
    document.body,
  );
}

export function InputPopover(props: InputPopoverProps) {
  const isMobile = useUIStore((s) => s.isMobile);

  const availableTabs: { key: InputPopoverTab; label: string }[] = [
    { key: 'emoji', label: 'Emoji' },
  ];
  if (props.gifEnabled) {
    availableTabs.splice(0, 0, { key: 'gif', label: 'GIF' });
  }

  if (isMobile) {
    return <MobileSheet {...props} availableTabs={availableTabs} />;
  }
  return <DesktopPopover {...props} availableTabs={availableTabs} />;
}
