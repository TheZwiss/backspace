import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInstanceStore } from '../../stores/instanceStore';
import { describeError } from '../../i18n/errors';

export interface ReauthFormProps {
  /** The instance whose session expired. */
  origin: string;
  /**
   * The account's username on that instance. It is rendered into a visually
   * hidden username field so password managers key the saved password on it.
   */
  username: string;
  /** Called once the new session is up; the caller closes the form. */
  onDone: () => void;
  onCancel: () => void;
  /** Layout classes for the form element; the fields and buttons are fixed. */
  className?: string;
}

/**
 * The one-line re-authentication form: the home password, Connect, Cancel,
 * and the described error under the row. The Connections row and the
 * Explore page's connection chips render the same component so the two
 * cannot drift. It calls `reauthenticateInstance`, which drops the stale
 * session and re-runs the standard connect flow against the home password.
 *
 * On the desktop shell the row is one line, the field taking the width the
 * host gives it. On the mobile shell the row wraps: the field keeps a
 * minimum width and the two buttons move under it when the host is narrower
 * than that plus the buttons, which is how the form stacks inside a chip on
 * a phone.
 */
export function ReauthForm({ origin, username, onDone, onCancel, className = '' }: ReauthFormProps) {
  const { t } = useTranslation(['federation', 'common']);
  const reauthenticateInstance = useInstanceStore((s) => s.reauthenticateInstance);

  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || loading) return;
    setError('');
    setLoading(true);
    try {
      await reauthenticateInstance(origin, password);
      setPassword('');
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setPassword('');
    setError('');
    onCancel();
  };

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className={`space-y-2 ${className}`}>
      <input type="text" autoComplete="username" value={username} readOnly tabIndex={-1} className="sr-only" />
      <div className="flex flex-wrap desktop:flex-nowrap items-center gap-2">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('federation:connections.row.homePasswordPlaceholder')}
          className="input-standard flex-1 basis-[180px] min-w-0 py-1.5"
          disabled={loading}
          autoFocus
          autoComplete="current-password"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={loading || !password}
            className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
          >
            {loading ? t('federation:connections.add.connecting') : t('federation:connections.add.connect')}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={loading}
            className="px-2 py-1.5 text-xs text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
        </div>
      </div>
      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">
          {error}
        </div>
      )}
    </form>
  );
}
