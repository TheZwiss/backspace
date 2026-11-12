import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '../ui/Toggle';

interface AttachMenuProps {
  /** Photos and videos; compressed unless the sender turned compression off. */
  onPickMedia: () => void;
  /** Files sent exactly as they are. */
  onPickDocument: () => void;
  compressMedia: boolean;
  onCompressMediaChange: (compress: boolean) => void;
  onClose: () => void;
}

const ROW =
  'w-full flex items-start gap-3 px-3 py-2 rounded-lg text-left hover:bg-wash/[0.06] focus-visible:bg-wash/[0.06] outline-none transition-colors';

/**
 * The popover of the composer's attach button: "Photo or video" (shrunk on this
 * device by default) and "Document" (the original file, untouched), plus the
 * switch for the default. A floating surface, so it is glass (design-system.md).
 */
export function AttachMenu({ onPickMedia, onPickDocument, compressMedia, onCompressMediaChange, onClose }: AttachMenuProps) {
  const { t } = useTranslation('chat');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('composer.attach.menuLabel')}
      className="glass absolute bottom-full left-2 mb-2 w-72 rounded-xl p-1.5 z-30 shadow-elevation-high"
    >
      <button
        type="button"
        role="menuitem"
        className={ROW}
        onClick={() => { onClose(); onPickMedia(); }}
      >
        <svg className="w-5 h-5 mt-0.5 text-accent-sky flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
        </svg>
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-txt-primary font-medium">{t('composer.attach.photoVideo')}</span>
          <span className="block text-xs text-txt-tertiary">
            {compressMedia ? t('composer.attach.photoVideoCompressed') : t('composer.attach.photoVideoOriginal')}
          </span>
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={ROW}
        onClick={() => { onClose(); onPickDocument(); }}
      >
        <svg className="w-5 h-5 mt-0.5 text-accent-amber flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 7V3.5L18.5 9H13z" />
        </svg>
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-txt-primary font-medium">{t('composer.attach.document')}</span>
          <span className="block text-xs text-txt-tertiary">{t('composer.attach.documentHint')}</span>
        </span>
      </button>
      <div className="mt-1 pt-2 px-3 pb-1.5 border-t border-border-soft flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-txt-secondary">{t('composer.attach.compressDefault')}</div>
          <div className="text-ui-caption text-txt-tertiary">{t('composer.attach.compressDefaultHint')}</div>
        </div>
        <Toggle enabled={compressMedia} onChange={onCompressMediaChange} />
      </div>
    </div>
  );
}
