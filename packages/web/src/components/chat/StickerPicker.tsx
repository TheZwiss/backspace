import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_PERSONAL_STICKERS, type PersonalSticker } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { StickerUploadForm } from './StickerUploadForm';
import { StickerRenameForm } from './StickerRenameForm';
import { StickerGrid } from './StickerGrid';
import { describeError } from '../../i18n/errors';
import './stickers.css';

/** Entries whose name holds the query, ignoring case. A blank query keeps every entry. */
export function filterStickers(items: PersonalSticker[], query: string): PersonalSticker[] {
  const needle = query.trim().toLowerCase();
  return needle ? items.filter(item => item.name.toLowerCase().includes(needle)) : items;
}

export function StickerPicker({ onSelect, mobile = false }: { onSelect: (token: string) => void; mobile?: boolean }) {
  const { t } = useTranslation(['chat', 'common']);
  const userId = useAuthStore(s => s.user?.id);
  const [items, setItems] = useState<PersonalSticker[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState<PersonalSticker | null>(null);
  const [managing, setManaging] = useState(false);
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * Where focus goes once a form closed and the grid is drawn again, the
   * first of these that is there and enabled: the tile whose rename closed,
   * or the upload button.
   */
  const focusAfterForm = useRef<string[] | null>(null);

  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);
    setError('');
    setNotice('');
    setUploading(false);
    setRenaming(null);
    setManaging(false);
    setSearch('');
    api.stickers.list().then(rows => { if (active) setItems(rows); })
      .catch((err: unknown) => { if (active) setError(describeError(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    const targets = focusAfterForm.current;
    if (renaming || uploading || !targets) return;
    focusAfterForm.current = null;
    const root = rootRef.current;
    for (const selector of targets) {
      const target = root?.querySelector<HTMLElement>(`${selector}:not(:disabled)`);
      if (target) {
        target.focus();
        return;
      }
    }
  }, [renaming, uploading]);

  const remove = async (id: string) => {
    setRemoving(id);
    setError('');
    setNotice('');
    try {
      await api.stickers.remove(id);
      setItems(rows => rows.filter(row => row.id !== id));
    } catch (err) { setError(describeError(err)); }
    finally { setRemoving(null); }
  };

  const full = items.length >= MAX_PERSONAL_STICKERS;
  const visible = filterStickers(items, search);

  const startUpload = () => {
    setError('');
    setNotice('');
    setUploading(true);
  };

  const startRename = (sticker: PersonalSticker) => {
    setError('');
    setNotice('');
    setRenaming(sticker);
  };

  const closeUpload = () => {
    focusAfterForm.current = ['[data-sticker-upload]', '[data-sticker-id]'];
    setUploading(false);
  };

  const closeRename = () => {
    if (renaming) focusAfterForm.current = [`[data-sticker-rename="${renaming.id}"]`, `[data-sticker-id="${renaming.id}"]`];
    setRenaming(null);
  };

  return (
    <div
      ref={rootRef}
      className={`flex flex-col min-h-0 text-txt-primary ${mobile ? 'w-full flex-1' : 'w-[352px] max-w-[calc(100*var(--app-vw)-24px)] h-[456px]'}`}
      onKeyDown={event => {
        // Keys stay in the picker, so Enter never reaches the composer. Escape
        // belongs to the picker's host (pickerEscape.tsx), which gives it to
        // an open form first.
        if (event.key !== 'Escape') event.stopPropagation();
      }}
    >
      {uploading ? <StickerUploadForm key={userId} capacity={Math.max(0, MAX_PERSONAL_STICKERS - items.length)}
        onCancel={closeUpload} onAdded={(added, complete) => {
          // Newest first, the order the server lists the collection in.
          setItems(rows => {
            const ids = new Set(added.map(item => item.id));
            return [...[...added].reverse(), ...rows.filter(row => !ids.has(row.id))];
          });
          if (!complete) return;
          closeUpload();
          setManaging(false);
          setNotice(t('stickers.saved'));
        }} /> : renaming ? <StickerRenameForm key={renaming.id} sticker={renaming} onCancel={closeRename}
        onRenamed={updated => {
          setItems(rows => rows.map(row => row.id === updated.id ? { ...row, name: updated.name } : row));
          closeRename();
        }} /> : <>
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-2">
          <h3 className="text-sm font-semibold">{t('stickers.title')} <span className="ml-1 text-xs font-normal text-txt-tertiary">{!loading && items.length}</span></h3>
          <div className="flex items-center gap-1">
            {items.length > 0 && <button type="button" disabled={!!removing} aria-pressed={managing}
              className="sticker-secondary-button" onClick={() => setManaging(!managing)}>{t(managing ? 'stickers.done' : 'stickers.manage')}</button>}
            <button type="button" data-sticker-upload disabled={loading || !!removing || full} onClick={startUpload} className="sticker-primary-button">
              <span aria-hidden="true" className="text-lg leading-none">+</span>{t('stickers.upload')}
            </button>
          </div>
        </div>
        <p className="px-4 pb-3 text-xs text-txt-tertiary">{t(managing ? 'stickers.manageHint' : full ? 'stickers.full' : 'stickers.collectionHint')}</p>
        {items.length > 0 && <div className="relative mx-4 mb-3 flex shrink-0 items-center">
          <svg className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-txt-tertiary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input type="text" role="searchbox" value={search} onChange={event => setSearch(event.target.value)}
            placeholder={t('stickers.search')} aria-label={t('stickers.search')} maxLength={100}
            className="input-search w-full pl-8 pr-8 text-xs" />
          {search && <button type="button" onClick={() => setSearch('')} aria-label={t('common:actions.clear')}
            className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded-md text-txt-tertiary hover:bg-interactive-hover hover:text-txt-primary">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>}
        </div>}
        {error && <p role="alert" className="mx-4 mb-3 rounded-lg bg-accent-rose/10 px-3 py-2 text-xs text-txt-danger">{error}</p>}
        {notice && <p role="status" className="mx-4 mb-2 text-xs text-txt-positive">{notice}</p>}
        {loading ? <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
          <div role="status" aria-label={t('stickers.loading')} className="grid grid-cols-4 gap-2">
            {Array.from({ length: 12 }, (_, index) => <div key={index} className="aspect-square rounded-xl bg-interactive-hover animate-pulse" />)}
          </div>
        </div> : items.length === 0 ? <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
          {!error && <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-center px-5">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M20 13V7a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v9a4 4 0 0 0 4 4h6Zm-7 7v-3a4 4 0 0 1 4-4h3" /><path d="M7.5 12a4 4 0 0 0 5 2M8 8h.01M15 8h.01" strokeLinecap="round" />
              </svg>
            </span>
            <p className="text-sm font-medium">{t('stickers.empty')}</p>
            <p className="text-xs leading-5 text-txt-tertiary">{t('stickers.emptyHint')}</p>
            <button type="button" onClick={startUpload} className="sticker-secondary-button">{t('stickers.chooseImage')}</button>
          </div>}
        </div> : <StickerGrid items={visible} noMatches={visible.length === 0} managing={managing} removing={removing}
          onSelect={onSelect} onRename={startRename} onRemove={id => void remove(id)} />}
        <div className="shrink-0 border-t border-border-soft px-4 py-2.5 text-[11px] text-txt-tertiary">{t('stickers.limits')}</div>
      </>}
    </div>
  );
}
