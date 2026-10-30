import { MAX_STICKER_BYTES, type PersonalSticker } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import i18n from '../../i18n';

export async function uploadSticker(file: Blob, name: string, maxBytes: number = MAX_STICKER_BYTES): Promise<PersonalSticker> {
  if (!file.size || file.size > maxBytes) throw new Error(i18n.t('chat:stickers.invalidSize', { max: Math.round(maxBytes / (1024 * 1024)) }));
  const image = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return api.stickers.upload({ name: name.slice(0, 100), image });
}


/** Enforce the same size limit while reading, even when the upload endpoint streams without Content-Length. */
export async function readStickerImage(response: Response, maxBytes: number = MAX_STICKER_BYTES): Promise<Blob> {
  if (!response.ok || !response.body) throw new Error(i18n.t('chat:stickers.downloadFailed'));
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(i18n.t('chat:stickers.invalidSize', { max: Math.round(maxBytes / (1024 * 1024)) }));
      }
      chunks.push(value.slice().buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}
