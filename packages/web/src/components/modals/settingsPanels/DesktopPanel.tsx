import { useState, useEffect } from 'react';
import { Toggle } from '../../ui/Toggle';
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

function UpdateSettings() {
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    window.backspace?.getVersion().then(setVersion).catch(() => {});
  }, []);

  const handleCheck = () => {
    setChecking(true);
    window.backspace?.checkForUpdates();
    // Reset after a few seconds — electron-updater doesn't have a "no update" callback
    setTimeout(() => setChecking(false), 5000);
  };

  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex-1 mr-4">
        <div className="text-sm text-txt-primary">
          {version ? `Version ${version}` : translate('runtime.expressions.DesktopPanel.backspaceDesktop')}
        </div>
        <div className="text-xs text-txt-tertiary mt-0.5">
          <Trans i18nKey="ui.DesktopPanel.checkForNewVersionsOfTheDesktopApp">Check for new versions of the desktop app</Trans>
        </div>
      </div>
      <button
        onClick={handleCheck}
        disabled={checking}
        className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors disabled:opacity-50"
      >
        {checking ? translate('runtime.expressions.DesktopPanel.checking') : translate('runtime.expressions.DesktopPanel.checkForUpdates')}
      </button>
    </div>
  );
}

export function DesktopPanel() {
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6"><Trans i18nKey="ui.DesktopPanel.desktop">Desktop</Trans></h2>

      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-3">
        <AutoLaunchSettings />
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
