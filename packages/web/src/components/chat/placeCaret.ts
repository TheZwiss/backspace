import type { RefObject } from 'react';

/**
 * Puts the textarea's caret at `position` (an offset in the shown text) once
 * React has written the new draft into it: in a microtask, which runs after
 * React's own work for the event and before the next key is handled. An
 * animation frame is too late on a busy page: a key typed in between goes in
 * at the old caret, and the caret is then pulled back behind it, so the next
 * keys land in the middle of the text and the command lists, which follow the
 * caret at the end, stay shut.
 */
export function placeCaret(textareaRef: RefObject<HTMLTextAreaElement>, position: number, focus = false): void {
  queueMicrotask(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (focus) textarea.focus();
    textarea.setSelectionRange(position, position);
  });
}
