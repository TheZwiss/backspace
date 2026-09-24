import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusDot } from '../ui/StatusDot';
import type { RemoteLoginReason } from '../../stores/instanceStore';

/**
 * The two phases of establishing a session on another instance:
 * `password` asks for the home password (the home instance verifies it and
 * mints the per-remote credential), `fallback` asks for the account's own
 * credentials on the remote when that instance refused the home-issued one.
 */
export type RemotePasswordPhase = 'password' | 'fallback';

/** What the step shows about the instance it connects to: the probe's answer, or a directory entry's own fields. */
export interface RemoteInstanceInfo {
  name: string;
  origin: string;
  federatedRegistrationOpen: boolean;
}

export interface RemotePasswordStepProps {
  phase: RemotePasswordPhase;
  instance: RemoteInstanceInfo;
  /**
   * The home account's username. It is rendered into a visually hidden
   * username field so password managers key the saved password on it.
   */
  homeUsername: string;
  /** The username the remote reported when it refused the home credential; prefills the fallback form. */
  remoteUsername: string;
  /** Why the fallback phase was entered; words its notice. Ignored in the password phase. */
  fallbackReason: RemoteLoginReason;
  isLoading: boolean;
  /** An already described error, rendered under the form; empty for none. */
  error: string;
  onConnect: (password: string) => void;
  onLogin: (username: string, remotePassword: string) => void;
  /** Rendered between the fields and the submit button, in both phases. */
  extraFields?: React.ReactNode;
  /** Submit labels for the password phase; the Connections panel's "Connect" wording by default. */
  connectLabel?: string;
  connectingLabel?: string;
}

export function safeHost(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

const submitBase =
  'px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50';
const submitClass = `w-full ${submitBase}`;

function PasswordForm({
  host,
  homeUsername,
  isLoading,
  onConnect,
  extraFields,
  connectLabel,
  connectingLabel,
}: {
  host: string;
  homeUsername: string;
  isLoading: boolean;
  onConnect: (password: string) => void;
  extraFields?: React.ReactNode;
  connectLabel: string;
  connectingLabel: string;
}) {
  const { t } = useTranslation(['federation']);
  const [password, setPassword] = useState('');
  const fieldId = useId();

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (password) onConnect(password); }}
      className="space-y-2"
    >
      <input type="text" autoComplete="username" value={homeUsername} readOnly tabIndex={-1} className="sr-only" />
      <div>
        <label htmlFor={fieldId} className="block text-xs text-txt-tertiary mb-1">
          {t('federation:connections.add.passwordLabel', { host })}
        </label>
        <input
          id={fieldId}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('federation:connections.add.passwordPlaceholder')}
          className="input-standard w-full"
          disabled={isLoading}
          autoFocus
          autoComplete="current-password"
        />
        <div className="text-xs text-txt-tertiary mt-1">
          {t('federation:connections.add.passwordHint', { host })}
        </div>
      </div>
      {extraFields}
      <button type="submit" disabled={isLoading || !password} className={submitClass}>
        {isLoading ? connectingLabel : connectLabel}
      </button>
    </form>
  );
}

/**
 * Why the user is being asked for an account's own credentials on another
 * instance, above every form that asks for them. It is the one place the
 * wording is chosen, so the five surfaces that offer that login cannot say
 * different things; `JoinPage` and `JoinSpace` lay out their own forms and
 * render this notice directly.
 *
 * Only `credential-refused` may say an account exists: the instance told us
 * so. `registration-closed` cannot know, so it states the closed gate and
 * offers the sign-in as a conditional.
 */
export function FallbackNotice({ reason, host, className = '' }: {
  reason: RemoteLoginReason;
  host: string;
  className?: string;
}) {
  const { t } = useTranslation(['federation']);
  return (
    <div className={`p-2 bg-accent-amber/10 border border-accent-amber/30 rounded text-xs text-accent-amber ${className}`}>
      {reason === 'credential-refused'
        ? t('federation:connections.add.fallbackNotice.credentialRefused', { host })
        : t('federation:connections.add.fallbackNotice.registrationClosed', { host })}
    </div>
  );
}

/**
 * The account's own credentials on the remote instance: the way in when
 * that instance refused the credential the home issued, or could not take a
 * new account and the issued credential signed nothing in. It carries its
 * own notice, because the form only makes sense with the reason above it.
 *
 * Three hosts render it: the Connections panel's add-instance flow, the
 * directory's connect-and-join dialog, and the reconnect surface
 * (`ReauthForm`). The last one passes a `secondaryAction`, which puts the
 * submit back to its own width and sets the action beside it; without one
 * the submit keeps the full-width shape the dialogs use.
 *
 * `usernameLocked` says whether the account is a choice. Adding a connection
 * it is: the user picks which account on that instance to link. Restoring
 * one it is not: the account is already in the registry entry, and a typed
 * change would re-bind the connection to a different identity without
 * asking, since `loginToRemote` replaces the instance and upserts the
 * registry entry by origin. The field stays in the DOM either way so the
 * password manager keys on it.
 */
export function FallbackForm({
  host,
  reason,
  remoteUsername,
  isLoading,
  onLogin,
  extraFields,
  secondaryAction,
  usernameLocked = false,
}: {
  host: string;
  reason: RemoteLoginReason;
  remoteUsername: string;
  isLoading: boolean;
  onLogin: (username: string, remotePassword: string) => void;
  extraFields?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  /** True where the account is the identity being restored rather than one being chosen. */
  usernameLocked?: boolean;
}) {
  const { t } = useTranslation(['federation', 'common']);
  const [username, setUsername] = useState(remoteUsername);
  const [remotePassword, setRemotePassword] = useState('');
  const usernameId = useId();
  const passwordId = useId();

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (username && remotePassword) onLogin(username, remotePassword); }}
      className="space-y-2"
    >
      <FallbackNotice reason={reason} host={host} />
      <div>
        <label htmlFor={usernameId} className="block text-xs text-txt-tertiary mb-1">{t('common:labels.username')}</label>
        <input
          id={usernameId}
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('federation:connections.add.usernamePlaceholder')}
          // Locked, it is a stated fact and not a blank: the sunken box, the
          // border and the shadow all come off, because only a colour change
          // still reads as an input the user is failing to type into. It
          // stays a real input so the password manager keys on it.
          className={usernameLocked
            ? 'w-full bg-transparent px-0 py-1 text-sm text-txt-secondary cursor-default outline-none'
            : 'input-standard w-full'}
          disabled={isLoading}
          readOnly={usernameLocked}
          autoComplete="username"
        />
      </div>
      <div>
        <label htmlFor={passwordId} className="block text-xs text-txt-tertiary mb-1">{t('federation:connections.add.remotePasswordLabel')}</label>
        <input
          id={passwordId}
          type="password"
          value={remotePassword}
          onChange={(e) => setRemotePassword(e.target.value)}
          placeholder={t('federation:connections.add.remotePasswordPlaceholder')}
          className="input-standard w-full"
          disabled={isLoading}
          autoFocus
          autoComplete="current-password"
        />
      </div>
      {extraFields}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={isLoading || !username || !remotePassword}
          className={secondaryAction ? submitBase : submitClass}
        >
          {isLoading ? t('federation:connections.add.loggingIn') : t('federation:connections.add.loginAndConnect')}
        </button>
        {secondaryAction}
      </div>
    </form>
  );
}

/** The instance line: its dot, name and origin. The step shows it while connecting; the connect-and-join modal also shows it once connected. */
export function RemoteInstanceLine({ instance, status }: { instance: RemoteInstanceInfo; status: 'connected' | 'connecting' }) {
  return (
    <div className="flex items-center gap-2">
      <StatusDot status={status} />
      <div className="min-w-0">
        <div className="text-sm text-txt-primary font-medium truncate">{instance.name}</div>
        <div className="text-xs text-txt-tertiary truncate">{instance.origin}</div>
      </div>
    </div>
  );
}

/**
 * The password step of connecting to another instance, shared by the
 * Connections panel's add flow and the directory's connect-and-join modal
 * so the two never drift: the instance line, the closed-registration banner,
 * and the form for the current phase. Each form owns its own fields and is
 * remounted when the phase changes, so a phase switch always starts clean;
 * the caller owns the phase, the loading flag and the error.
 */
export function RemotePasswordStep({
  phase,
  instance,
  homeUsername,
  remoteUsername,
  fallbackReason,
  isLoading,
  error,
  onConnect,
  onLogin,
  extraFields,
  connectLabel,
  connectingLabel,
}: RemotePasswordStepProps) {
  const { t } = useTranslation(['federation']);
  const host = safeHost(instance.origin);

  return (
    <div className="space-y-3">
      <RemoteInstanceLine instance={instance} status="connecting" />

      {phase === 'password' && !instance.federatedRegistrationOpen && (
        <div className="p-3 rounded-lg bg-accent-amber/10 border border-accent-amber/30 text-sm text-accent-amber">
          {t('federation:connections.add.registrationClosed')}
        </div>
      )}

      {phase === 'password' ? (
        <PasswordForm
          host={host}
          homeUsername={homeUsername}
          isLoading={isLoading}
          onConnect={onConnect}
          extraFields={extraFields}
          connectLabel={connectLabel ?? t('federation:connections.add.connect')}
          connectingLabel={connectingLabel ?? t('federation:connections.add.connecting')}
        />
      ) : (
        <FallbackForm
          host={host}
          reason={fallbackReason}
          remoteUsername={remoteUsername}
          isLoading={isLoading}
          onLogin={onLogin}
          extraFields={extraFields}
        />
      )}

      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">
          {error}
        </div>
      )}
    </div>
  );
}
