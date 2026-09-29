import { describe, expect, it } from 'vitest';
import { STARTUP_CHUNK_MODULES, startupPreloadTags } from './startupChunks';

type Bundle = Parameters<typeof startupPreloadTags>[0];

function chunk(fileName: string, moduleIds: string[]): Bundle[string] {
  return { type: 'chunk', fileName, moduleIds } as unknown as Bundle[string];
}

const bundle: Bundle = {
  'assets/index-a1.js': chunk('assets/index-a1.js', ['/repo/packages/web/src/main.tsx']),
  'assets/native-b2.js': chunk('assets/native-b2.js', ['/repo/node_modules/.pnpm/@emoji-mart+data@1.2.1/node_modules/@emoji-mart/data/sets/15/native.json']),
  'assets/discordEmojiAliases-c3.js': chunk('assets/discordEmojiAliases-c3.js', ['/repo/packages/web/src/utils/discordEmojiAliases.ts']),
  'assets/SettingsPanel-d4.js': chunk('assets/SettingsPanel-d4.js', ['/repo/packages/web/src/components/modals/settingsPanels/AccountPanel.tsx']),
  'assets/index-e5.css': { type: 'asset', fileName: 'assets/index-e5.css' } as unknown as Bundle[string],
};

describe('startup chunk preloads (#330 review)', () => {
  it('preloads the chunks main.tsx waits for before the first render, and nothing else', () => {
    const tags = startupPreloadTags(bundle, STARTUP_CHUNK_MODULES, '/');
    expect(tags.map((tag) => tag.attrs?.href)).toEqual([
      '/assets/native-b2.js',
      '/assets/discordEmojiAliases-c3.js',
    ]);
    expect(tags.every((tag) => tag.tag === 'link' && tag.attrs?.rel === 'modulepreload' && tag.injectTo === 'head')).toBe(true);
  });

  it('fails the build when a startup module is not in a chunk of its own', () => {
    const merged: Bundle = { 'assets/index-a1.js': bundle['assets/index-a1.js']! };
    expect(() => startupPreloadTags(merged, STARTUP_CHUNK_MODULES, '/')).toThrow(/emoji-mart/);
  });
});
