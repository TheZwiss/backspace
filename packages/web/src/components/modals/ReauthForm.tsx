import React, { useId, useState } from 'react';
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
 * The re-authentication form: the home password, Connect, Cancel, and the
 * error under the field it is about. The Connections row and the Explore
 * page's connection chips render the same component so the two cannot
 * drift. It calls `reauthenticateInstance`, which drops the stale session
 * and re-runs the standard connect flow against the home password.
 *
 * The form is one column at every width: label, field, error, actions. It
 * carries no surface of its own, so each host places it on the panel or row
 * it already has, and it takes the width it is given rather than setting
 * one. The error sits under the field, inside the same block, so it lines
 * up with what it is about and wraps instead of widening the host.
 *
 * Escape cancels while the form is idle, and stops there rather than
 * reaching whatever else listens for it (the settings modal behind the
 * Connections row). While a submit is in flight both Cancel and Escape are
 * inert, because the action they would undo is already running.
 */
export function ReauthForm({ origin, username, onDone, onCancel, className = '' }: ReauthFormProps) {
  const { t } = useTranslation(['federation', 'common']);
  const reauthenticateInstance = useInstanceStore((s) => s.reauthenticateInstance);
  const fieldId = useId();

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || loading) return;
    e.stopPropagation();
    handleCancel();
  };

  return (
    <form
      onSubmit={(e) => { void handleSubmit(e); }}
      onKeyDown={handleKeyDown}
      className={`space-y-2.5 ${className}`}
    >
      <input type="text" autoComplete="username" value={username} readOnly tabIndex={-1} className="sr-only" />
      {/* One block, capped at a password's reading width: the label, the
          field and the error under it keep the same edges in a narrow chip
          panel and in the width of a settings row. */}
      <div className="max-w-sm">
        <label htmlFor={fieldId} className="block text-[11px] text-txt-tertiary mb-1">
          {t('federation:connections.row.homePasswordLabel')}
        </label>
        <input
          id={fieldId}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input-standard w-full"
          disabled={loading}
          autoFocus
          autoComplete="current-password"
        />
        {error && (
          <p className="mt-1.5 px-2 py-1.5 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs break-words">
            {error}
          </p>
        )}
      </div>
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
    </form>
  );
}
