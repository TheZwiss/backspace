import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInstanceStore, DifferentPasswordError } from '../../stores/instanceStore';
import { describeError } from '../../i18n/errors';
import { FallbackForm } from './RemotePasswordStep';

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
  /** Layout classes for the surface; the fields and buttons are fixed. */
  className?: string;
}

/**
 * The re-authentication surface: the home password, Connect, Cancel, and the
 * error under the field it is about. The Connections row and the Explore
 * page's connection chips render the same component so the two cannot
 * drift. It calls `reauthenticateInstance`, which drops the stale session
 * and re-runs the standard connect flow against the home password.
 *
 * It is one column at every width: label, field, error, actions. It carries
 * no surface of its own, so each host places it on the panel or row it
 * already has, and it takes the width it is given rather than setting one.
 * The error sits under the field, inside the same block, so it lines up
 * with what it is about and wraps instead of widening the host.
 *
 * **The different-password way out.** An instance that has an account for
 * this user which does not accept the credential the home issued answers
 * with `DifferentPasswordError`, and no home password can fix that. The
 * surface then moves to the second phase, the same `FallbackForm` the
 * Connections add flow and the connect-and-join dialog use, prefilled with
 * the username the error carries; `loginToRemote` restores the connection
 * from the password that account has of its own, exactly as the add flow
 * restores it. There is no Back, because the password the first phase asks
 * for is not what the instance refused.
 *
 * Escape cancels while the surface is idle, in either phase. It never
 * travels past this surface, in any state, because the settings modal behind
 * the Connections row closes on Escape from a document listener: during a
 * submit the key is swallowed and does nothing, exactly as Cancel does,
 * rather than being let through to close the modal around a running request.
 */
export function ReauthForm({ origin, username, onDone, onCancel, className = '' }: ReauthFormProps) {
  const { t } = useTranslation(['federation', 'common']);
  const reauthenticateInstance = useInstanceStore((s) => s.reauthenticateInstance);
  const loginToRemote = useInstanceStore((s) => s.loginToRemote);
  const fieldId = useId();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** `password` asks the home password; `fallback` asks the account's own password on this instance. */
  const [phase, setPhase] = useState<'password' | 'fallback'>('password');
  const [remoteUsername, setRemoteUsername] = useState('');

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
      if (err instanceof DifferentPasswordError) {
        setPassword('');
        setRemoteUsername(err.remoteUsername);
        setPhase('fallback');
        return;
      }
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (remoteName: string, remotePassword: string) => {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      await loginToRemote(origin, remoteName, remotePassword);
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

  /**
   * Keep the keyboard on this surface across a submit.
   *
   * The field and both buttons go inert while a request runs, and a disabled
   * element cannot hold focus, so whichever of them the user was on hands
   * focus to `<body>`. An Escape pressed there never passes through this
   * surface at all, and in the Connections row it reaches the settings
   * modal's own document listener and closes the modal around a running
   * reconnect, with the answer arriving nowhere. The surface takes focus for
   * the duration instead, and hands it back to the field afterwards so a
   * refused password can simply be retyped.
   */
  useEffect(() => {
    if (loading) {
      surfaceRef.current?.focus();
      return;
    }
    if (surfaceRef.current && document.activeElement === surfaceRef.current) {
      fieldRef.current?.focus();
    }
  }, [loading]);

  // Escape belongs to this surface in every state, submitting included: the
  // event is stopped first and judged after, so nothing above can act on it.
  // While a submit is in flight it is swallowed rather than acted on, the
  // same as Cancel.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (loading) return;
    handleCancel();
  };

  const cancelButton = (
    <button
      type="button"
      onClick={handleCancel}
      disabled={loading}
      className="px-2 py-1.5 text-xs text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
    >
      {t('common:actions.cancel')}
    </button>
  );

  return (
    <div
      ref={surfaceRef}
      tabIndex={-1}
      className={`space-y-2.5 outline-none ${className}`}
      onKeyDown={handleKeyDown}
    >
      {phase === 'password' ? (
        <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-2.5">
          <input type="text" autoComplete="username" value={username} readOnly tabIndex={-1} className="sr-only" />
          {/* One block, capped at a password's reading width: the label, the
              field and the error under it keep the same edges in a narrow chip
              panel and in the width of a settings row. */}
          <div className="max-w-sm">
            <label htmlFor={fieldId} className="block text-xs text-txt-tertiary mb-1">
              {t('federation:connections.row.homePasswordLabel')}
            </label>
            <input
              id={fieldId}
              ref={fieldRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-standard w-full"
              disabled={loading}
              autoFocus
              autoComplete="current-password"
            />
            {error && (
              <p role="alert" className="mt-1.5 px-2 py-1.5 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs break-words">
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
            {cancelButton}
          </div>
        </form>
      ) : (
        <>
          <FallbackForm
            remoteUsername={remoteUsername}
            isLoading={loading}
            onLogin={(remoteName, remotePassword) => { void handleLogin(remoteName, remotePassword); }}
            secondaryAction={cancelButton}
            usernameLocked
          />
          {/* Two fields answer for this one, so it sits under the pair rather
              than under either of them, as the dialogs that share this form
              place it. */}
          {error && (
            <p role="alert" className="px-2 py-1.5 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs break-words">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
