import { stickerUrl } from '@backspace/shared/src/stickers';
import type { ContextMenuAction, ContextMenuItem } from '../../stores/contextMenuStore';
import { saveImage, copyImageToClipboard } from '../../utils/imageActions';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../api/client';
import i18n from '../../i18n';
import { uploadSticker, readStickerImage } from './stickerUpload';

interface ImageMenuParams {
  imageUrl?: string | null;
  sourceUrl?: string | null;
  stickerSource?: string | null;
  stickerName?: string;
}

/** Only annotated sticker messages and local original attachments can be collected, never arbitrary embeds. */
function collectStickerItem(source: string, name: string): ContextMenuAction | null {
  const sticker = stickerUrl(source);
  let url: URL;
  try { url = new URL(sticker ?? source, window.location.origin); }
  catch { return null; }
  const localUpload = url.origin === window.location.origin
    && /^\/api\/uploads\/[^/]+$/.test(url.pathname) && !url.search && !url.hash;
  if (!sticker && !localUpload) return null;

  return {
    key: 'collect-sticker',
    type: 'action',
    label: i18n.t('chat:stickers.save'),
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 7v10M7 12h10" /></svg>,
    onClick: async () => {
      const { addToast } = useUIStore.getState();
      addToast(i18n.t('chat:stickers.uploading'), 'info');
      try {
        if (sticker) {
          // The server validates its canonical origin; the browser's development origin may differ.
          await api.stickers.collect({ id: url.pathname.split('/').pop()!.replace('.webp', ''), token: source });
        } else {
          const response = await fetch(url.href);
          await uploadSticker(await readStickerImage(response), name);
        }
        addToast(i18n.t('chat:stickers.saved'), 'success');
      } catch (err) {
        addToast((err as Error).message, 'warning');
      }
    },
  };
}

export function buildImageMenuItems({ imageUrl, sourceUrl, stickerSource, stickerName }: ImageMenuParams): ContextMenuItem[] {
  if (!imageUrl) return [];
  const items: ContextMenuItem[] = [];
  const collect = stickerSource ? collectStickerItem(stickerSource, stickerName || i18n.t('chat:stickers.title')) : null;
  if (collect) items.push(collect);
  items.push({
    key: 'save-image', type: 'action', label: i18n.t('chat:menu.saveImage'),
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" /></svg>,
    onClick: () => saveImage(imageUrl),
  }, {
    key: 'copy-image', type: 'action', label: i18n.t('chat:menu.copyImage'),
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21 9v10c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2h7l6 6zm-2 1h-5V4H8v15h11V10zM3 15V3c0-1.1.9-2 2-2h9v2H5v12H3z" /></svg>,
    onClick: () => { void copyImageToClipboard(imageUrl); },
  });
  if (!sourceUrl) items.push({
    key: 'open-original', type: 'action', label: i18n.t('chat:menu.openOriginal'),
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" /></svg>,
    onClick: () => { window.open(imageUrl, '_blank', 'noopener'); },
  });
  items.push({ key: 'image-sep', type: 'separator' });
  return items;
}
