import { useTranslation } from 'react-i18next';
import { StickerPicker } from './StickerPicker';
import { layoutRect, layoutPixels } from '../../platform/interfaceScale';
import React, { useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { EmojiPicker } from './EmojiPicker';
import { GifPicker } from './GifPicker';
import { useUIStore } from '../../stores/uiStore';
import { useDragToClose } from '../../hooks/useDragToClose';

export type InputPopoverTab = 'emoji' | 'gif' | 'sticker';

interface InputPopoverProps {
  activeTab: InputPopoverTab;
  onClose: () => void;
  onEmojiSelect: (emoji: { native: string }) => void;
  onGifSelect: (url: string) => void;
  onStickerSelect: (token: string) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  gifEnabled: boolean;
  onTabChange: (tab: InputPopoverTab) => void;
}

interface SharedTabProps {
  activeTab: InputPopoverTab;
  availableTabs: { key: InputPopoverTab; label: string }[];
  onTabChange: (tab: InputPopoverTab) => void;
}

function HeartIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}

function TabBar({ activeTab, availableTabs, onTabChange }: SharedTabProps) {
  if (availableTabs.length <= 1) return null;
  return (
    <div className="flex items-center gap-0.5 px-2 pt-2 pb-1">
      {availableTabs.map((t) => {
        const isSticker = t.key === 'sticker';
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onTabChange(t.key)}
            title={t.label}
            aria-label={t.label}
            className={`flex items-center justify-center rounded-md font-medium transition-colors ${
              isSticker ? 'px-2.5 py-1' : 'px-3 py-1 text-[13px]'
            } ${
              activeTab === t.key
                ? 'bg-interactive-selected text-txt-primary'
                : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
            }`}
          >
            {isSticker ? <HeartIcon className="w-4 h-4" /> : t.label}
          </button>
        );
      })}
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
  onStickerSelect,
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

    const anchorRect = layoutRect(anchor.getBoundingClientRect());
    const floatingRect = layoutRect(floating.getBoundingClientRect());
    const vw = layoutPixels(window.innerWidth);
    const vh = layoutPixels(window.innerHeight);

    let left = anchorRect.right - floatingRect.width;
    let top = anchorRect.top - floatingRect.height - 8;

    // Flip below if no room above
    if (top < 8) {
      top = anchorRect.bottom + 8;
    }

    // A short viewport must keep the confirmation footer reachable after flipping.
    top = Math.max(8, Math.min(top, vh - floatingRect.height - 8));
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
      <div className={`glass rounded-xl overflow-hidden flex flex-col w-fit ${activeTab === 'sticker' ? 'max-h-[min(500px,calc(100*var(--app-dvh)-24px))]' : 'max-h-[435px]'}`}>
        <TabBar activeTab={activeTab} availableTabs={availableTabs} onTabChange={onTabChange} />
        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {activeTab === 'emoji' && <EmojiPicker stickers={false} onEmojiSelect={onEmojiSelect} />}
          {activeTab === 'sticker' && <StickerPicker onSelect={onStickerSelect} />}
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
  onStickerSelect,
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

  // Drag-down-to-close. Only the handle + tab-bar area receives the touch;
  // the picker grids manage their own scrolling and must not be hijacked.
  // `hasInteracted` flips true on the first touchstart and stays true — we
  // use it to suppress the `animate-slide-up-sheet` keyframe from re-running
  // during snap-back / close-out, which would otherwise fight the inline
  // transform the hook is animating.
  const { sheetStyle, handleProps, hasInteracted } = useDragToClose({ onClose });

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
        className={`fixed left-0 right-0 z-[301] rounded-t-2xl glass-modal flex flex-col ${
          hasInteracted ? '' : 'animate-slide-up-sheet'
        }`}
        style={{
          // Sit at the bottom of the visible viewport. On iOS 16.4+ the
          // `keyboard-inset-height` env var lifts us above the soft keyboard;
          // on older iOS the 100dvh-based MobileShell layout already shrinks
          // the visual viewport when the keyboard is open, so bottom:0 lands
          // just above the keyboard naturally.
          bottom: 'var(--keyboard-inset)',
          paddingBottom: 'var(--safe-bottom)',
          maxHeight: 'min(calc(60*var(--app-dvh)), calc(60*var(--app-vh)))',
          ...sheetStyle,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        {/* Drag handle + tab bar — both belong to the "header" drag area.
            Spreading `handleProps` here means the user can grab anywhere in
            this top region (handle pill, padding around it, tab buttons'
            interstitial space) to dismiss; tab buttons themselves still
            receive their own clicks because clicks aren't blocked, only
            vertical drag past the dead-zone is. */}
        <div {...handleProps} className="shrink-0 touch-none">
          <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1" />
          <TabBar activeTab={activeTab} availableTabs={availableTabs} onTabChange={onTabChange} />
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {activeTab === 'emoji' && <EmojiPicker stickers={false} onEmojiSelect={onEmojiSelect} mobile />}
          {activeTab === 'sticker' && <StickerPicker onSelect={onStickerSelect} mobile />}
          {activeTab === 'gif' && gifEnabled && <GifPicker onGifSelect={onGifSelect} mobile />}
        </div>
      </div>
    </>,
    document.body,
  );
}

export function InputPopover(props: InputPopoverProps) {
  const { t } = useTranslation('chat');
  const isMobile = useUIStore((s) => s.isMobile);

  const availableTabs: { key: InputPopoverTab; label: string }[] = [
    { key: 'emoji', label: 'Emoji' },
    { key: 'sticker', label: t('stickers.title') },
  ];
  if (props.gifEnabled) {
    availableTabs.splice(0, 0, { key: 'gif', label: 'GIF' });
  }

  if (isMobile) {
    return <MobileSheet {...props} availableTabs={availableTabs} />;
  }
  return <DesktopPopover {...props} availableTabs={availableTabs} />;
}
