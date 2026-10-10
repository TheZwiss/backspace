import { useTranslation } from 'react-i18next';
import { StickerPicker } from './StickerPicker';
import React, { useRef, useEffect, useState } from 'react';
import Picker from '@emoji-mart/react';
import { loadEmojiData } from '../../utils/emojiData';

interface EmojiPickerProps {
  onEmojiSelect: (emoji: { native: string }) => void;
  /**
   * Mobile rendering: stretch the picker to fill its container width
   * (the parent bottom-sheet provides the viewport-wide bounds), use
   * larger touch targets, and let the picker's own scroll area expand
   * to consume the available height of the sheet.
   */
  mobile?: boolean;
  stickers?: boolean;
}

function HeartIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}

export function EmojiPicker({ onEmojiSelect, mobile = false, stickers = true }: EmojiPickerProps) {
  const { t } = useTranslation('chat');
  const [showStickers, setShowStickers] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Prevent keyboard events from bubbling out (e.g. Enter submitting the chat input)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const stop = (e: KeyboardEvent) => e.stopPropagation();
    el.addEventListener('keydown', stop);
    return () => el.removeEventListener('keydown', stop);
  }, []);

  // emoji-mart's Picker computes its own internal width from
  // `perLine * emojiButtonSize` UNLESS `dynamicWidth` is set, in which case
  // it stretches to its parent's width. On mobile we want full-viewport.
  // The mobile sheet wraps this picker in `flex-1 min-h-0 flex flex-col`,
  // so we make the wrapper fill that space and tell the picker to expand.
  //
  // The `<em-emoji-picker>` custom element has no intrinsic stretch behavior:
  // even with `dynamicWidth: true` it ships with `display: flex` but no
  // `width: 100%`, so it shrinks to its perLine*emojiButtonSize content width
  // unless we force it to fill. The `emoji-picker-wrapper--mobile` modifier
  // applies that override (see globals.css) — desktop keeps the legacy
  // intrinsic-width sizing.
  const wrapperClass = mobile
    ? 'emoji-picker-wrapper emoji-picker-wrapper--mobile flex-1 min-h-0 w-full overflow-hidden'
    : 'emoji-picker-wrapper flex flex-col';

  return (
    <div ref={containerRef} className={wrapperClass}>
      {stickers && (
        <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
          <button
            type="button"
            aria-pressed={!showStickers}
            onClick={() => setShowStickers(false)}
            className={`rounded-md px-3 py-1 text-[13px] font-medium transition-colors ${
              !showStickers
                ? 'bg-interactive-selected text-txt-primary'
                : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-secondary'
            }`}
          >
            {t('composer.emoji')}
          </button>
          <button
            type="button"
            aria-pressed={showStickers}
            aria-label={t('stickers.title')}
            title={t('stickers.title')}
            onClick={() => setShowStickers(true)}
            className={`flex items-center justify-center rounded-md px-2.5 py-1 font-medium transition-colors ${
              showStickers
                ? 'bg-interactive-selected text-txt-primary'
                : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-secondary'
            }`}
          >
            <HeartIcon className="w-4 h-4" />
          </button>
        </div>
      )}
      {stickers && showStickers ? <StickerPicker mobile={mobile} onSelect={token => onEmojiSelect({ native: token })} /> : <Picker
        data={loadEmojiData}
        onEmojiSelect={onEmojiSelect}
        theme="dark"
        set="native"
        skinTonePosition="search"
        previewPosition="none"
        navPosition="bottom"
        perLine={mobile ? 8 : 10}
        maxFrequentRows={2}
        emojiSize={mobile ? 28 : 24}
        emojiButtonSize={mobile ? 40 : 32}
        dynamicWidth={mobile ? true : false}
        categories={['frequent', 'people', 'nature', 'foods', 'activity', 'places', 'objects', 'symbols', 'flags']}
      />}
    </div>
  );
}
