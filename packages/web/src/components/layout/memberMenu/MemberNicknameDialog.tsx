import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_MEMBER_NICKNAME_LENGTH } from '@backspace/shared/src/constants';
import { Modal } from '../../ui/Modal';
import { getApiForOrigin } from '../../../stores/spaceStore';
import { applySpaceMemberUpdate } from '../../../stores/spaceMemberUpdates';
import { describeError } from '../../../i18n/errors';
import type { MemberTarget } from './memberRoleActions';

export function MemberNicknameDialog({ target, nickname, onClose }: {
  target: MemberTarget;
  nickname: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(['spaces', 'common', 'errors']);
  const [value, setValue] = useState(nickname ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);
  const close = () => { if (!writing.current) onClose(); };

  const save = async (next: string | null) => {
    if (writing.current) return;
    if (next !== null && (!next.trim() || next.trim().length > MAX_MEMBER_NICKNAME_LENGTH || /[\r\n]/.test(next))) {
      setError(t('errors:member_nickname_invalid'));
      return;
    }
    writing.current = true;
    setSaving(true);
    setError('');
    try {
      const member = await getApiForOrigin(target.origin).spaces.updateMember(target.spaceId, target.userId, { nickname: next });
      applySpaceMemberUpdate(target.origin, member);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      writing.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={close} title={t('spaces:members.nickname.title')}>
      <form onSubmit={e => { e.preventDefault(); void save(value.trim()); }} className="space-y-4">
        <p className="text-sm text-txt-secondary">{t('spaces:members.nickname.description')}</p>
        <label className="block text-sm text-txt-primary">
          {t('spaces:members.nickname.label')}
          <input autoFocus value={value} onChange={e => setValue(e.target.value)} maxLength={MAX_MEMBER_NICKNAME_LENGTH}
            disabled={saving} className="mt-2 w-full rounded bg-surface-input p-2 text-txt-primary" />
        </label>
        {error && <p role="alert" className="text-sm text-txt-danger">{error}</p>}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => void save(null)} disabled={saving} className="text-sm text-txt-secondary disabled:opacity-50">
            {t('spaces:members.nickname.reset')}
          </button>
          <button type="button" onClick={close} disabled={saving} className="text-sm text-txt-secondary disabled:opacity-50">{t('common:actions.cancel')}</button>
          <button type="submit" disabled={saving} className="rounded bg-accent-primary px-4 py-2 text-sm text-white disabled:opacity-50">
            {saving ? t('common:states.pleaseWait') : t('common:actions.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
