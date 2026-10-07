import type { EmojiMartData } from '@emoji-mart/data';

// emoji-mart's data set (about 430 KB) as a chunk of its own, shared by the
// emoji picker and the shortcode names (emojiShortcodes.ts). Nothing imports
// `@emoji-mart/data` statically: that would put it back into the chunk of the
// importer, and from either user that is the startup bundle.

let load: Promise<EmojiMartData> | null = null;
let loaded: EmojiMartData | null = null;
const listeners = new Set<(data: EmojiMartData) => void>();

/** The data set if it has arrived, else null. */
export function getLoadedEmojiData(): EmojiMartData | null {
  return loaded;
}

/**
 * Calls `listener` once when the data set arrives, whoever loaded it: the
 * shortcode names fill in from a load the picker started just as from their
 * own. Returns the unsubscribe function.
 */
export function onEmojiDataLoaded(listener: (data: EmojiMartData) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The data set, downloaded once. A failed download is forgotten so the next
 * call tries again. Never resolves empty: emoji-mart's picker, handed no data,
 * fetches its own copy from a CDN.
 */
export function loadEmojiData(): Promise<EmojiMartData> {
  load ??= import('@emoji-mart/data')
    .then((module) => {
      const data = module.default as EmojiMartData | undefined;
      if (!data?.emojis) throw new Error('the emoji data chunk has no emojis');
      loaded = data;
      for (const listener of [...listeners]) listener(data);
      return data;
    })
    .catch((error: unknown) => {
      load = null;
      throw error;
    });
  return load;
}
