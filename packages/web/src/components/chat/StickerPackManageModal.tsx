import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  MAX_STICKER_PACK_DESC_LENGTH,
  MAX_STICKER_PACK_NAME_LENGTH,
  MAX_STICKERS_PER_PACK,
  stickerUrl,
  stickerPreviewUrl,
  type StickerPackDetail,
  type StickerPackItem,
} from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { describeError } from '../../i18n/errors';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { useHomeInstanceInfo } from '../../hooks/useHomeInstanceInfo';
import './stickers.css';

interface StickerPackManageModalProps {
  packId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function StickerPackManageModal({ packId, onClose, onSaved }: StickerPackManageModalProps) {
  const { t } = useTranslation(['chat', 'common']);
  const homeInfo = useHomeInstanceInfo();
  const maxMb = homeInfo?.maxStickerSizeMb ?? 5;
  const maxBytes = maxMb * 1024 * 1024;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<StickerPackItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingItem, setUploadingItem] = useState(false);
  const [error, setError] = useState('');
  const [currentPackId, setCurrentPackId] = useState<string | null>(packId ?? null);

  useEffect(() => {
    if (!packId) return;
    setLoading(true);
    api.stickerStore.getCreated(packId)
      .then((pack: StickerPackDetail) => {
        setName(pack.name);
        setDescription(pack.description || '');
        setItems(pack.items || []);
        setCurrentPackId(pack.id);
      })
      .catch((err) => {
        setError(describeError(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [packId]);

  const handleFileUpload = async (files: FileList | File[]) => {
    setError('');
    let activeId = currentPackId;

    // If pack doesn't exist yet, create draft pack first
    if (!activeId) {
      const trimmed = name.trim();
      if (!trimmed) {
        setError(t('stickers.packName') + ' is required');
        return;
      }
      try {
        setSubmitting(true);
        const created = await api.stickerStore.createPack({
          name: trimmed,
          description: description.trim() || undefined,
        });
        activeId = created.id;
        setCurrentPackId(created.id);
      } catch (err) {
        setError(describeError(err));
        setSubmitting(false);
        return;
      } finally {
        setSubmitting(false);
      }
    }

    const availableSlots = MAX_STICKERS_PER_PACK - items.length;
    if (availableSlots <= 0) {
      setError(t('stickers.full'));
      return;
    }

    const filesToUpload = Array.from(files).slice(0, availableSlots);
    setUploadingItem(true);

    for (const file of filesToUpload) {
      if (file.size > maxBytes) {
        setError(t('stickers.invalidSize', { max: maxMb }));
        continue;
      }

      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = reader.result as string;
            const commaIndex = res.indexOf(',');
            resolve(commaIndex >= 0 ? res.slice(commaIndex + 1) : res);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const stickerName = file.name.replace(/\.[^/.]+$/, '').slice(0, 100);
        const added = await api.stickerStore.addItem(activeId, {
          name: stickerName,
          image: base64,
        });

        setItems((prev) => [...prev, added]);
      } catch (err) {
        setError(describeError(err));
        break;
      }
    }

    setUploadingItem(false);
  };

  const handleRemoveItem = async (itemId: string) => {
    if (!currentPackId) return;
    try {
      await api.stickerStore.removeItem(currentPackId, itemId);
      setItems((prev) => prev.filter((i) => i.id !== itemId));
    } catch (err) {
      setError(describeError(err));
    }
  };

  const handleSubmitForReview = async () => {
    if (!currentPackId) {
      const trimmed = name.trim();
      if (!trimmed) {
        setError(t('stickers.packName') + ' is required');
        return;
      }
      try {
        setSubmitting(true);
        const created = await api.stickerStore.createPack({
          name: trimmed,
          description: description.trim() || undefined,
        });
        setCurrentPackId(created.id);
        setError(t('stickers.emptyHint'));
        setSubmitting(false);
        return;
      } catch (err) {
        setError(describeError(err));
        setSubmitting(false);
        return;
      }
    }

    if (items.length === 0) {
      setError(t('stickers.emptyHint'));
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await api.stickerStore.submitReview(currentPackId);
      onSaved();
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const portalContainer = usePortalContainer();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && !submitting) {
      e.stopPropagation();
      onClose();
    }
  }, [onClose, submitting]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[520] flex items-center justify-center animate-fade-in"
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!submitting) onClose(); }} />
      <div className="relative w-full max-w-lg mx-4 glass-modal rounded-xl shadow-2xl flex flex-col max-h-[calc(90*var(--app-vh))] overflow-hidden animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-soft">
          <h3 className="text-base font-semibold text-txt-primary">
            {packId ? t('stickers.editPack') : t('stickers.createPack')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover transition-colors"
            aria-label={t('common:actions.close')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 scrollbar-thin">
          {error && (
            <div role="alert" className="p-3 rounded-xl bg-accent-rose/10 border border-accent-rose/20 text-xs text-txt-danger">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-txt-secondary mb-1.5">
              {t('stickers.packName')} *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_STICKER_PACK_NAME_LENGTH}
              placeholder={t('stickers.packName')}
              className="input-standard w-full text-sm"
              disabled={submitting}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-txt-secondary mb-1.5">
              {t('stickers.packDesc')}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={MAX_STICKER_PACK_DESC_LENGTH}
              rows={2}
              placeholder={t('stickers.packDesc')}
              className="input-standard w-full text-sm py-2 resize-none"
              disabled={submitting}
            />
          </div>

          {/* Sticker items list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-txt-secondary">
                {t('stickers.packs')} ({items.length}/{MAX_STICKERS_PER_PACK})
              </label>
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingItem || items.length >= MAX_STICKERS_PER_PACK}
                  className="sticker-secondary-button text-xs"
                >
                  + {t('stickers.addMore')}
                </button>
              )}
            </div>

            {items.length > 0 ? (
              <div className="grid grid-cols-4 gap-2.5 max-h-56 overflow-y-auto p-1 scrollbar-thin">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className="group relative aspect-square rounded-xl bg-surface-base/60 border border-border-soft p-2 flex flex-col items-center justify-center overflow-hidden"
                  >
                    <img
                      src={stickerPreviewUrl(item.token) || stickerUrl(item.token) || item.token.replace(/^sticker:/, '')}
                      alt={item.name}
                      className="max-h-full max-w-full object-contain pointer-events-none"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveItem(item.id)}
                      className="sticker-remove-button opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label={t('stickers.remove')}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                    <span className="absolute bottom-1 inset-x-1 truncate text-center text-[10px] text-txt-tertiary bg-surface-base/80 px-1 rounded">
                      {item.name}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="sticker-dropzone cursor-pointer"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files) handleFileUpload(e.dataTransfer.files);
                }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-txt-tertiary">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                </svg>
                <div className="text-center">
                  <p className="text-xs font-medium text-txt-primary">{t('stickers.dropImage')}</p>
                  <p className="text-[11px] text-txt-tertiary mt-0.5">{t('stickers.limits')}</p>
                </div>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFileUpload(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 px-6 py-4 border-t border-border-soft bg-surface-base/40">
          <button
            type="button"
            onClick={onClose}
            disabled={loading || submitting || uploadingItem}
            className="sticker-secondary-button"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmitForReview}
            disabled={loading || submitting || uploadingItem || items.length === 0}
            className="sticker-primary-button"
          >
            {submitting ? <span className="sticker-spinner" /> : t('stickers.submitReview')}
          </button>
        </div>
      </div>
    </div>,
    portalContainer,
  );
}
