import React, { useRef, useEffect } from 'react';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

interface EmojiPickerProps {
  onEmojiSelect: (emoji: { native: string }) => void;
  /**
   * Mobile rendering: stretch the picker to fill its container width
   * (the parent bottom-sheet provides the viewport-wide bounds), use
   * larger touch targets, and let the picker's own scroll area expand
   * to consume the available height of the sheet.
   */
  mobile?: boolean;
}

export function EmojiPicker({ onEmojiSelect, mobile = false }: EmojiPickerProps) {
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
    : 'emoji-picker-wrapper';

  return (
    <div ref={containerRef} className={wrapperClass}>
      <Picker
        data={data}
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
      />
    </div>
  );
}
