import { useTranslation } from 'react-i18next';
import { stickerPreviewUrl, stickerUrl, type PersonalSticker } from '@backspace/shared/src/stickers';

interface StickerGridProps {
  /** The entries the search leaves, in collection order. */
  items: PersonalSticker[];
  /** Whether the search is hiding every entry of a collection that has some. */
  noMatches: boolean;
  managing: boolean;
  removing: string | null;
  onSelect: (token: string) => void;
  onRename: (sticker: PersonalSticker) => void;
  onRemove: (id: string) => void;
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

/**
 * The collection as tiles. A click sends the sticker; Manage mode adds a
 * rename and a remove button to each tile and turns sending off, so a normal
 * pick never removes or renames an entry. There is no right-click menu on a
 * tile: the desktop context menu draws at z-index 200, under the z-index 300
 * popovers the picker opens in, so it would be hidden behind the picker.
 */
export function StickerGrid({ items, noMatches, managing, removing, onSelect, onRename, onRemove }: StickerGridProps) {
  const { t } = useTranslation('chat');

  if (noMatches) {
    return (
      <div className="flex-1 min-h-0 px-3 pb-3">
        <p role="status" className="flex h-40 items-center justify-center px-4 text-center text-xs text-txt-tertiary">
          {t('stickers.noResults')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
      <div className="grid grid-cols-4 gap-1.5">
        {items.map(item => (
          <div key={item.id} className="group relative min-w-0 rounded-xl hover:bg-interactive-hover transition-colors">
            <button
              type="button"
              data-sticker-id={item.id}
              disabled={managing || !!removing}
              onClick={() => onSelect(item.token)}
              title={item.name}
              aria-label={item.name}
              className="sticker-tile w-full p-2"
            >
              <img
                src={stickerPreviewUrl(item.token) || stickerUrl(item.token) || undefined}
                alt={item.name}
                className="aspect-square w-full object-contain transition-transform group-hover:scale-105"
                loading="lazy"
              />
              <span className="mt-1 block truncate text-[10px] text-txt-tertiary">{item.name}</span>
            </button>
            {managing && (
              <>
                <button
                  type="button"
                  data-sticker-rename={item.id}
                  disabled={!!removing}
                  aria-label={t('stickers.renameNamed', { name: item.name })}
                  className="sticker-edit-button"
                  onClick={() => onRename(item)}
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  disabled={!!removing}
                  aria-label={t('stickers.removeNamed', { name: item.name })}
                  className="sticker-remove-button"
                  onClick={() => onRemove(item.id)}
                >
                  {removing === item.id ? (
                    <span className="sticker-spinner" />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="m6 6 12 12M6 18 18 6" />
                    </svg>
                  )}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
