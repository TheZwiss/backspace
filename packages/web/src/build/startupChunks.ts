import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from 'vite';

/**
 * Modules loaded with `import()` that `main.tsx` waits for before the first
 * render: emoji-mart's data set (utils/emojiData.ts) and Discord's shortcode
 * table (utils/discordEmojiAliases.ts). Each is a chunk of its own, so the
 * browser would only request it once the main chunk has downloaded and run,
 * one round trip after it. A `modulepreload` link in index.html requests them
 * alongside the main chunk instead.
 *
 * Each entry matches the end of a module id in the bundle.
 */
export const STARTUP_CHUNK_MODULES: readonly string[] = [
  '/@emoji-mart/data/sets/15/native.json',
  '/src/utils/discordEmojiAliases.ts',
];

type Bundle = NonNullable<IndexHtmlTransformContext['bundle']>;

/**
 * One `modulepreload` link per chunk that holds a startup module. A startup
 * module that is in no chunk fails the build: the loader was renamed or the
 * data moved, and main.tsx would wait a round trip longer without anyone
 * noticing. A module in an entry chunk needs no preload and gets none.
 */
export function startupPreloadTags(bundle: Bundle, modules: readonly string[], base: string): HtmlTagDescriptor[] {
  const tags: HtmlTagDescriptor[] = [];
  for (const moduleSuffix of modules) {
    const chunk = Object.values(bundle).find((output) =>
      output.type === 'chunk' && output.moduleIds.some((id) => id.replace(/\\/g, '/').endsWith(moduleSuffix)));
    if (!chunk || chunk.type !== 'chunk') {
      throw new Error(`startup module ${moduleSuffix} is in no chunk of the build; update STARTUP_CHUNK_MODULES in src/build/startupChunks.ts`);
    }
    if (chunk.isEntry) continue;
    tags.push({
      tag: 'link',
      attrs: { rel: 'modulepreload', crossorigin: true, href: `${base}${chunk.fileName}` },
      injectTo: 'head',
    });
  }
  return tags;
}

/** Adds {@link startupPreloadTags} to the built index.html. */
export function preloadStartupChunks(): Plugin {
  let base = '/';
  return {
    name: 'backspace:preload-startup-chunks',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        return { html, tags: startupPreloadTags(ctx.bundle, STARTUP_CHUNK_MODULES, base) };
      },
    },
  };
}
