import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildImageMenuItems } from './imageMenuItems';
import { api } from '../../api/client';
import { uploadSticker } from './stickerUpload';

vi.mock('../../api/client', () => ({ api: { stickers: { collect: vi.fn() } } }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: toast }) } }));
vi.mock('../../utils/imageActions', () => ({ saveImage: vi.fn(), copyImageToClipboard: vi.fn() }));
vi.mock('./stickerUpload', async importOriginal => ({ ...await importOriginal<typeof import('./stickerUpload')>(), uploadSticker: vi.fn() }));
const token = `sticker:https://chat.test/api/stickers/assets/${'a'.repeat(64)}.webp`;
const menu = (source: string) => buildImageMenuItems({ imageUrl: '/api/uploads/thumbnail.webp', stickerSource: source, stickerName: 'Happy' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.stickers.collect).mockResolvedValue({ id: 'a'.repeat(64), name: 'Happy', token });
});
afterEach(() => vi.unstubAllGlobals());

it('collects a token from the menu, including after it was removed from the collection', async () => {
  const item = menu(token)[0]!;
  expect(item).toMatchObject({ key: 'collect-sticker', label: 'Add to my stickers' });
  if (item.type !== 'action') throw new Error('Expected action');
  await item.onClick();
  expect(api.stickers.collect).toHaveBeenCalledWith({ id: 'a'.repeat(64), token });
  expect(toast).toHaveBeenLastCalledWith('Added to my stickers', 'success');
  await item.onClick();
  expect(api.stickers.collect).toHaveBeenCalledTimes(2);
});

it('collects the original local image instead of the rendered thumbnail', async () => {
  const fetchImage = vi.fn().mockResolvedValue(new Response(new Blob(['image'], { type: 'image/png' })));
  vi.stubGlobal('fetch', fetchImage);
  const item = menu('/api/uploads/original.png')[0]!;
  if (item.type !== 'action') throw new Error('Expected action');
  await item.onClick();
  expect(fetchImage).toHaveBeenCalledWith(`${window.location.origin}/api/uploads/original.png`);
  expect(uploadSticker).toHaveBeenCalledWith(expect.any(Blob), 'Happy');
  expect(api.stickers.collect).not.toHaveBeenCalled();
});

it.each(['https://remote.test/api/uploads/image.png', '/api/avatars/a.png', 'https://[', '/api/uploads/a.png?secret=1'])('omits collection for ineligible source %s', source => {
  expect(menu(source).map(item => item.key)).not.toContain('collect-sticker');
});

it('does not offer collection on arbitrary inline images or non-image context menus', () => {
  expect(buildImageMenuItems({ imageUrl: '/api/uploads/image.png' }).map(item => item.key)).not.toContain('collect-sticker');
  expect(buildImageMenuItems({ stickerSource: token })).toEqual([]);
});

it('keeps failures visible and never reports a false success', async () => {
  vi.mocked(api.stickers.collect).mockRejectedValueOnce(new Error('Collection unavailable'));
  const item = menu(token)[0]!;
  if (item.type !== 'action') throw new Error('Expected action');
  await item.onClick();
  expect(toast).toHaveBeenLastCalledWith('Collection unavailable', 'warning');
  expect(toast).not.toHaveBeenCalledWith('Added to my stickers', 'success');
});
