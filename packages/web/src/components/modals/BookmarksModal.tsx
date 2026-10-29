import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { BookmarkList } from '../bookmarks/BookmarkList';

/** The user's bookmarks as a window (desktop). Opening one closes it. */
export function BookmarksModal() {
  const { t } = useTranslation('bookmarks');
  const isOpen = useUIStore((s) => s.activeModal === 'bookmarks');
  const closeModal = useUIStore((s) => s.closeModal);
  return (
    <Modal isOpen={isOpen} onClose={closeModal} title={t('title')} maxWidth="max-w-xl" mobileStyle="fullscreen">
      <div className="-m-4">
        <BookmarkList onOpened={closeModal} />
      </div>
    </Modal>
  );
}
