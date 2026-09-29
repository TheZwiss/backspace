import { useEffect } from 'react';
import type { RefObject } from 'react';
import { useComposerStore } from '../../stores/composerStore';

const EVENT = 'composer-mention';
export function insertComposerMention(channelId: string, userId: string): void {
  // Keep the wire ID in the draft; the composer's mirror renders the display name.
  const store = useComposerStore.getState();
  const draft = store.get(channelId).draftText;
  store.setDraft(channelId, draft + (draft && !/\s$/.test(draft) ? ' ' : '') + '<@' + userId + '> ');
  window.dispatchEvent(new CustomEvent(EVENT, { detail: channelId }));
}

export function useComposerMention(channelId: string, textareaRef: RefObject<HTMLTextAreaElement>): void {
  useEffect(() => {
    let frame = 0;
    const focus = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== channelId) return;
      // Wait for the new display text before positioning the caret, not the wire length.
      frame = requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
      });
    };
    window.addEventListener(EVENT, focus);
    return () => { window.removeEventListener(EVENT, focus); cancelAnimationFrame(frame); };
  }, [channelId, textareaRef]);
}
