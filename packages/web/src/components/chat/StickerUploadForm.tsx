import { StickerUploadPreview, type UploadItem } from './StickerUploadPreview';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_STICKER_BATCH, MAX_STICKER_BYTES, MAX_STICKER_NAME_LENGTH, type PersonalSticker } from '@backspace/shared/src/stickers';
import { uploadSticker } from './stickerUpload';
import { describeError } from '../../i18n/errors';
import { HttpError } from '../../api/client';
import { useHomeInstanceInfo } from '../../hooks/useHomeInstanceInfo';
import { usePickerEscapeClaim } from './pickerEscape';

interface StickerUploadFormProps {
  /**
   * The stickers the server accepted. `complete` is false when some images
   * were refused; those stay in the form with their reason, so the form stays open.
   */
  onAdded: (stickers: PersonalSticker[], complete: boolean) => void;
  onCancel: () => void;
  /** How many more stickers the collection can take. */
  capacity: number;
}

/** A refusal that every later upload in the batch would meet too. */
function stopsBatch(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 429 || error.code === 'sticker_collection_full');
}

/** Pre-validates each file before creating blob URLs to fail fast on invalid format or size. */
function validateFiles(files: File[], maxBytes: number = MAX_STICKER_BYTES): 'stickers.invalidSize' | 'stickers.invalidType' | null {
  for (const file of files) {
    if (!file.size || file.size > maxBytes) {
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
    name: file.name.replace(/\.[^.]+$/, '').slice(0, MAX_STICKER_NAME_LENGTH),
    ready: false,
    error: null,
  };
}

/**
 * Supports single and batch sticker uploads.
 * Original files stay local until explicit confirmation; animated previews are never flattened.
 * A batch is sent one image at a time: what the server accepted leaves the
 * form, what it refused stays with its reason.
 */
export function StickerUploadForm({ onAdded, onCancel, capacity }: StickerUploadFormProps) {
  const { t } = useTranslation('chat');
  const homeInfo = useHomeInstanceInfo();
  const maxMb = homeInfo?.maxStickerSizeMb ?? 5;
  const maxBytes = maxMb * 1024 * 1024;
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const selectModeRef = useRef<'replace' | 'append'>('replace');

  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState('');

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const active = useRef(true);
  const submitting = useRef(false);

  usePickerEscapeClaim(() => {
    if (!submitting.current) onCancel();
  });

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
    const errorKey = validateFiles(files, maxBytes);
    if (errorKey) {
      setError(t(errorKey, { max: maxMb }));
      return;
    }
    const limit = Math.min(MAX_STICKER_BATCH, capacity);
    const total = mode === 'append' ? itemsRef.current.length + files.length : files.length;
    if (total > limit) {
      setError(limit < MAX_STICKER_BATCH
        ? t('stickers.capacityLimit', { count: limit })
        : t('stickers.batchLimit', { count: limit }));
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
    setItems(prev => prev.map(item => (item.id === id ? { ...item, name, error: null } : item)));
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
    const batch = items;
    const added: PersonalSticker[] = [];
    const accepted = new Set<string>();
    const refused = new Map<string, string>();
    let stopped: string | null = null;
    for (const [index, item] of batch.entries()) {
      if (!active.current) break;
      setProgress({ current: index + 1, total: batch.length });
      try {
        added.push(await uploadSticker(item.file, item.name.trim(), maxBytes));
        accepted.add(item.id);
      } catch (err) {
        if (stopsBatch(err)) {
          stopped = describeError(err);
          break;
        }
        refused.set(item.id, describeError(err));
      }
    }
    submitting.current = false;
    if (!active.current) return;
    setProgress(null);
    setBusy(false);
    updateItems(prev => prev
      .filter(item => !accepted.has(item.id))
      .map(item => ({ ...item, error: refused.get(item.id) ?? null })));
    if (stopped) {
      setError(stopped);
    } else if (refused.size === 1 && batch.length === 1) {
      setError([...refused.values()][0]!);
    } else if (refused.size > 0) {
      setError(t('stickers.batchFailed', { count: refused.size }));
    }
    if (added.length > 0 || (!stopped && refused.size === 0)) {
      onAdded(added, !stopped && refused.size === 0);
    }
  };

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

        <StickerUploadPreview
          items={items} busy={busy} dragging={dragging} chooseRef={chooseRef}
          openPicker={openPicker} choose={choose} setDragging={setDragging}
          markReady={markReady} updateName={updateName} removeItem={removeItem} setError={setError}
        />

        {items.length === 0 && (
          <p className="text-center text-[11px] text-txt-tertiary">{t('stickers.limits', { max: maxMb })}</p>
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
          <span role={busy ? 'status' : undefined}>
            {progress && progress.total > 1
              ? t('stickers.uploadingProgress', progress)
              : t(busy ? 'stickers.uploading' : 'stickers.save')}
          </span>
        </button>
      </div>
    </form>
  );
}
