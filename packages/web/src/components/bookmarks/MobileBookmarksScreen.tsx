import React from 'react';
import { useTranslation } from 'react-i18next';
import { MobileScreenHeader } from '../layout/MobileScreenHeader';
import { BookmarkList } from './BookmarkList';

/**
 * The bookmark list as a pushed screen. Opening a bookmark needs no extra
 * navigation: the jump pushes the chat screen on top of this one.
 */
export function MobileBookmarksScreen() {
  const { t } = useTranslation('bookmarks');
  return (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={t('title')} />
      <div className="flex-1 min-h-0 overflow-y-auto"><BookmarkList /></div>
    </div>
  );
}
