import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { stickerUrl, type PersonalSticker } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { StickerUploadForm } from './StickerUploadForm';
import './stickers.css';

export function StickerPicker({ onSelect, mobile = false }: { onSelect: (token: string) => void; mobile?: boolean }) {
  const { t } = useTranslation('chat');
  const userId = useAuthStore(s => s.user?.id);
  const [items, setItems] = useState<PersonalSticker[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    setItems([]);
    setLoading(true);
    setError('');
    setNotice('');
    setUploading(false);
    setManaging(false);
    api.stickers.list().then(rows => { if (active) setItems(rows); })
      .catch((err: Error) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  const remove = async (id: string) => {
    setRemoving(id);
    setError('');
    setNotice('');
    try {
      await api.stickers.remove(id);
      setItems(rows => rows.filter(row => row.id !== id));
    } catch (err) { setError((err as Error).message); }
    finally { setRemoving(null); }
  };

  const startUpload = () => {
    setError('');
    setNotice('');
    setUploading(true);
  };

  return (
    <div className={`flex flex-col min-h-0 text-txt-primary ${mobile ? 'w-full flex-1' : 'w-[352px] max-w-[calc(100*var(--app-vw)-24px)] h-[456px]'}`}
      onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      {uploading ? <StickerUploadForm key={userId} onCancel={() => setUploading(false)} onAdded={added => {
        const list = Array.isArray(added) ? added : [added];
        setItems(rows => {
          const ids = new Set(list.map(item => item.id));
          return [...list, ...rows.filter(row => !ids.has(row.id))];
        });
        setUploading(false);
        setManaging(false);
        setNotice(t('stickers.saved'));
      }} /> : <>
        <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-2">
          <h3 className="text-sm font-semibold">{t('stickers.title')} <span className="ml-1 text-xs font-normal text-txt-tertiary">{!loading && items.length}</span></h3>
          <div className="flex items-center gap-1">
            {items.length > 0 && <button type="button" disabled={!!removing} aria-pressed={managing}
              className="sticker-secondary-button" onClick={() => setManaging(!managing)}>{t(managing ? 'stickers.done' : 'stickers.manage')}</button>}
            <button type="button" disabled={loading || !!removing} onClick={startUpload} className="sticker-primary-button">
              <span aria-hidden="true" className="text-lg leading-none">+</span>{t('stickers.upload')}
            </button>
          </div>
        </div>
        <p className="px-4 pb-3 text-xs text-txt-tertiary">{t(managing ? 'stickers.removeHint' : 'stickers.collectionHint')}</p>
        {error && <p role="alert" className="mx-4 mb-3 rounded-lg bg-accent-rose/10 px-3 py-2 text-xs text-txt-danger">{error}</p>}
        {notice && <p role="status" className="mx-4 mb-2 text-xs text-txt-positive">{notice}</p>}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
          {loading && <div role="status" aria-label={t('stickers.loading')} className="grid grid-cols-4 gap-2">
            {Array.from({ length: 12 }, (_, index) => <div key={index} className="aspect-square rounded-xl bg-interactive-hover animate-pulse" />)}
          </div>}
          {!loading && !error && items.length === 0 && <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-center px-5">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M20 13V7a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v9a4 4 0 0 0 4 4h6Zm-7 7v-3a4 4 0 0 1 4-4h3" /><path d="M7.5 12a4 4 0 0 0 5 2M8 8h.01M15 8h.01" strokeLinecap="round" />
              </svg>
            </span>
            <p className="text-sm font-medium">{t('stickers.empty')}</p>
            <p className="text-xs leading-5 text-txt-tertiary">{t('stickers.emptyHint')}</p>
            <button type="button" onClick={startUpload} className="sticker-secondary-button">{t('stickers.chooseImage')}</button>
          </div>}
          {!loading && items.length > 0 && <div className="grid grid-cols-4 gap-1.5">
            {items.map(item => <div key={item.id} className="group relative min-w-0 rounded-xl hover:bg-interactive-hover transition-colors">
              <button type="button" disabled={managing || !!removing} onClick={() => onSelect(item.token)} title={item.name}
                aria-label={item.name} className="sticker-tile w-full p-2">
                <img src={stickerUrl(item.token)!} alt={item.name} className="aspect-square w-full object-contain transition-transform group-hover:scale-105" loading="lazy" />
                <span className="mt-1 block truncate text-[10px] text-txt-tertiary">{item.name}</span>
              </button>
              {/* Removal is a separate mode so a normal send can never delete a collection item. */}
              {managing && <button type="button" disabled={!!removing} aria-label={t('stickers.removeNamed', { name: item.name })}
                className="sticker-remove-button" onClick={() => void remove(item.id)}>
                {removing === item.id ? <span className="sticker-spinner" /> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>}
              </button>}
            </div>)}
          </div>}
        </div>
        <div className="shrink-0 border-t border-border-soft px-4 py-2.5 text-[11px] text-txt-tertiary">{t('stickers.limits')}</div>
      </>}
    </div>
  );
}
