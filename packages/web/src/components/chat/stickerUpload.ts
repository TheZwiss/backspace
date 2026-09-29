import { MAX_STICKER_BYTES, type PersonalSticker } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';

export async function uploadSticker(file: Blob, name: string): Promise<PersonalSticker> {
  if (!file.size || file.size > MAX_STICKER_BYTES) throw new Error('Image must be at most 5 MB');
  const image = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return api.stickers.upload({ name: name.slice(0, 100), image });
}


/** Enforce the same size limit while reading, even when the upload endpoint streams without Content-Length. */
export async function readStickerImage(response: Response): Promise<Blob> {
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);
  if (!response.body) throw new Error('Image response is empty');
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_STICKER_BYTES) {
        await reader.cancel();
        throw new Error('Image must be at most 5 MB');
      }
      chunks.push(value.slice().buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}
