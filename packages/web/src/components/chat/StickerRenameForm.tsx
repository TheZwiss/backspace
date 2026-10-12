import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_STICKER_NAME_LENGTH, normalizeStickerName, stickerUrl, type PersonalSticker } from '@backspace/shared/src/stickers';
import { api } from '../../api/client';
import { describeError } from '../../i18n/errors';
import { usePickerEscapeClaim } from './pickerEscape';

interface StickerRenameFormProps {
  sticker: PersonalSticker;
  /** Called with the stored entry once the server accepted the new name. */
  onRenamed: (sticker: PersonalSticker) => void;
  onCancel: () => void;
}

/**
 * Renames one collection entry. It takes the picker's place, like the upload
 * form, instead of floating over it: the picker already sits in a popover or
 * a sheet that closes on an outside click, so a portaled dialog would close
 * the picker that owns it. The name is checked with the server's own rule
 * (`normalizeStickerName`) before it is sent. Escape cancels it, except
 * while the new name is being saved, and only the next Escape closes the
 * picker.
 */
export function StickerRenameForm({ sticker, onRenamed, onCancel }: StickerRenameFormProps) {
  const { t } = useTranslation(['chat', 'errors']);
  const headingId = useId();
  const inputId = useId();
  const [name, setName] = useState(sticker.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);

  usePickerEscapeClaim(() => {
    if (!writing.current) onCancel();
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (writing.current) return;
    const next = normalizeStickerName(name);
    if (next === undefined) {
      setError(t('errors:sticker_name_invalid', { max: MAX_STICKER_NAME_LENGTH }));
      return;
    }
    if (next === sticker.name) {
      onCancel();
      return;
    }
    writing.current = true;
    setSaving(true);
    setError('');
    try {
      onRenamed(await api.stickers.rename(sticker.id, next));
    } catch (err) {
      setError(describeError(err));
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };

  return (
    <form onSubmit={event => void submit(event)} aria-labelledby={headingId} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border-soft px-4 py-3">
        <h3 id={headingId} className="text-sm font-semibold">{t('chat:stickers.renameTitle')}</h3>
        <button type="button" disabled={saving} onClick={onCancel} className="sticker-icon-button" aria-label={t('chat:stickers.cancel')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4 space-y-3">
        <div className="flex min-h-40 items-center justify-center rounded-xl border border-border-soft bg-surface-input/40 p-4 sticker-checkerboard">
          <img src={stickerUrl(sticker.token) ?? undefined} alt={sticker.name} className="h-32 w-full object-contain" />
        </div>
        <div>
          <label htmlFor={inputId} className="mb-1.5 block text-xs font-medium text-txt-secondary">
            {t('chat:stickers.name')}
          </label>
          <input
            id={inputId}
            value={name}
            disabled={saving}
            maxLength={MAX_STICKER_NAME_LENGTH}
            autoFocus
            onChange={event => {
              setName(event.target.value);
              setError('');
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
            className="input-search w-full"
            placeholder={t('chat:stickers.name')}
          />
        </div>
        {error && (
          <p id={`${inputId}-error`} role="alert" className="rounded-lg bg-accent-rose/10 px-3 py-2 text-xs text-txt-danger">
            {error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-soft px-4 py-3">
        <button type="button" disabled={saving} onClick={onCancel} className="sticker-secondary-button">
          {t('chat:stickers.cancel')}
        </button>
        <button type="submit" disabled={saving || !name.trim()} className="sticker-primary-button">
          {saving && <span className="sticker-spinner" aria-hidden="true" />}
          {t('chat:stickers.rename')}
        </button>
      </div>
    </form>
  );
}
