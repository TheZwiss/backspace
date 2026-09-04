import { useState, useEffect, useCallback } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useFormatters, type Formatters } from '../../../i18n/formatters';
import { describeError } from '../../../i18n/errors';
import { api } from '../../../api/client';
import { useUIStore } from '../../../stores/uiStore';
import type { InstanceUpdateStatus } from '@backspace/shared';

/**
 * Formats an ISO date for the release line. Falls back to the raw string rather
 * than rendering "Invalid Date" if a release ever carries something unexpected.
 */
function formatReleaseDate(iso: string, f: Formatters): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return f.formatLongDate(date.getTime());
}

/** A copyable command block. */
function CommandBlock({ command }: { command: string }) {
  const { t } = useTranslation(['admin', 'common']);
  const addToast = useUIStore((s) => s.addToast);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused. The command is selectable either way,
      // so say so rather than failing silently.
      addToast(t('admin:updates.copyFailed'), 'warning', 4000);
    }
  };

  return (
    <div className="flex items-stretch gap-2">
      <code className="flex-1 min-w-0 rounded-lg bg-surface-input px-3 py-2 font-mono text-xs text-txt-primary overflow-x-auto whitespace-pre select-all">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 px-3 py-2 text-xs font-medium rounded-lg text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] transition-colors"
      >
        {copied ? t('common:actions.copied') : t('common:actions.copy')}
      </button>
    </div>
  );
}

/**
 * Instance version and update guidance for operators.
 *
 * There is deliberately no button that performs the update. Applying a
 * container update from inside the container requires mounting the Docker
 * socket, which grants the container root on the host. Backspace parses
 * uploaded media, scrapes URLs for embeds, and accepts federation payloads from
 * remote instances, so any remote-code-execution bug in it would become host
 * root the moment that socket exists. This panel hands over an exact command
 * instead, and ./update.sh is where the work went: it snapshots the database
 * first, verifies the running version actually changed, and rolls back if it
 * did not.
 */
export function UpdatesPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const f = useFormatters();
  const [status, setStatus] = useState<InstanceUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showManual, setShowManual] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setChecking(true);
    setLoadError('');
    try {
      setStatus(await api.admin.updateStatus(refresh));
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }, []);

  // The lookup happens here, when an admin opens the panel, and nowhere else.
  // There is no background poller on the server, so an instance whose admin
  // never opens this never contacts github.com at all.
  useEffect(() => { void load(false); }, [load]);

  if (loading) return <div className="text-sm text-txt-tertiary">{t('admin:updates.loading')}</div>;

  if (loadError || status === null) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-txt-primary">{t('admin:updates.title')}</h2>
        <div className="rounded-lg bg-accent-rose/10 border border-accent-rose/20 p-3.5 text-sm text-txt-secondary">
          {loadError || t('admin:updates.loadFailed')}
        </div>
        <button
          type="button"
          onClick={() => void load(false)}
          className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors"
        >
          {t('common:actions.tryAgain')}
        </button>
      </div>
    );
  }

  const updateAvailable = status.state === 'update-available' && status.latest !== null;

  const channelLabel = (channel: InstanceUpdateStatus['channel']): string => {
    switch (channel) {
      case 'prebuilt': return t('admin:updates.running.channel.prebuilt');
      case 'source': return t('admin:updates.running.channel.source');
      case 'unknown': return t('admin:updates.running.channel.unknown');
    }
  };

  const lastCheckedLine = (): string => {
    if (!status.checkEnabled) return t('admin:updates.noLookups');
    if (status.checkedAt === null) return '';
    return t('admin:updates.lastChecked', { when: f.formatRelativeTime(status.checkedAt) });
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary">{t('admin:updates.title')}</h2>
        <div className="text-xs text-txt-tertiary mt-1">
          {t('admin:updates.description')}
        </div>
      </div>

      {/* What is running now */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('admin:updates.running.label')}
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="text-sm text-txt-primary font-medium">
            {t('common:appName')} {status.current.version}
          </div>
          <div className="text-xs text-txt-tertiary mt-0.5">
            {status.current.commit ? t('admin:updates.running.commit', { commit: status.current.commit }) : ''}
            {channelLabel(status.channel)}
          </div>
        </div>
      </div>

      {/* What to do about it */}
      {updateAvailable && status.latest !== null ? (
        <div>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            {t('admin:updates.available.label')}
          </div>
          <div className="rounded-lg bg-accent-primary/[0.06] border border-accent-primary/25 p-3.5 space-y-3">
            <div>
              <div className="text-sm text-txt-primary font-medium">
                {t('admin:updates.available.version', { version: status.latest.version })}
              </div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                {status.latest.publishedAt && t('admin:updates.available.released', { date: formatReleaseDate(status.latest.publishedAt, f) })}
                <a
                  href={status.latest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-primary hover:underline"
                >
                  {t('admin:updates.available.releaseNotes')}
                </a>
              </div>
            </div>

            <div>
              <div className="text-xs text-txt-secondary mb-1.5">{t('admin:updates.available.fromInstallDir')}</div>
              <CommandBlock command="./update.sh" />
              <p className="text-xs text-txt-tertiary mt-2 leading-relaxed">
                {t('admin:updates.available.scriptDescription')}
              </p>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowManual((v) => !v)}
                aria-expanded={showManual}
                className="flex items-center gap-1 -ml-1 px-1 py-0.5 rounded text-xs text-txt-secondary hover:text-txt-primary transition-colors"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${showManual ? 'rotate-90' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
                {t('admin:updates.available.noScript')}
              </button>
              {showManual && (
                <div className="mt-2 space-y-2.5">
                  <p className="text-xs text-txt-tertiary leading-relaxed">
                    <Trans
                      t={t}
                      i18nKey="admin:updates.available.manualIntro"
                      components={{ code: <code className="font-mono" /> }}
                    />
                  </p>
                  {status.channel !== 'source' && (
                    <div>
                      <div className="text-xs text-txt-secondary mb-1.5">{t('admin:updates.available.prebuiltInstall')}</div>
                      {/* One command per line rather than chained with &&, so
                          the block fits the panel without scrolling sideways. */}
                      <CommandBlock command={'git pull\ndocker compose pull backspace\ndocker compose up -d backspace'} />
                    </div>
                  )}
                  {status.channel !== 'prebuilt' && (
                    <div>
                      <div className="text-xs text-txt-secondary mb-1.5">{t('admin:updates.available.sourceInstall')}</div>
                      <CommandBlock command={'git pull\ndocker compose up -d --build backspace'} />
                    </div>
                  )}
                  <p className="text-xs text-txt-tertiary leading-relaxed">
                    <Trans
                      t={t}
                      i18nKey="admin:updates.available.manualWarning"
                      components={{ code: <code className="font-mono" /> }}
                    />
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          {status.state === 'up-to-date' && (
            <div className="text-sm text-accent-mint">{t('admin:updates.upToDate')}</div>
          )}
          {status.state === 'unknown' && status.reason === 'disabled' && (
            <>
              <div className="text-sm text-txt-primary">{t('admin:updates.disabled.title')}</div>
              <div className="text-xs text-txt-tertiary mt-0.5 leading-relaxed">
                <Trans
                  t={t}
                  i18nKey="admin:updates.disabled.description"
                  components={{ code: <code className="font-mono" /> }}
                />
              </div>
            </>
          )}
          {status.state === 'unknown' && status.reason === 'rate-limited' && (
            <>
              <div className="text-sm text-txt-primary">{t('admin:updates.rateLimited.title')}</div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                {t('admin:updates.rateLimited.description')}
              </div>
            </>
          )}
          {status.state === 'unknown' && status.reason !== 'disabled' && status.reason !== 'rate-limited' && (
            <>
              <div className="text-sm text-txt-primary">{t('admin:updates.unreachable.title')}</div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                {t('admin:updates.unreachable.description')}
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-txt-tertiary">
          {lastCheckedLine()}
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={checking || !status.checkEnabled}
          className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors disabled:opacity-50"
        >
          {checking ? t('admin:updates.checking') : t('admin:updates.checkAgain')}
        </button>
      </div>
    </div>
  );
}
