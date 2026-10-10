import { expect, it, vi } from 'vitest';
vi.mock('../ws/handler.js', () => ({ connectionManager: {} }));
import { extractUrls } from './embedResolver.js';

it('does not unfurl sticker assets twice and preserves ordinary image links', () => {
  const url = `https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
  expect(extractUrls(`sticker:${url}`)).toEqual([]);
  expect(extractUrls(url)).toEqual([url]);
  expect(extractUrls('👍')).toEqual([]);
});
