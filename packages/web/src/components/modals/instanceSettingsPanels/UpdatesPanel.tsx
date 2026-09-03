import { useState, useEffect, useCallback } from 'react';
import { api } from '../../../api/client';
import { useUIStore } from '../../../stores/uiStore';
import type { InstanceUpdateStatus } from '@backspace/shared';
import { Trans } from 'react-i18next';
import i18n, { translate } from '../../../i18n';

/**
 * Formats an ISO date for the release line. Falls back to the raw string rather
 * than rendering "Invalid Date" if a release ever carries something unexpected.
 */
function formatReleaseDate(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(i18n.resolvedLanguage ?? i18n.language, {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function formatCheckedAt(checkedAt: number | null): string {
  if (checkedAt === null) return '';
  const seconds = Math.max(0, Math.round((Date.now() - checkedAt) / 1000));
  const formatter = new Intl.RelativeTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
    numeric: 'auto',
  });
  const relative = seconds < 60
    ? formatter.format(0, 'second')
    : seconds < 3600
      ? formatter.format(-Math.round(seconds / 60), 'minute')
      : formatter.format(-Math.round(seconds / 3600), 'hour');
  return translate('runtime.expressions.UpdatesPanel.lastChecked', { relative });
}

function channelLabel(channel: InstanceUpdateStatus['channel']): string {
  return translate(`runtime.expressions.UpdatesPanel.channel.${channel}`);
}

/** A copyable command block. */
function CommandBlock({ command }: { command: string }) {
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
      addToast(translate('runtime.expressions.UpdatesPanel.copyFailed'), 'warning', 4000);
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
        {copied
          ? translate('runtime.expressions.UpdatesPanel.copied')
          : translate('runtime.expressions.UpdatesPanel.copy')}
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
      setLoadError(err instanceof Error
        ? err.message
        : translate('runtime.expressions.UpdatesPanel.loadFailed'));
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }, []);

  // The lookup happens here, when an admin opens the panel, and nowhere else.
  // There is no background poller on the server, so an instance whose admin
  // never opens this never contacts github.com at all.
  useEffect(() => { void load(false); }, [load]);

  if (loading) {
    return <div className="text-sm text-txt-tertiary"><Trans i18nKey="ui.UpdatesPanel.loading">Loading update status...</Trans></div>;
  }

  if (loadError || status === null) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-txt-primary"><Trans i18nKey="ui.UpdatesPanel.updates">Updates</Trans></h2>
        <div className="rounded-lg bg-accent-rose/10 border border-accent-rose/20 p-3.5 text-sm text-txt-secondary">
          {loadError || translate('runtime.expressions.UpdatesPanel.loadFailedWithPeriod')}
        </div>
        <button
          type="button"
          onClick={() => void load(false)}
          className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors"
        >
          <Trans i18nKey="ui.UpdatesPanel.tryAgain">Try again</Trans>
        </button>
      </div>
    );
  }

  const updateAvailable = status.state === 'update-available' && status.latest !== null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary"><Trans i18nKey="ui.UpdatesPanel.updates">Updates</Trans></h2>
        <div className="text-xs text-txt-tertiary mt-1">
          <Trans i18nKey="ui.UpdatesPanel.description">What this instance is running, and how to move it forward.</Trans>
        </div>
      </div>

      {/* What is running now */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          <Trans i18nKey="ui.UpdatesPanel.running">Running</Trans>
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
          <div className="text-sm text-txt-primary font-medium">
            {translate('runtime.expressions.UpdatesPanel.currentVersion', {
              version: status.current.version,
            })}
          </div>
          <div className="text-xs text-txt-tertiary mt-0.5">
            {status.current.commit
              ? translate('runtime.expressions.UpdatesPanel.commit', { commit: status.current.commit })
              : ''}
            {channelLabel(status.channel)}
          </div>
        </div>
      </div>

      {/* What to do about it */}
      {updateAvailable && status.latest !== null ? (
        <div>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            <Trans i18nKey="ui.UpdatesPanel.available">Available</Trans>
          </div>
          <div className="rounded-lg bg-accent-primary/[0.06] border border-accent-primary/25 p-3.5 space-y-3">
            <div>
              <div className="text-sm text-txt-primary font-medium">
                {translate('runtime.expressions.UpdatesPanel.versionAvailable', {
                  version: status.latest.version,
                })}
              </div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                {status.latest.publishedAt && translate('runtime.expressions.UpdatesPanel.released', {
                  date: formatReleaseDate(status.latest.publishedAt),
                })}
                <a
                  href={status.latest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-primary hover:underline"
                >
                  <Trans i18nKey="ui.UpdatesPanel.releaseNotes">Release notes</Trans>
                </a>
              </div>
            </div>

            <div>
              <div className="text-xs text-txt-secondary mb-1.5"><Trans i18nKey="ui.UpdatesPanel.fromInstallDirectory">From your install directory:</Trans></div>
              <CommandBlock command="./update.sh" />
              <p className="text-xs text-txt-tertiary mt-2 leading-relaxed">
                <Trans i18nKey="ui.UpdatesPanel.updateScriptDescription">
                  Takes a database snapshot, fetches the new image, and restarts only
                  the Backspace container. If the new version does not come up healthy,
                  or comes up still running the old code, it puts back the version you
                  are on now.
                </Trans>
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
                <Trans i18nKey="ui.UpdatesPanel.noUpdateScript">I do not have update.sh</Trans>
              </button>
              {showManual && (
                <div className="mt-2 space-y-2.5">
                  <p className="text-xs text-txt-tertiary leading-relaxed">
                    <Trans
                      i18nKey="ui.UpdatesPanel.manualScriptDescription"
                      components={{
                        gitPull: <code className="font-mono" />,
                        backup: <code className="font-mono" />,
                      }}
                    />
                  </p>
                  {status.channel !== 'source' && (
                    <div>
                      <div className="text-xs text-txt-secondary mb-1.5"><Trans i18nKey="ui.UpdatesPanel.prebuiltInstall">Prebuilt-image install:</Trans></div>
                      {/* One command per line rather than chained with &&, so
                          the block fits the panel without scrolling sideways. */}
                      <CommandBlock command={'git pull\ndocker compose pull backspace\ndocker compose up -d backspace'} />
                    </div>
                  )}
                  {status.channel !== 'prebuilt' && (
                    <div>
                      <div className="text-xs text-txt-secondary mb-1.5"><Trans i18nKey="ui.UpdatesPanel.sourceInstall">From-source install:</Trans></div>
                      <CommandBlock command={'git pull\ndocker compose up -d --build backspace'} />
                    </div>
                  )}
                  <p className="text-xs text-txt-tertiary leading-relaxed">
                    <Trans
                      i18nKey="ui.UpdatesPanel.composeWarning"
                      components={{
                        service: <code className="font-mono" />,
                        flag: <code className="font-mono" />,
                      }}
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
            <div className="text-sm text-accent-mint"><Trans i18nKey="ui.UpdatesPanel.latestRelease">You are on the latest release.</Trans></div>
          )}
          {status.state === 'unknown' && status.reason === 'disabled' && (
            <>
              <div className="text-sm text-txt-primary"><Trans i18nKey="ui.UpdatesPanel.checksDisabled">Update checks are turned off</Trans></div>
              <div className="text-xs text-txt-tertiary mt-0.5 leading-relaxed">
                <Trans
                  i18nKey="ui.UpdatesPanel.checksDisabledDescription"
                  components={{
                    setting: <code className="font-mono" />,
                    env: <code className="font-mono" />,
                  }}
                />
              </div>
            </>
          )}
          {status.state === 'unknown' && status.reason === 'rate-limited' && (
            <>
              <div className="text-sm text-txt-primary"><Trans i18nKey="ui.UpdatesPanel.rateLimited">GitHub rate-limited the lookup</Trans></div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                <Trans i18nKey="ui.UpdatesPanel.rateLimitedDescription">This says nothing about whether an update exists. Try again later.</Trans>
              </div>
            </>
          )}
          {status.state === 'unknown' && status.reason !== 'disabled' && status.reason !== 'rate-limited' && (
            <>
              <div className="text-sm text-txt-primary"><Trans i18nKey="ui.UpdatesPanel.checkFailed">Could not check for updates</Trans></div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                <Trans i18nKey="ui.UpdatesPanel.checkFailedDescription">
                  GitHub could not be reached, so this says nothing about whether an
                  update exists. Your instance is unaffected.
                </Trans>
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-txt-tertiary">
          {status.checkEnabled
            ? formatCheckedAt(status.checkedAt)
            : translate('runtime.expressions.UpdatesPanel.noLookups')}
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={checking || !status.checkEnabled}
          className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors disabled:opacity-50"
        >
          {checking
            ? translate('runtime.expressions.UpdatesPanel.checking')
            : translate('runtime.expressions.UpdatesPanel.checkAgain')}
        </button>
      </div>
    </div>
  );
}
