import { Tooltip } from '../ui/Tooltip';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormatters } from '../../i18n/formatters';
import { useUIStore } from '../../stores/uiStore';
import { getApiForOrigin, useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { stripUploadPrefix } from '../../utils/assetUrls';
import { getSpaceGradient } from '../../utils/gradients';
import { Modal } from '../ui/Modal';

export function SpaceProfileModal() {
  const active = useUIStore((state) => state.activeModal);
  const spaceId = useUIStore((state) => state.modalData.spaceId as string | undefined);
  const space = useSpaceStore((state) => state.spaces.find((item) => item.id === spaceId));
  if (active !== 'spaceProfile' || !space) return null;
  return <SpaceProfileContent key={space.id} space={space} />;
}

function SpaceProfileContent({ space }: { space: TaggedSpace }) {
  const { t } = useTranslation(['spaces', 'common']);
  const f = useFormatters();
  const close = useUIStore((state) => state.closeModal);
  const [preview, setPreview] = useState<{ src: string; label: string } | null>(null);
  const asset = (value: string | null) => !value ? null : /^(https?:|data:|blob:)/i.test(value)
    ? value : getApiForOrigin(space._instanceOrigin ?? '').uploads.url(stripUploadPrefix(value));
  const icon = asset(space.icon);
  const banner = asset(space.banner);
  const gradient = getSpaceGradient(space.id, space.name, space.avatarColor).gradient;
  return <Modal isOpen onClose={() => preview ? setPreview(null) : close()} title={preview?.label ?? t('spaces:profile.title')} maxWidth="max-w-xl">
    {preview ? <div className="space-y-3">
      <button data-icon-motion="press" className="text-sm text-accent-mint hover:underline" onClick={() => setPreview(null)}>← {t('common:actions.back')}</button>
      <img src={preview.src} alt={preview.label} className="mx-auto max-h-[calc(65*var(--app-vh))] max-w-full object-contain rounded-xl" />
    </div> : <div className="overflow-hidden rounded-2xl border border-wash/10 bg-wash/[0.02]">
      {banner ? <button data-icon-motion="press" type="button" className="block aspect-[9/4] w-full overflow-hidden bg-black/20" title={t('spaces:profile.viewBanner')} onClick={() => setPreview({ src: banner, label: t('spaces:profile.viewBanner') })}>
        <img src={banner} alt={t('spaces:profile.bannerAlt', { name: space.name })} className="h-full w-full object-cover transition-transform duration-300 hover:scale-105" />
      </button> : <div className="h-28" style={{ background: gradient }} />}
      <div className="px-5 pb-5">
        <div className="relative -mt-10 mb-3 flex items-end justify-between gap-3">
          {icon ? <Tooltip content={t('spaces:profile.viewIcon')} position="top"><button data-icon-motion="press" aria-label={t('spaces:profile.viewIcon')} type="button" className="h-20 w-20 shrink-0 rounded-2xl overflow-hidden border-4 border-surface-base bg-surface-base"  onClick={() => setPreview({ src: icon, label: t('spaces:profile.viewIcon') })}>
            <img src={icon} alt={space.name} className="h-full w-full object-cover" />
          </button></Tooltip> : <div className="h-20 w-20 shrink-0 rounded-2xl border-4 border-surface-base flex items-center justify-center text-3xl font-bold text-white" style={{ background: gradient }}>{space.name.charAt(0).toUpperCase()}</div>}
          <span className="mb-1 rounded-full bg-wash/5 px-2.5 py-1 text-ui-micro uppercase tracking-wider text-txt-tertiary">{t('spaces:profile.server')}</span>
        </div>
        <h3 className="ui-dialog-title break-words">{space.name}</h3>
        <p className="mt-2 text-sm leading-relaxed text-txt-secondary whitespace-pre-wrap break-words">{space.description || t('spaces:profile.noDescription')}</p>
        <div className="mt-5 pt-3 border-t border-wash/5 text-xs text-txt-tertiary">
          {t('spaces:profile.createdAt')} <time dateTime={new Date(space.createdAt).toISOString()}>{f.formatLongDate(space.createdAt)}</time>
        </div>
      </div>
    </div>}
  </Modal>;
}
