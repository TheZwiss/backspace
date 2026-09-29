import { describe, expect, it, vi } from 'vitest';
import { MAX_STICKER_BYTES } from '@backspace/shared/src/stickers';
import { readStickerImage } from './stickerUpload';

describe('bounded sticker image download', () => {
  it('reads a valid response without requiring Content-Length', async () => {
    const result = await readStickerImage(new Response(new Uint8Array([1, 2, 3])));
    expect(result.size).toBe(3);
  });

  it('cancels a streamed response once it exceeds the upload limit', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_STICKER_BYTES + 1)); },
      cancel,
    });
    await expect(readStickerImage(new Response(stream))).rejects.toThrow('5 MB');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('exposes missing-file errors rather than attempting an upload', async () => {
    await expect(readStickerImage(new Response(null, { status: 404 }))).rejects.toThrow('404');
  });
});
