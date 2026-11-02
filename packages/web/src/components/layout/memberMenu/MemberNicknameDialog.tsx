import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_MEMBER_NICKNAME_LENGTH, normalizeMemberNickname } from '@backspace/shared/src/constants';
import { Modal } from '../../ui/Modal';
import { getApiForOrigin } from '../../../stores/spaceStore';
import { applySpaceMemberUpdate } from '../../../stores/spaceMemberUpdates';
import { describeError } from '../../../i18n/errors';
import type { MemberTarget } from './memberRoleActions';

/**
 * Sets or clears one member's nickname in one space. `accountName` is what
 * shows when there is no nickname; `self` picks the wording. The value is
 * checked with the server's own rule (`normalizeMemberNickname`) before it is
 * sent: an empty field clears the nickname, like Reset.
 */
export function MemberNicknameDialog({ target, nickname, accountName, self, onClose }: {
  target: MemberTarget;
  nickname: string | null;
  accountName: string;
  self: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation(['spaces', 'common', 'errors']);
  const [value, setValue] = useState(nickname ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);
  const close = () => { if (!writing.current) onClose(); };

  const save = async (raw: string | null) => {
    if (writing.current) return;
    const next = normalizeMemberNickname(raw);
    if (next === undefined) {
      setError(t('errors:member_nickname_invalid', { max: MAX_MEMBER_NICKNAME_LENGTH }));
      return;
    }
    if (next === nickname) {
      onClose();
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void save(value);
  };

  return (
    <Modal isOpen onClose={close} title={t('spaces:members.nickname.title')} mobileStyle="sheet">
      <form onSubmit={handleSubmit}>
        <p className="mb-4 text-sm text-txt-secondary">
          {self
            ? t('spaces:members.nickname.descriptionSelf')
            : t('spaces:members.nickname.descriptionOther', { name: accountName })}
        </p>

        {error && (
          <div role="alert" className="mb-3 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
            {error}
          </div>
        )}

        <div className="mb-4">
          <label htmlFor="member-nickname-input" className="block text-xs font-bold text-txt-secondary uppercase mb-2">
            {t('spaces:members.nickname.label')}
          </label>
          <input
            id="member-nickname-input"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={MAX_MEMBER_NICKNAME_LENGTH}
            placeholder={accountName}
            disabled={saving}
            className="input-standard w-full"
            autoFocus
          />
        </div>

        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-3 py-2 flex items-center gap-3 pointer-events-auto">
              {nickname !== null && (
                <button data-icon-motion="press"
                  type="button"
                  onClick={() => void save(null)}
                  disabled={saving}
                  className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
                >
                  {t('spaces:members.nickname.reset')}
                </button>
              )}
              <button data-icon-motion="press"
                type="button"
                onClick={close}
                disabled={saving}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
              >
                {t('common:actions.cancel')}
              </button>
              <button data-icon-motion="press"
                type="submit"
                disabled={saving}
                className="ui-button ui-button-primary transition-colors disabled:opacity-50"
              >
                {saving ? t('common:states.pleaseWait') : t('common:actions.save')}
              </button>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}
