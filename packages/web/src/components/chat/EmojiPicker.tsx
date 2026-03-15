import React, { useRef, useEffect } from 'react';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

interface EmojiPickerProps {
  onEmojiSelect: (emoji: { native: string }) => void;
}

export function EmojiPicker({ onEmojiSelect }: EmojiPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Prevent keyboard events from bubbling out (e.g. Enter submitting the chat input)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const stop = (e: KeyboardEvent) => e.stopPropagation();
    el.addEventListener('keydown', stop);
    return () => el.removeEventListener('keydown', stop);
  }, []);

  return (
    <div ref={containerRef} className="emoji-picker-wrapper">
      <Picker
        data={data}
        onEmojiSelect={onEmojiSelect}
        theme="dark"
        set="native"
        skinTonePosition="search"
        previewPosition="none"
        navPosition="bottom"
        perLine={9}
        maxFrequentRows={2}
        emojiSize={24}
        emojiButtonSize={32}
        categories={['frequent', 'people', 'nature', 'foods', 'activity', 'places', 'objects', 'symbols', 'flags']}
      />
    </div>
  );
}
