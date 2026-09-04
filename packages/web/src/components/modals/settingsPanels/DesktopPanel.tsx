import { useState, useEffect } from 'react';
import { Toggle } from '../../ui/Toggle';
import { useUpdateStore } from '../../../stores/updateStore';
import { Trans } from 'react-i18next';
import { translate } from '../../../i18n';

function AutoLaunchSettings() {
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [startMinimized, setStartMinimized] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.backspace?.getAutoLaunchSettings().then((settings) => {
      setOpenAtLogin(settings.openAtLogin);
      setStartMinimized(settings.startMinimized);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleOpenAtLoginChange = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.backspace!.setAutoLaunchSettings({ openAtLogin: enabled });
      setOpenAtLogin(result.openAtLogin);
      setStartMinimized(result.startMinimized);
    } catch (err) {
      console.error('[autoLaunch] setAutoLaunchSettings(openAtLogin) failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleStartMinimizedChange = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.backspace!.setAutoLaunchSettings({ startMinimized: enabled });
      setOpenAtLogin(result.openAtLogin);
      setStartMinimized(result.startMinimized);
    } catch (err) {
      console.error('[autoLaunch] setAutoLaunchSettings(startMinimized) failed:', err);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;

  return (
    <>
      <div className="flex items-center justify-between py-1">
        <div className="flex-1 mr-4">
          <div className="text-sm text-txt-primary"><Trans i18nKey="ui.DesktopPanel.startAtBoot">Start at boot</Trans></div>
          <div className="text-xs text-txt-tertiary mt-0.5">
            <Trans i18nKey="ui.DesktopPanel.automaticallyLaunchBackspaceWhenYouLogIn">Automatically launch Backspace when you log in</Trans>
          </div>
        </div>
        <Toggle enabled={openAtLogin} onChange={handleOpenAtLoginChange} disabled={busy} />
      </div>
      <div className="flex items-center justify-between py-1">
        <div className="flex-1 mr-4">
          <div className={`text-sm ${openAtLogin ? 'text-txt-primary' : 'text-txt-tertiary'}`}><Trans i18nKey="ui.DesktopPanel.startMinimized">Start minimized</Trans></div>
          <div className="text-xs text-txt-tertiary mt-0.5">
            <Trans i18nKey="ui.DesktopPanel.startHiddenInTheSystemTrayInsteadOf">Start hidden in the system tray instead of showing the window</Trans>
          </div>
        </div>
        <Toggle enabled={startMinimized} onChange={handleStartMinimizedChange} disabled={busy || !openAtLogin} />
      </div>
    </>
  );
}

/**
 * Formats a byte-per-second rate for the download line. Deliberately coarse:
 * this is reassurance that something is happening, not a benchmark.
 */
function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '';
  const mb = bytesPerSecond / 1_048_576;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

/**
 * Desktop version and update state.
 *
 * This panel deliberately ignores whether the user dismissed the update. It is
 * the place a dismissed update stays reachable, which is the thing that makes
 * "Later" safe to offer in the toast at all.
 *
 * Every state here comes from a real updater event. The previous version faked
 * a "Checking..." state with a five second timer and a comment claiming
 * electron-updater has no no-update callback. It emits `update-not-available`
 * and `download-progress`; both are now wired.
 */
function UpdateSettings() {
  const initialize = useUpdateStore((s) => s.initialize);
  const snapshot = useUpdateStore((s) => s.snapshot);
  const currentVersion = useUpdateStore((s) => s.currentVersion);
  const checkNow = useUpdateStore((s) => s.checkNow);
  const install = useUpdateStore((s) => s.install);
  const openDownloadPage = useUpdateStore((s) => s.openDownloadPage);

  useEffect(() => initialize(), [initialize]);

  const status = snapshot?.status ?? { phase: 'idle' as const };
  const capability = snapshot?.capability ?? 'auto';
  const busy = status.phase === 'checking' || status.phase === 'downloading';

  let detail: string;
  let tone = 'text-txt-tertiary';
  let action: { label: string; onClick: () => void } | null = null;

  switch (status.phase) {
    case 'checking':
      detail = translate('runtime.expressions.DesktopPanel.checkingForUpdates');
      break;
    case 'downloading':
      detail = translate('runtime.expressions.DesktopPanel.downloading', {
        version: status.version,
        percent: status.percent,
      });
      if (status.bytesPerSecond > 0) {
        detail += translate('runtime.expressions.DesktopPanel.atRate', {
          rate: formatRate(status.bytesPerSecond),
        });
      }
      break;
    case 'up-to-date':
      detail = translate('runtime.expressions.DesktopPanel.latestVersion');
      tone = 'text-accent-mint';
      break;
    case 'available':
      detail = translate('runtime.expressions.DesktopPanel.versionAvailable', { version: status.version });
      action = { label: translate('runtime.expressions.DesktopPanel.download'), onClick: openDownloadPage };
      break;
    case 'ready':
      if (capability === 'auto') {
        detail = translate('runtime.expressions.DesktopPanel.versionReady', { version: status.version });
        action = { label: translate('runtime.expressions.DesktopPanel.restart'), onClick: install };
      } else {
        detail = translate('runtime.expressions.DesktopPanel.versionAvailable', { version: status.version });
        action = { label: translate('runtime.expressions.DesktopPanel.download'), onClick: openDownloadPage };
      }
      break;
    case 'failed':
      if (status.version) {
        detail = translate('runtime.expressions.DesktopPanel.versionInstallFailed', { version: status.version });
        tone = 'text-accent-rose';
        action = { label: translate('runtime.expressions.DesktopPanel.download'), onClick: openDownloadPage };
      } else {
        detail = translate('runtime.expressions.DesktopPanel.lastCheckFailed');
        tone = 'text-accent-rose';
      }
      break;
    default:
      detail = translate('ui.DesktopPanel.checkForNewVersionsOfTheDesktopApp');
  }

  if (capability === 'external') {
    detail = translate('ui.DesktopPanel.updatesInstalledThroughFlatpak');
    tone = 'text-txt-tertiary';
    action = null;
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between py-1">
        <div className="flex-1 mr-4 min-w-0">
          <div className="text-sm text-txt-primary">
            {currentVersion
              ? translate('runtime.expressions.DesktopPanel.version', { version: currentVersion })
              : translate('runtime.expressions.DesktopPanel.backspaceDesktop')}
          </div>
          <div className={`text-xs mt-0.5 ${tone}`}>{detail}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {action && (
            <button
              onClick={action.onClick}
              className="px-3 py-1.5 text-sm font-medium text-white bg-accent-primary hover:bg-accent-primary/80 rounded-lg transition-colors"
            >
              {action.label}
            </button>
          )}
          {capability !== 'external' && (
            <button
              onClick={checkNow}
              disabled={busy}
              className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors disabled:opacity-50"
            >
              {status.phase === 'checking'
                ? translate('runtime.expressions.DesktopPanel.checking')
                : translate('runtime.expressions.DesktopPanel.checkForUpdates')}
            </button>
          )}
        </div>
      </div>

      {status.phase === 'downloading' && (
        <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden" role="progressbar" aria-valuenow={status.percent} aria-valuemin={0} aria-valuemax={100}>
          <div
            className="h-full bg-accent-primary transition-[width] duration-300"
            style={{ width: `${status.percent}%` }}
          />
        </div>
      )}

      {capability === 'manual' && (
        <p className="text-xs text-txt-tertiary leading-relaxed">
          <Trans i18nKey="ui.DesktopPanel.manualUpdateDescription">
            This build cannot install updates itself, so new versions are downloaded
            from GitHub and replace the app by hand. See the release notes for the
            steps on your platform.
          </Trans>
        </p>
      )}
      {capability === 'external' && (
        <p className="text-xs text-txt-tertiary leading-relaxed">
          <Trans i18nKey="ui.DesktopPanel.flatpakUpdateDescription">
            Flatpak applies updates atomically outside the app. Use your software
            manager or the <code>flatpak update</code> command to update Backspace.
          </Trans>
        </p>
      )}
    </div>
  );
}

export function DesktopPanel() {
  const initialize = useUpdateStore((s) => s.initialize);
  const [sandboxed, setSandboxed] = useState<boolean | null>(null);

  useEffect(() => initialize(), [initialize]);
  useEffect(() => {
    const probe = window.backspace?.isSandboxed;
    if (!probe) {
      // Older desktop builds predate sandbox support and are ordinary native
      // packages, so preserving the existing controls is the compatible path.
      setSandboxed(false);
      return;
    }
    probe().then(setSandboxed).catch(() => setSandboxed(false));
  }, []);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6"><Trans i18nKey="ui.DesktopPanel.desktop">Desktop</Trans></h2>

      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-3">
        {sandboxed === false && <AutoLaunchSettings />}
        <UpdateSettings />

        <div className="border-t border-white/[0.04]" />

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-txt-primary font-medium">{window.location.origin}</div>
            <div className="text-xs text-txt-tertiary mt-0.5"><Trans i18nKey="ui.DesktopPanel.currentlyConnectedInstance">Currently connected instance</Trans></div>
          </div>
          <button
            onClick={() => window.backspace?.clearInstanceUrl()}
            className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors"
          >
            <Trans i18nKey="ui.DesktopPanel.changeInstance">Change Instance</Trans>
          </button>
        </div>
      </div>
    </div>
  );
}
