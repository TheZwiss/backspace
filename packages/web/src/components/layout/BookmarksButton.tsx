import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/uiStore';
import { BookmarkIcon } from '../ui/BookmarkIcon';

/**
 * Top-bar button that opens the bookmarks window (desktop). It sits to the
 * left of the downloads indicator and shares its footprint, so the two read
 * as one group of utility buttons.
 */
export function BookmarksButton() {
  const { t } = useTranslation('bookmarks');
  const openModal = useUIStore((s) => s.openModal);
  const open = useUIStore((s) => s.activeModal === 'bookmarks');
  return (
    <button
      type="button"
      onClick={() => openModal('bookmarks')}
      className="w-8 h-8 flex items-center justify-center rounded-[6px] text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover transition-colors"
      title={t('title')}
      aria-label={t('title')}
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <BookmarkIcon size={20} />
    </button>
  );
}
