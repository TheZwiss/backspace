import { MAX_OWNER_TITLE_LENGTH } from '@backspace/shared/src/constants.js';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describeError } from '../../i18n/errors';
import { useFormatters } from '../../i18n/formatters';
import { useAuthStore } from '../../stores/authStore';
import { getMyUserIdForOrigin, useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { Modal } from '../ui/Modal';

function OwnerTitleEditor({ space, onClose }: { space: TaggedSpace; onClose: () => void }) {
  const { t } = useTranslation(['spaces', 'common', 'errors']);
  const updateSpace = useSpaceStore((s) => s.updateSpace);
  const [title, setTitle] = useState(space.ownerTitle ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (ownerTitle: string | null) => {
    setSaving(true);
    setError('');
    try {
      // The store publishes only the server response; failed writes never change the heading.
      await updateSpace(space.id, { ownerTitle });
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > MAX_OWNER_TITLE_LENGTH || /[\r\n]/.test(trimmed)) {
      setError(t('errors:space_owner_title_invalid', { max: MAX_OWNER_TITLE_LENGTH }));
      return;
    }
    void save(trimmed);
  };

  return (
    <Modal isOpen onClose={() => { if (!saving) onClose(); }} title={t('spaces:members.ownerTitle.edit')}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="space-owner-title" className="block text-sm font-medium text-txt-primary mb-2">
            {t('spaces:members.ownerTitle.label')}
          </label>
          <input
            id="space-owner-title"
            autoFocus
            required
            maxLength={MAX_OWNER_TITLE_LENGTH}
            value={title}
            disabled={saving}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('spaces:members.groups.owner')}
            aria-describedby="space-owner-title-hint"
            className="input-standard w-full"
          />
          <p id="space-owner-title-hint" className="text-xs text-txt-tertiary mt-2">
            {t('spaces:members.ownerTitle.hint', { max: MAX_OWNER_TITLE_LENGTH })}
          </p>
        </div>
        {error && <p role="alert" className="text-sm text-txt-danger">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button type="button" disabled={saving || space.ownerTitle === null} onClick={() => void save(null)} className="mr-auto text-xs text-txt-secondary hover:text-txt-primary disabled:opacity-50">
            {t('spaces:members.ownerTitle.reset')}
          </button>
          <button type="button" disabled={saving} onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-txt-secondary hover:bg-interactive-hover disabled:opacity-50">
            {t('common:actions.cancel')}
          </button>
          <button type="submit" disabled={saving} className="px-3 py-2 rounded-lg text-sm bg-accent-primary text-white disabled:opacity-50">
            {saving ? t('common:states.saving') : t('common:actions.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The heading is cosmetic: only the actual owner sees the editor, regardless of role permissions. */
export function OwnerTitleHeading({ space, count }: { space: TaggedSpace; count: number }) {
  const { t } = useTranslation('spaces');
  const { formatNumber } = useFormatters();
  const homeUserId = useAuthStore((s) => s.user?.id);
  // Federated owners have an instance-local user ID on the space's host.
  const userId = space._instanceOrigin ? getMyUserIdForOrigin(space._instanceOrigin) : homeUserId;
  const [editing, setEditing] = useState(false);
  const canEdit = userId === space.ownerId;
  const title = space.ownerTitle ?? t('members.groups.owner');

  return (
    <>
      <div className="flex items-center gap-1 px-2 mb-1">
        <h3 title={title} className={`min-w-0 truncate text-[10.5px] font-bold text-txt-tertiary tracking-[0.06em] ${space.ownerTitle === null ? 'uppercase' : ''}`}>
          {title} — {formatNumber(count)}
        </h3>
        {canEdit && (
          <button type="button" onClick={() => setEditing(true)} aria-label={t('members.ownerTitle.edit')} title={t('members.ownerTitle.edit')} className="shrink-0 p-1 rounded text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m16 3 5 5M4 15 16 3l5 5L9 20l-6 1 1-6Z" />
            </svg>
          </button>
        )}
      </div>
      {canEdit && editing && <OwnerTitleEditor space={space} onClose={() => setEditing(false)} />}
    </>
  );
}
