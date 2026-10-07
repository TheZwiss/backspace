import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// emoji-mart's data set is about 430 KB. It is loaded as a chunk of its own
// (utils/emojiData.ts) so it stays out of the startup bundle (#330); main.tsx
// waits for it, with Discord's names, before the first render.

describe('shortcode names load as their own chunk', () => {
  it('converts nothing before the names load and everything after', async () => {
    vi.resetModules();
    const fresh = await import('./emojiShortcodes');
    // Before the load: text stays exactly as written, nothing is lost.
    expect(fresh.replaceEmojiShortcodes('hi :smile: :cross:')).toBe('hi :smile: :cross:');

    await fresh.loadEmojiShortcodeNames();
    expect(fresh.replaceEmojiShortcodes('hi :smile: :cross:')).toBe('hi 😄 ✝️');
  });

  it('shares one download between the picker and the shortcode names', async () => {
    vi.resetModules();
    const data = await import('./emojiData');
    const shortcodes = await import('./emojiShortcodes');
    await shortcodes.loadEmojiShortcodeNames();
    const picker = await data.loadEmojiData();
    expect(picker.emojis.smile?.skins[0]?.native).toBe('😄');
    expect(data.loadEmojiData()).toBe(data.loadEmojiData());
  });

  it('is imported statically by no source file', () => {
    // A static import anywhere in src puts the data set back into the chunk of
    // whatever imports it, and from the picker or the shortcodes that is the
    // startup bundle. Type-only imports carry no data.
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return files(full);
      return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
    });
    const offenders = files(src).filter((file) =>
      /^\s*import\s+(?!type\b)[^;]*from\s+['"]@emoji-mart\/data['"]/m.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(src, file))).toEqual([]);
  });
});
