import { Tooltip } from '../ui/Tooltip';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAX_PERSONAL_STICKERS,
  stickerPreviewUrl,
  stickerUrl,
  type PersonalSticker,
  type StickerPackDetail,
  type StickerPackSummary,
} from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/authStore';
import { StickerUploadForm } from './StickerUploadForm';
import { StickerRenameForm } from './StickerRenameForm';
import { StickerGrid } from './StickerGrid';
import { StickerStoreModal } from './StickerStoreModal';
import { describeError } from '../../i18n/errors';
import { getSpaceGradient } from '../../utils/gradients';
import './stickers.css';

/** Entries whose name holds the query, ignoring case. A blank query keeps every entry. */
export function filterStickers(items: PersonalSticker[], query: string): PersonalSticker[] {
  return filterByName(items, query);
}

function filterByName<T extends { name: string }>(items: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  return needle ? items.filter(item => item.name.toLowerCase().includes(needle)) : items;
}

interface StickerPickerProps {
  onSelect: (token: string) => void;
  mobile?: boolean;
  manageable?: boolean;
  spaceId?: string | null;
}

function PackStickerGrid({ pack, query, onSelect }: { pack: StickerPackDetail; query: string; onSelect: (token: string) => void }) {
  const items = filterByName(pack.items, query);
  if (items.length === 0) return <StickerSearchEmpty />;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
      <div className="grid grid-cols-4 gap-1.5">
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.token)}
            title={item.name}
            aria-label={item.name}
            className="sticker-tile w-full p-2"
          >
            <img
              src={stickerPreviewUrl(item.token) || stickerUrl(item.token) || ''}
              alt={item.name}
              className="aspect-square w-full object-contain transition-transform group-hover:scale-105"
              loading="lazy"
            />
            <span className="mt-1 block truncate text-ui-micro text-txt-tertiary">{item.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TokenStickerGrid({ items, query, onSelect }: {
  items: Array<{ name: string; token: string }>;
  query: string;
  onSelect: (token: string) => void;
}) {
  const visible = filterByName(items, query);
  if (visible.length === 0) return <StickerSearchEmpty />;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
      <div className="grid grid-cols-4 gap-1.5">
        {visible.map((item) => (
          <button
            key={item.token}
            type="button"
            onClick={() => onSelect(item.token)}
            title={item.name}
            aria-label={item.name}
            className="sticker-tile w-full p-2"
          >
            <img
              src={stickerPreviewUrl(item.token) || stickerUrl(item.token) || ''}
              alt={item.name}
              className="aspect-square w-full object-contain"
              loading="lazy"
            />
            <span className="mt-1 block truncate text-ui-micro text-txt-tertiary">{item.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function StickerSearchEmpty() {
  const { t } = useTranslation('chat');
  return (
    <p role="status" className="flex flex-1 items-center justify-center px-4 text-center text-xs text-txt-tertiary">
      {t('stickers.noResults')}
    </p>
  );
}

function StickerSearchInput({ value, onChange, className = 'mx-4 mb-3' }: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { t } = useTranslation(['chat', 'common']);
  return (
    <div className={`relative ${className} flex shrink-0 items-center`}>
      <svg
        className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-txt-tertiary"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <input
        type="text"
        role="searchbox"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={t('stickers.search')}
        aria-label={t('stickers.search')}
        maxLength={100}
        className="input-search w-full pl-8 pr-8 text-xs"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={t('common:actions.clear')}
          className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded-md text-txt-tertiary hover:bg-interactive-hover hover:text-txt-primary"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function StickerPicker({ onSelect, mobile = false, manageable = true, spaceId = null }: StickerPickerProps) {
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

  // Sticker Store packs state
  const [installedPacks, setInstalledPacks] = useState<StickerPackSummary[]>([]);
  const [activeTab, setActiveTab] = useState<string>('personal');
  const [showStore, setShowStore] = useState(false);
  const [currentPackDetail, setCurrentPackDetail] = useState<StickerPackDetail | null>(null);
  const [library, setLibrary] = useState<Awaited<ReturnType<typeof api.stickerLibrary.get>> | null>(null);

  /**
   * Where focus goes once a form closed and the grid is drawn again, the
   * first of these that is there and enabled: the tile whose rename closed,
   * or the upload button.
   */
  const focusAfterForm = useRef<string[] | null>(null);

  const loadInstalledPacks = () => {
    if (!api.stickerStore?.myPacks) return;
    api.stickerStore.myPacks()
      .then(packs => {
        setInstalledPacks(packs);
        setActiveTab(prev => (
          prev === 'personal'
          || prev === 'favorites'
          || prev.startsWith('user:')
          || prev.startsWith('space:')
          || packs.some((pack) => `store:${pack.id}` === prev)
            ? prev
            : 'personal'
        ));
      })
      .catch(() => {});
  };

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
    loadInstalledPacks();
    if (api.stickerLibrary?.get) {
      api.stickerLibrary.get().then((next) => { if (active) setLibrary(next); }).catch(() => {});
    }
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    if (activeTab === 'personal' || activeTab === 'favorites') {
      setCurrentPackDetail(null);
      return;
    }
    if (activeTab.startsWith('user:')) {
      setCurrentPackDetail(library?.privatePacks.find((pack) => pack.id === activeTab.slice(5)) ?? null);
      return;
    }
    if (activeTab.startsWith('space:')) {
      const spaceId = activeTab.slice(6);
      setCurrentPackDetail(library?.spaces.find((entry) => entry.spaceId === spaceId)?.pack ?? null);
      return;
    }
    const storeId = activeTab.startsWith('store:') ? activeTab.slice(6) : activeTab;
    let active = true;
    api.stickerStore.getPack(storeId, spaceId ?? undefined).then(detail => {
      if (active) setCurrentPackDetail(detail);
    }).catch(() => {
      if (active) setCurrentPackDetail(null);
    });
    return () => { active = false; };
  }, [activeTab, spaceId, library]);

  useEffect(() => {
    setSearch('');
  }, [activeTab]);

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
  const activeSpace = activeTab.startsWith('space:')
    ? library?.spaces.find((space) => space.spaceId === activeTab.slice(6)) ?? null
    : null;
  const activeSpaceGradient = activeSpace
    ? getSpaceGradient(activeSpace.spaceId, activeSpace.name, activeSpace.avatarColor)
    : null;

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
      className={`relative flex flex-col min-h-0 pl-12 text-txt-primary ${mobile ? 'w-full flex-1' : 'w-[352px] max-w-[calc(100*var(--app-vw)-24px)] h-[456px]'}`}
      onKeyDown={event => {
        // Keys stay in the picker, so Enter never reaches the composer. Escape
        // belongs to the picker's host (pickerEscape.tsx), which gives it to
        // an open form first.
        if (event.key !== 'Escape') event.stopPropagation();
      }}
    >
      <nav
        aria-label={t('stickers.servers')}
        className="absolute bottom-12 left-0 top-0 z-10 flex w-11 flex-col gap-1.5 overflow-y-auto scrollbar-none border-r border-white/[0.06] bg-surface-base/35 px-1.5 py-3"
      >
        {library?.spaces.map((space) => {
          const selected = activeTab === `space:${space.spaceId}`;
          const gradient = getSpaceGradient(space.spaceId, space.name, space.avatarColor);
          const icon = space.icon
            ? (space.icon.startsWith('http') || space.icon.startsWith('/') ? space.icon : `/api/uploads/${space.icon}`)
            : null;
          return (
            <div key={space.spaceId} className="group relative flex shrink-0 justify-center">
              <span
                aria-hidden="true"
                className={`absolute -left-1 top-1/2 w-1 -translate-y-1/2 rounded-full bg-txt-primary transition-all duration-150 ${
                  selected ? 'h-7 opacity-100' : 'h-2 opacity-0 group-hover:h-4 group-hover:opacity-70'
                }`}
              />
              <Tooltip content={space.name} position="top"><button
                type="button"
                onClick={() => setActiveTab(`space:${space.spaceId}`)}
                aria-label={space.name}

                aria-current={selected ? 'page' : undefined}
                className={`relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden text-ui-caption font-bold text-white shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base ${
                  selected
                    ? 'rounded-[11px] ring-1 ring-white/30'
                    : 'rounded-[16px] opacity-80 hover:-translate-y-0.5 hover:rounded-[11px] hover:opacity-100'
                }`}
                style={icon ? undefined : { background: gradient.gradient }}
              >
                {icon
                  ? <img src={icon} alt="" className="h-full w-full object-cover" loading="lazy" />
                  : <span aria-hidden="true">{space.name.slice(0, 2).toUpperCase()}</span>}
                <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] bg-gradient-to-b from-white/10 to-transparent" />
              </button></Tooltip>
            </div>
          );
        })}
      </nav>
      {uploading ? (
        <StickerUploadForm
          key={userId}
          capacity={Math.max(0, MAX_PERSONAL_STICKERS - items.length)}
          onCancel={closeUpload}
          onAdded={(added, complete) => {
            // Newest first, the order the server lists the collection in.
            setItems(rows => {
              const ids = new Set(added.map(item => item.id));
              return [...[...added].reverse(), ...rows.filter(row => !ids.has(row.id))];
            });
            if (!complete) return;
            closeUpload();
            setManaging(false);
            setNotice(t('stickers.saved'));
          }}
        />
      ) : renaming ? (
        <StickerRenameForm
          key={renaming.id}
          sticker={renaming}
          onCancel={closeRename}
          onRenamed={updated => {
            setItems(rows => rows.map(row => (row.id === updated.id ? { ...row, name: updated.name } : row)));
            closeRename();
          }}
        />
      ) : (
        <>
          {activeTab === 'personal' ? (
            <>
              <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-2">
                <h3 className="text-sm font-semibold">
                  {t('stickers.title')}{' '}
                  <span className="ml-1 text-xs font-normal text-txt-tertiary">{!loading && items.length}</span>
                </h3>
                {manageable && (
                  <div className="flex items-center gap-1">
                    {items.length > 0 && (
                      <button
                        type="button"
                        disabled={!!removing}
                        aria-pressed={managing}
                        className="sticker-secondary-button"
                        onClick={() => setManaging(!managing)}
                      >
                        {t(managing ? 'stickers.done' : 'stickers.manage')}
                      </button>
                    )}
                    <button
                      type="button"
                      data-sticker-upload
                      disabled={loading || !!removing || full}
                      onClick={startUpload}
                      className="sticker-primary-button"
                    >
                      <span aria-hidden="true" className="text-lg leading-none">+</span>
                      {t('stickers.upload')}
                    </button>
                  </div>
                )}
              </div>
              {manageable && (
                <p className="px-4 pb-3 text-xs text-txt-tertiary">
                  {t(managing ? 'stickers.manageHint' : full ? 'stickers.full' : 'stickers.collectionHint')}
                </p>
              )}
              {items.length > 0 && (
                <StickerSearchInput value={search} onChange={setSearch} />
              )}
              {error && <p role="alert" className="mx-4 mb-3 rounded-lg bg-accent-rose/10 px-3 py-2 text-xs text-txt-danger">{error}</p>}
              {notice && <p role="status" className="mx-4 mb-2 text-xs text-txt-positive">{notice}</p>}
              {loading ? (
                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
                  <div role="status" aria-label={t('stickers.loading')} className="grid grid-cols-4 gap-2">
                    {Array.from({ length: 12 }, (_, index) => (
                      <div key={index} className="aspect-square rounded-xl bg-interactive-hover animate-pulse" />
                    ))}
                  </div>
                </div>
              ) : items.length === 0 ? (
                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-3">
                  {!error && (
                    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-center px-5">
                      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
                        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                          <path d="M20 13V7a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v9a4 4 0 0 0 4 4h6Zm-7 7v-3a4 4 0 0 1 4-4h3" />
                          <path d="M7.5 12a4 4 0 0 0 5 2M8 8h.01M15 8h.01" strokeLinecap="round" />
                        </svg>
                      </span>
                      <p className="text-sm font-medium">{t('stickers.empty')}</p>
                      <p className="text-xs leading-5 text-txt-tertiary">{t('stickers.emptyHint')}</p>
                      {manageable && (
                        <button type="button" onClick={startUpload} className="sticker-secondary-button">
                          {t('stickers.chooseImage')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <StickerGrid
                  items={visible}
                  noMatches={visible.length === 0}
                  managing={managing}
                  removing={removing}
                  onSelect={onSelect}
                  onRename={startRename}
                  onRemove={id => void remove(id)}
                />
              )}
            </>
          ) : activeTab === 'favorites' ? (
            <>
              <div className="flex shrink-0 items-center gap-2.5 px-4 pb-2 pt-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-[11px] bg-accent-amber/15 text-base text-accent-amber">★</span>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{t('stickers.favoritesTitle')}</h3>
                  <p className="text-ui-caption text-txt-tertiary">{t('stickers.stickersCount', { count: library?.favorites.length ?? 0 })}</p>
                </div>
              </div>
              {(library?.favorites.length ?? 0) > 0 && <StickerSearchInput value={search} onChange={setSearch} />}
              <TokenStickerGrid items={library?.favorites ?? []} query={search} onSelect={onSelect} />
            </>
          ) : currentPackDetail ? (
            <>
              <div className="flex shrink-0 items-center gap-2.5 px-4 pb-2 pt-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[11px] text-ui-micro font-bold text-white shadow-sm"
                  style={activeSpace?.icon ? undefined : { background: activeSpaceGradient?.gradient }}
                >
                  {activeSpace?.icon
                    ? (
                      <img
                        src={activeSpace.icon.startsWith('http') || activeSpace.icon.startsWith('/') ? activeSpace.icon : `/api/uploads/${activeSpace.icon}`}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )
                    : (activeSpace?.name.slice(0, 2).toUpperCase() ?? '::')}
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{currentPackDetail.name}</h3>
                  <p className="truncate text-ui-caption text-txt-tertiary">
                    {activeSpace?.name ?? t('stickers.packs')} · {t('stickers.stickersCount', { count: currentPackDetail.items.length })}
                  </p>
                </div>
              </div>
              {currentPackDetail.items.length > 0 && <StickerSearchInput value={search} onChange={setSearch} />}
              <PackStickerGrid pack={currentPackDetail} query={search} onSelect={onSelect} />
            </>
          ) : activeSpace ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
              <span
                className="flex h-14 w-14 items-center justify-center rounded-[18px] text-base font-bold text-white shadow-lg"
                style={activeSpace.icon ? undefined : { background: activeSpaceGradient?.gradient }}
              >
                {activeSpace.icon
                  ? (
                    <img
                      src={activeSpace.icon.startsWith('http') || activeSpace.icon.startsWith('/') ? activeSpace.icon : `/api/uploads/${activeSpace.icon}`}
                      alt=""
                      className="h-full w-full rounded-[18px] object-cover"
                    />
                  )
                  : activeSpace.name.slice(0, 2).toUpperCase()}
              </span>
              <div className="space-y-1.5">
                <h3 className="text-sm font-semibold text-txt-primary">{activeSpace.name}</h3>
                <p className="text-sm font-medium text-txt-secondary">{t('stickers.serverEmpty')}</p>
              </div>
              <p className="max-w-56 text-xs leading-5 text-txt-tertiary">{t('stickers.serverEmptyHint')}</p>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-4">
              <p className="text-xs text-txt-tertiary">{t('stickers.empty')}</p>
            </div>
          )}

          {/* Limits note */}
          <div className="shrink-0 border-t border-border-soft px-4 py-2.5 text-ui-caption text-txt-tertiary">{t('stickers.limits')}</div>

          {/* Bottom Tabs & Store Button */}
          <div className="shrink-0 flex items-center justify-between border-t border-border-soft px-3 py-1.5 bg-surface-base/50">
            <nav
              aria-label={t('stickers.collections')}
              className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5 px-1"
            >
              {/* Personal Stickers tab */}
              <Tooltip content={t('stickers.title')} position="top"><button
                type="button"
                onClick={() => setActiveTab('personal')}

                aria-label={t('stickers.title')}
                className={`shrink-0 flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                  activeTab === 'personal'
                    ? 'bg-white/[0.08] text-accent-primary shadow-sm ring-1 ring-inset ring-accent-primary/40'
                    : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-primary'
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
              </button></Tooltip>

              {library && library.favorites.length > 0 && (
                <Tooltip content={t('stickers.favoritesTitle')} position="top"><button aria-label={t('stickers.favoritesTitle')}
                  type="button"
                  onClick={() => setActiveTab('favorites')}


                  className={`shrink-0 flex h-7 w-7 items-center justify-center rounded-lg text-sm transition-colors ${
                    activeTab === 'favorites'
                      ? 'bg-accent-amber/10 text-accent-amber shadow-sm ring-1 ring-inset ring-accent-amber/30'
                      : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-primary'
                  }`}
                >
                  ★
                </button></Tooltip>
              )}

              {library?.privatePacks.map(pack => (
                <Tooltip content={pack.name} position="top"><button
                  key={pack.id}
                  type="button"
                  onClick={() => setActiveTab(`user:${pack.id}`)}

                  aria-label={pack.name}
                  className={`shrink-0 flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg text-ui-micro font-bold transition-colors ${
                    activeTab === `user:${pack.id}`
                      ? 'bg-white/[0.08] ring-1 ring-inset ring-accent-primary/50 text-accent-primary'
                      : 'text-txt-tertiary opacity-70 hover:bg-interactive-hover hover:text-txt-primary hover:opacity-100'
                  }`}
                >
                  {pack.items[0]
                    ? <img src={stickerPreviewUrl(pack.items[0].token) ?? ''} alt="" className="h-5 w-5 object-contain" />
                    : pack.name.slice(0, 1)}
                </button></Tooltip>
              ))}

              {library?.spaces.map(space => space.pack && (
                <Tooltip content={space.pack.name} position="top"><button
                  key={`pack:${space.spaceId}`}
                  type="button"
                  onClick={() => setActiveTab(`space:${space.spaceId}`)}

                  aria-label={space.pack.name}
                  className={`shrink-0 flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg text-ui-caption font-bold transition-colors ${
                    activeTab === `space:${space.spaceId}`
                      ? 'bg-white/[0.08] ring-1 ring-inset ring-accent-primary/50 text-accent-primary'
                      : 'text-txt-tertiary opacity-70 hover:bg-interactive-hover hover:text-txt-primary hover:opacity-100'
                  }`}
                >
                  {space.pack.items[0]
                    ? <img src={stickerPreviewUrl(space.pack.items[0].token) ?? ''} alt="" className="h-5 w-5 object-contain" />
                    : space.pack.name.slice(0, 1)}
                </button></Tooltip>
              ))}

              {/* Installed packs tabs */}
              {installedPacks.map(pack => {
                const firstItemToken = (pack as Partial<StickerPackDetail>).items?.[0]?.token;
                const cover =
                  stickerPreviewUrl(pack.coverUrl) ||
                  pack.coverUrl ||
                  (firstItemToken ? stickerPreviewUrl(firstItemToken) || stickerUrl(firstItemToken) : null);
                const tabId = `store:${pack.id}`;
                const isActive = activeTab === tabId;
                return (
                  <Tooltip content={pack.name} position="top"><button
                    key={pack.id}
                    type="button"
                    onClick={() => setActiveTab(tabId)}

                    aria-label={pack.name}
                    className={`shrink-0 flex h-7 w-7 items-center justify-center rounded-lg overflow-hidden transition-colors ${
                      isActive
                        ? 'bg-interactive-active ring-1 ring-inset ring-accent-primary text-txt-primary'
                        : 'opacity-70 hover:opacity-100 hover:bg-interactive-hover'
                    }`}
                  >
                    {cover ? (
                      <img src={cover} alt={pack.name} className="h-5 w-5 object-contain" />
                    ) : (
                      <span className="text-ui-caption font-bold">{pack.name[0]}</span>
                    )}
                  </button></Tooltip>
                );
              })}
            </nav>

            {/* Sticker Store modal button */}
            {manageable && (
              <Tooltip content={t('stickers.store')} position="top"><button
                type="button"
                onClick={() => setShowStore(true)}


                className="flex h-7 px-2 items-center gap-1.5 rounded-lg text-xs font-medium text-accent-primary hover:bg-accent-primary/10 transition-colors shrink-0 ml-1"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <path d="M16 10a4 4 0 0 1-8 0" />
                </svg>
                <span>{t('stickers.store')}</span>
              </button></Tooltip>
            )}
          </div>

          {showStore && (
            <StickerStoreModal
              spaceId={spaceId ?? undefined}
              onClose={() => setShowStore(false)}
              onPacksChanged={loadInstalledPacks}
            />
          )}
        </>
      )}
    </div>
  );
}
