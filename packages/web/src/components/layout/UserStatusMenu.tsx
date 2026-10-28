import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChosenUserStatus } from '@backspace/shared';
import { selectMyChosenStatus, useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { CHOSEN_STATUS_OPTIONS } from '../../utils/statusOptions';
import { describeError } from '../../i18n/errors';
import { Avatar } from '../ui/Avatar';
import { PresenceIndicator } from '../ui/PresenceIndicator';

/**
 * Status switcher opened from the user block at the bottom of the channel
 * sidebar. The chosen status is owned by the true home when this session is a
 * replicated row, so writes go through `authStore.updateProfile` — the same
 * path the account settings use — rather than writing the page user directly.
 */
export function UserStatusMenu({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['spaces', 'common']);
  const user = useAuthStore((s) => s.user);
  const savedStatus: ChosenUserStatus = useAuthStore(selectMyChosenStatus) ?? 'online';
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const openModal = useUIStore((s) => s.openModal);

  const [customStatus, setCustomStatus] = useState(user?.customStatus ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setCustomStatus(user?.customStatus ?? '');
  }, [user?.customStatus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!user) return null;

  const applyStatus = async (next: ChosenUserStatus) => {
    if (pending) return;
    if (next === savedStatus) {
      onClose();
      return;
    }
    setError('');
    setPending(true);
    try {
      await updateProfile({ status: next });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? describeError(err) : t('spaces:sidebar.userArea.statusUpdateFailed'));
    } finally {
      setPending(false);
    }
  };

  const saveCustomStatus = async (value: string) => {
    if (pending) return;
    setError('');
    setPending(true);
    try {
      await updateProfile({ customStatus: value.trim() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? describeError(err) : t('spaces:sidebar.userArea.statusUpdateFailed'));
    } finally {
      setPending(false);
    }
  };

  const openProfileSettings = () => {
    onClose();
    openModal('userSettings', { tab: 'account' });
  };

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 bg-surface-channel rounded-t-lg shadow-lg z-[150] border border-border-hard"
      data-testid="user-status-menu"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-soft">
        <Avatar src={user.avatar} name={user.displayName ?? user.username} size={32} status={savedStatus} user={user} />
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-txt-primary truncate leading-tight">
            {user.displayName ?? user.username}
          </div>
          <div className="text-[11px] text-txt-tertiary truncate leading-tight">@{user.username}</div>
        </div>
      </div>

      <div role="menu" className="py-1">
        {CHOSEN_STATUS_OPTIONS.map((option) => {
          const active = option.value === savedStatus;
          return (
            <button
              key={option.value}
              role="menuitemradio"
              aria-checked={active}
              disabled={pending}
              onClick={() => void applyStatus(option.value)}
              className="w-full px-3 py-1.5 flex items-center gap-2.5 text-left text-[13.5px] text-txt-secondary hover:bg-interactive-hover hover:text-txt-primary transition-colors disabled:opacity-50"
            >
              <PresenceIndicator status={option.value} size={15} />
              <span className="flex-1 truncate">{t(option.labelKey)}</span>
              {active && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-txt-primary flex-shrink-0">
                  <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
              )}
            </button>
          );
        })}
      </div>

      <div className="px-3 py-2 border-t border-border-soft">
        <label className="block text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1">
          {t('spaces:sidebar.userArea.customStatus')}
        </label>
        <input
          type="text"
          value={customStatus}
          maxLength={128}
          placeholder={t('spaces:sidebar.userArea.customStatusPlaceholder')}
          onChange={(e) => setCustomStatus(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void saveCustomStatus(customStatus);
            }
          }}
          className="input-standard w-full text-[13px]"
        />
        <div className="flex items-center justify-end gap-2 mt-2">
          <button
            onClick={() => {
              setCustomStatus('');
              void saveCustomStatus('');
            }}
            disabled={pending || (user.customStatus ?? '') === ''}
            className="px-2.5 py-1 text-[12px] text-txt-tertiary hover:text-txt-primary transition-colors disabled:opacity-40"
          >
            {t('common:actions.clear')}
          </button>
          <button
            onClick={() => void saveCustomStatus(customStatus)}
            disabled={pending}
            className="px-2.5 py-1 bg-accent-primary hover:bg-accent-primary/80 text-white text-[12px] font-medium rounded-full transition-colors disabled:opacity-50"
          >
            {t('common:actions.save')}
          </button>
        </div>
        {error && <div className="mt-1.5 text-[11.5px] text-accent-rose">{error}</div>}
      </div>

      <button
        onClick={openProfileSettings}
        className="w-full px-3 py-2 border-t border-border-soft flex items-center justify-between text-left text-[13px] text-txt-secondary hover:bg-interactive-hover hover:text-txt-primary transition-colors rounded-b-none"
      >
        <span>{t('spaces:sidebar.userArea.editProfile')}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
          <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
      </button>
    </div>
  );
}
