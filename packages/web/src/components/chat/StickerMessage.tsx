import { useTranslation } from 'react-i18next';
import { stickerUrl } from '@backspace/shared/src/stickers';
import { useUIStore } from '../../stores/uiStore';

export function StickerMessage({ token }: { token: string }) {
  const { t } = useTranslation('chat');
  const openImagePreview = useUIStore(s => s.openImagePreview);
  const url = stickerUrl(token)!;
  return <div className="max-w-[240px]">
    <button type="button" onClick={() => openImagePreview(url)} aria-label={t('stickers.preview')}>
      <img data-sticker-source={token} src={url} alt={t('stickers.title')} className="max-w-full max-h-[240px] object-contain" loading="lazy" />
    </button>
  </div>;
}
