import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { DirectoryEntry } from '@backspace/shared';
import { Modal } from '../ui/Modal';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { useUIStore } from '../../stores/uiStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { useDirectoryStore, type ConnectAndJoinResult } from '../../stores/directoryStore';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { describeError } from '../../i18n/errors';
import { isDirectoryEntry } from '../../utils/directory';
import { REQUEST_MESSAGE_MAX_LENGTH } from '../chat/SpaceCard';
import {
  RemotePasswordStep,
  RemoteInstanceLine,
  type RemoteInstanceInfo,
  type RemotePasswordPhase,
} from './RemotePasswordStep';

/**
 * What the dialog knows about the entry's instance. `probing` is the moment
 * between opening and the probe's answer; `ready` carries what the step
 * shows, and `connected` says the session already has this origin, so the
 * password step is skipped and the join runs against it directly.
 */
type ProbeState =
  | { status: 'probing' }
  | { status: 'ready'; instance: RemoteInstanceInfo; connected: boolean }
  | { status: 'failed'; message: string };

function safeHost(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

function canonicalOrigin(value: string): string | null {
  try { return new URL(value).origin; } catch { return null; }
}

/**
 * The stale-card case: the user connected this origin through the
 * Connections settings while the card was on screen. `connectToInstance`
 * short-circuits such an origin, and the probe would refuse it, so the
 * dialog goes straight to the join.
 */
function hasSessionOn(origin: string): boolean {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return false;
  return useInstanceStore.getState().instances.some(
    (i) => canonicalOrigin(i.origin) === canonical && (i.status === 'connected' || i.status === 'connecting'),
  );
}

function initialProbeState(entry: DirectoryEntry): ProbeState {
  if (!hasSessionOn(entry.origin)) return { status: 'probing' };
  return {
    status: 'ready',
    connected: true,
    instance: {
      name: entry.instanceName,
      origin: entry.origin,
      federatedRegistrationOpen: entry.federatedRegistrationOpen,
    },
  };
}

const textButtonClass = 'text-sm text-txt-tertiary hover:text-txt-secondary transition-colors';

function ConnectAndJoinDialog({ entry }: { entry: DirectoryEntry }) {
  const { t } = useTranslation(['spaces', 'federation', 'common']);
  const closeModal = useUIStore((s) => s.closeModal);
  const addToast = useUIStore((s) => s.addToast);
  const probeInstance = useInstanceStore((s) => s.probeInstance);
  const connectAndJoin = useDirectoryStore((s) => s.connectAndJoin);
  const loginAndJoin = useDirectoryStore((s) => s.loginAndJoin);
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const [probe, setProbe] = useState<ProbeState>(() => initialProbeState(entry));
  const [phase, setPhase] = useState<RemotePasswordPhase>('password');
  const [remoteUsername, setRemoteUsername] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const host = safeHost(entry.origin);
  const home = user?.homeInstance || window.location.host;
  const isRequest = entry.visibility === 'request';
  const skipsPassword = probe.status === 'ready' && probe.connected;

  const handleResult = (result: ConnectAndJoinResult) => {
    if (result.kind === 'joined') {
      closeModal();
      setCurrentSpace(result.spaceId);
      navigate(`/channels/${result.spaceId}`);
    } else if (result.kind === 'requested') {
      closeModal();
      addToast(t('spaces:explore.connect.requested', { name: entry.name }), 'success', 3000);
    } else {
      setPhase('fallback');
      setRemoteUsername(result.remoteUsername);
    }
  };

  const run = async (action: () => Promise<ConnectAndJoinResult>) => {
    setError('');
    setIsLoading(true);
    try {
      handleResult(await action());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const requestMessage = isRequest ? message.trim() || undefined : undefined;
  const handleConnect = (password: string) => run(() => connectAndJoin(entry, password, requestMessage));
  const handleLogin = (username: string, remotePassword: string) =>
    run(() => loginAndJoin(entry, username, remotePassword, requestMessage));
  // The session already has the origin: `connectToInstance` short-circuits
  // there, so the password it is handed is never read.
  const handleJoinConnected = () => run(() => connectAndJoin(entry, '', requestMessage));

  // The probe: it performs the self and duplicate checks and answers whether
  // the instance takes new accounts. A dialog closed before the answer
  // arrives ignores it.
  useEffect(() => {
    if (probe.status !== 'probing') return undefined;
    let cancelled = false;
    probeInstance(host)
      .then((info) => {
        if (cancelled) return;
        setProbe({
          status: 'ready',
          connected: false,
          instance: { name: info.name, origin: info.origin, federatedRegistrationOpen: info.federatedRegistrationOpen },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProbe({ status: 'failed', message: describeError(err) });
      });
    return () => { cancelled = true; };
  }, [probe.status, host, probeInstance]);

  // The stale-card case for a public space: the session already has the
  // origin, so there is nothing to ask and the join runs on open. The dialog
  // is mounted once per open, so this is a mount effect by design.
  const joinsOnOpen = skipsPassword && !isRequest;
  useEffect(() => {
    if (joinsOnOpen) void handleJoinConnected();
  }, []);

  const messageField = isRequest ? (
    <textarea
      value={message}
      onChange={(e) => setMessage(e.target.value.slice(0, REQUEST_MESSAGE_MAX_LENGTH))}
      placeholder={t('spaces:explore.requestMessagePlaceholder')}
      rows={2}
      disabled={isLoading}
      className="input-standard w-full resize-none"
    />
  ) : undefined;

  return (
    <Modal
      isOpen
      onClose={closeModal}
      title={t('spaces:explore.connect.title', { name: entry.name })}
      mobileStyle="sheet"
    >
      {probe.status === 'probing' && (
        <div role="status" className="py-8 flex flex-col items-center gap-3 text-txt-tertiary">
          <LoadingSpinner size={28} className="text-accent-primary" />
          <span className="text-sm">{t('spaces:explore.connect.probing', { host })}</span>
        </div>
      )}

      {probe.status === 'failed' && (
        <div className="space-y-4">
          <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
            {probe.message}
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={closeModal} className={textButtonClass}>
              {t('common:actions.close')}
            </button>
          </div>
        </div>
      )}

      {probe.status === 'ready' && (
        <div className="space-y-4">
          {!skipsPassword && phase === 'password' && (
            <p className="text-sm text-txt-secondary">
              <Trans
                t={t}
                i18nKey="spaces:explore.connect.intro"
                values={{ host, home }}
                components={{
                  host: <span className="text-txt-primary font-medium" />,
                  home: <span className="text-txt-primary font-medium" />,
                }}
              />
            </p>
          )}

          {skipsPassword ? (
            <div className="space-y-3">
              <RemoteInstanceLine instance={probe.instance} status="connected" />
              {isRequest ? (
                <form
                  onSubmit={(e) => { e.preventDefault(); void handleJoinConnected(); }}
                  className="space-y-2"
                >
                  {messageField}
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
                  >
                    {isLoading ? t('spaces:explore.sendingRequest') : t('spaces:explore.sendRequest')}
                  </button>
                </form>
              ) : !error && (
                <div role="status" className="py-2 flex items-center gap-3 text-txt-tertiary">
                  <LoadingSpinner size={20} className="text-accent-primary" />
                  <span className="text-sm">{t('spaces:explore.connect.connecting')}</span>
                </div>
              )}
              {error && (
                <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">
                  {error}
                </div>
              )}
            </div>
          ) : (
            <RemotePasswordStep
              phase={phase}
              instance={probe.instance}
              homeUsername={user?.username || ''}
              remoteUsername={remoteUsername}
              isLoading={isLoading}
              error={error}
              onConnect={handleConnect}
              onLogin={handleLogin}
              extraFields={messageField}
              connectLabel={isRequest ? t('spaces:explore.outer.connectAndRequest') : t('spaces:explore.outer.connectAndJoin')}
              connectingLabel={t('spaces:explore.connect.connecting')}
            />
          )}

          <div className="flex justify-end gap-4">
            {phase === 'fallback' && (
              <button
                type="button"
                onClick={() => { setPhase('password'); setError(''); }}
                disabled={isLoading}
                className={textButtonClass}
              >
                {t('common:actions.back')}
              </button>
            )}
            <button type="button" onClick={closeModal} disabled={isLoading} className={textButtonClass}>
              {t('common:actions.cancel')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * The modal an Outer Space card opens: it establishes a session on the
 * entry's origin with the home password, then joins the space or sends the
 * join request. Rendered unconditionally by AppLayout like every modal; it
 * gates itself on `activeModal` and narrows its entry from `modalData`,
 * rendering nothing when that is not a directory entry.
 */
export function ConnectAndJoinModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  if (activeModal !== 'connectAndJoin') return null;
  const entry = modalData.entry;
  if (!isDirectoryEntry(entry)) return null;
  // Keyed per entry so a fresh open always starts from the probe.
  return <ConnectAndJoinDialog key={`${entry.origin}\n${entry.id}`} entry={entry} />;
}
