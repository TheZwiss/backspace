import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_STICKER_BYTES, type PersonalSticker } from '@backspace/shared/src/stickers';
import { uploadSticker } from './stickerUpload';

interface StickerUploadFormProps {
  onAdded: (stickers: PersonalSticker | PersonalSticker[]) => void;
  onCancel: () => void;
}

interface UploadItem {
  id: string;
  file: File;
  preview: string;
  name: string;
  ready: boolean;
}

/** Pre-validates each file before creating blob URLs to fail fast on invalid format or size. */
function validateFiles(files: File[]): 'stickers.invalidSize' | 'stickers.invalidType' | null {
  for (const file of files) {
    if (!file.size || file.size > MAX_STICKER_BYTES) {
      return 'stickers.invalidSize';
    }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      return 'stickers.invalidType';
    }
  }
  return null;
}

function createUploadItem(file: File): UploadItem {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    file,
    preview: URL.createObjectURL(file),
    name: file.name.replace(/\.[^.]+$/, '').slice(0, 100),
    ready: false,
  };
}

/**
 * Supports single and batch sticker uploads.
 * Original files stay local until explicit confirmation; animated previews are never flattened.
 */
export function StickerUploadForm({ onAdded, onCancel }: StickerUploadFormProps) {
  const { t } = useTranslation('chat');
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const selectModeRef = useRef<'replace' | 'append'>('replace');
  const nameId = useId();

  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const active = useRef(true);
  const submitting = useRef(false);

  // Revoke blob URLs for any items removed from state to prevent memory leaks.
  const updateItems = (updater: (prev: UploadItem[]) => UploadItem[]) => {
    setItems(prev => {
      const next = updater(prev);
      const nextIds = new Set(next.map(i => i.id));
      for (const item of prev) {
        if (!nextIds.has(item.id)) {
          URL.revokeObjectURL(item.preview);
        }
      }
      return next;
    });
  };

  useEffect(() => {
    active.current = true;
    chooseRef.current?.focus();
    return () => {
      active.current = false;
      // Revoke all remaining object URLs on unmount
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.preview);
      }
    };
  }, []);

  const openPicker = (mode: 'replace' | 'append') => {
    selectModeRef.current = mode;
    inputRef.current?.click();
  };

  const choose = (files: File[], mode: 'replace' | 'append' = 'replace') => {
    if (busy || !files.length) return;
    setDragging(false);
    setError('');
    const errorKey = validateFiles(files);
    if (errorKey) {
      setError(t(errorKey));
      return;
    }
    const newItems = files.map(createUploadItem);
    if (mode === 'append') {
      updateItems(prev => [...prev, ...newItems]);
    } else {
      updateItems(() => newItems);
    }
  };

  const updateName = (id: string, name: string) => {
    setItems(prev => prev.map(item => (item.id === id ? { ...item, name } : item)));
  };

  const markReady = (id: string, ready: boolean) => {
    setItems(prev => prev.map(item => (item.id === id ? { ...item, ready } : item)));
  };

  const removeItem = (id: string) => {
    updateItems(prev => prev.filter(item => item.id !== id));
  };

  const isAllReady =
    items.length > 0 && items.every(item => item.ready && item.name.trim().length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isAllReady || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const results = await Promise.all(
        items.map(item => uploadSticker(item.file, item.name.trim()))
      );
      if (active.current) {
        onAdded(results.length === 1 ? results[0]! : results);
      }
    } catch (err) {
      if (active.current) setError((err as Error).message);
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  };

  const singleItem = items.length === 1 ? items[0] : null;

  return (
    <form
      onSubmit={event => void submit(event)}
      className="flex min-h-0 flex-1 flex-col"
      onPaste={event => {
        if (!event.clipboardData.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        choose(Array.from(event.clipboardData.files), items.length === 1 ? 'replace' : 'append');
      }}
    >
      <div className="flex items-center justify-between border-b border-border-soft px-4 py-3">
        <h3 className="text-sm font-semibold">{t('stickers.upload')}</h3>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="sticker-icon-button"
          aria-label={t('stickers.cancel')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4 space-y-3">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          disabled={busy}
          aria-label={t('stickers.chooseImage')}
          onChange={event => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) choose(files, selectModeRef.current);
          }}
        />

        {items.length === 0 && (
          <button
            ref={chooseRef}
            type="button"
            disabled={busy}
            onClick={() => openPicker('replace')}
            aria-label={t('stickers.chooseImage')}
            onDragOver={event => {
              event.preventDefault();
              event.stopPropagation();
              if (!busy) setDragging(true);
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
            }}
            onDrop={event => {
              event.preventDefault();
              event.stopPropagation();
              choose(Array.from(event.dataTransfer.files), 'replace');
            }}
            className={`sticker-dropzone ${dragging ? 'sticker-dropzone-active' : ''}`}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <path d="m3 16 5-5 5 5 3-3 5 5" />
                <circle cx="15.5" cy="8.5" r="1.5" />
              </svg>
            </span>
            <span className="text-sm font-medium">{t('stickers.dropImage')}</span>
            <span className="text-xs text-txt-tertiary">{t('stickers.pasteHint')}</span>
          </button>
        )}

        {singleItem && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => openPicker('replace')}
              aria-label={t('stickers.replace')}
              onDragOver={event => {
                event.preventDefault();
                event.stopPropagation();
                if (!busy) setDragging(true);
              }}
              onDragLeave={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={event => {
                event.preventDefault();
                event.stopPropagation();
                choose(Array.from(event.dataTransfer.files), 'replace');
              }}
              className={`sticker-dropzone ${dragging ? 'sticker-dropzone-active' : ''} sticker-checkerboard`}
            >
              <img
                key={singleItem.preview}
                src={singleItem.preview}
                alt={t('stickers.preview')}
                className="h-36 w-full object-contain"
                onLoad={() => markReady(singleItem.id, true)}
                onError={() => {
                  markReady(singleItem.id, false);
                  setError(t('stickers.invalidImage'));
                }}
              />
            </button>
            <div className="flex items-center justify-between gap-3 text-xs text-txt-tertiary">
              <span className="truncate" title={singleItem.file.name}>{singleItem.file.name}</span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className="text-txt-link hover:underline"
                  onClick={() => openPicker('append')}
                >
                  + {t('stickers.addMore')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="text-txt-link hover:underline"
                  onClick={() => openPicker('replace')}
                >
                  {t('stickers.replace')}
                </button>
              </div>
            </div>
            <div>
              <label htmlFor={nameId} className="mb-1.5 block text-xs font-medium text-txt-secondary">
                {t('stickers.name')}
              </label>
              <input
                id={nameId}
                value={singleItem.name}
                disabled={busy}
                maxLength={100}
                onChange={event => updateName(singleItem.id, event.target.value)}
                className="input-search w-full"
                placeholder={t('stickers.name')}
              />
            </div>
          </>
        )}

        {items.length > 1 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-txt-secondary">
                {t('stickers.selectedCount', { count: items.length })}
              </span>
              <button
                type="button"
                disabled={busy}
                className="text-xs text-accent-primary hover:underline font-medium"
                onClick={() => openPicker('append')}
              >
                + {t('stickers.addMore')}
              </button>
            </div>

            <div className="space-y-2 max-h-56 overflow-y-auto pr-1 scrollbar-thin">
              {items.map((item, index) => (
                <div key={item.id} className="flex items-center gap-2.5 rounded-lg border border-border-soft bg-surface-primary/50 p-2">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-soft bg-surface-secondary sticker-checkerboard">
                    <img
                      src={item.preview}
                      alt={t('stickers.preview')}
                      className="h-full w-full object-contain"
                      onLoad={() => markReady(item.id, true)}
                      onError={() => {
                        markReady(item.id, false);
                        setError(t('stickers.invalidImage'));
                      }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center justify-between gap-1 text-[11px] text-txt-tertiary">
                      <span className="truncate" title={item.file.name}>{item.file.name}</span>
                      <span className="shrink-0">{(item.file.size / 1024).toFixed(0)} KB</span>
                    </div>
                    <input
                      value={item.name}
                      disabled={busy}
                      maxLength={100}
                      placeholder={t('stickers.name')}
                      aria-label={`${t('stickers.name')} #${index + 1}`}
                      onChange={event => updateName(item.id, event.target.value)}
                      className="input-search h-7 w-full text-xs px-2 py-1"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeItem(item.id)}
                    className="sticker-icon-button shrink-0 text-txt-tertiary hover:text-txt-danger"
                    aria-label={t('stickers.removeNamed', { name: item.name || item.file.name })}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <path d="m6 6 12 12M6 18 18 6" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>

            <div
              role="button"
              tabIndex={0}
              onClick={() => openPicker('append')}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openPicker('append');
                }
              }}
              onDragOver={event => {
                event.preventDefault();
                event.stopPropagation();
                if (!busy) setDragging(true);
              }}
              onDragLeave={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={event => {
                event.preventDefault();
                event.stopPropagation();
                choose(Array.from(event.dataTransfer.files), 'append');
              }}
              className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed py-2.5 text-xs text-txt-tertiary transition-colors hover:border-accent-primary/50 hover:text-txt-primary ${
                dragging ? 'border-accent-primary bg-accent-primary/5 text-accent-primary' : 'border-border-soft'
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>{t('stickers.dropMore')}</span>
            </div>
          </div>
        )}

        {items.length === 0 && (
          <p className="text-center text-[11px] text-txt-tertiary">{t('stickers.limits')}</p>
        )}

        {error && (
          <p role="alert" className="rounded-lg bg-accent-rose/10 px-3 py-2 text-xs text-txt-danger">
            {error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-soft px-4 py-3">
        <button type="button" disabled={busy} onClick={onCancel} className="sticker-secondary-button">
          {t('stickers.cancel')}
        </button>
        <button type="submit" disabled={!isAllReady || busy} className="sticker-primary-button">
          {busy && <span className="sticker-spinner" aria-hidden="true" />}
          <span role={busy ? 'status' : undefined}>{t(busy ? 'stickers.uploading' : 'stickers.save')}</span>
        </button>
      </div>
    </form>
  );
}
