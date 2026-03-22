import { useState, useEffect } from 'react';
import { Toggle } from '../../ui/Toggle';

function AutoLaunchSettings() {
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [startMinimized, setStartMinimized] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.backspace?.getAutoLaunchSettings().then((settings) => {
      setOpenAtLogin(settings.openAtLogin);
      setStartMinimized(settings.startMinimized);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleOpenAtLoginChange = async (enabled: boolean) => {
    setOpenAtLogin(enabled);
    try {
      const result = await window.backspace!.setAutoLaunchSettings({ openAtLogin: enabled });
      setOpenAtLogin(result.openAtLogin);
      setStartMinimized(result.startMinimized);
    } catch {
      setOpenAtLogin(!enabled);
    }
  };

  const handleStartMinimizedChange = async (enabled: boolean) => {
    setStartMinimized(enabled);
    try {
      const result = await window.backspace!.setAutoLaunchSettings({ startMinimized: enabled });
      setOpenAtLogin(result.openAtLogin);
      setStartMinimized(result.startMinimized);
    } catch {
      setStartMinimized(!enabled);
    }
  };

  if (loading) return null;

  return (
    <>
      <div className="flex items-center justify-between py-1">
        <div className="flex-1 mr-4">
          <div className="text-sm text-txt-primary">Start at boot</div>
          <div className="text-xs text-txt-tertiary mt-0.5">
            Automatically launch Backspace when you log in
          </div>
        </div>
        <Toggle enabled={openAtLogin} onChange={handleOpenAtLoginChange} />
      </div>
      <div className="flex items-center justify-between py-1">
        <div className="flex-1 mr-4">
          <div className={`text-sm ${openAtLogin ? 'text-txt-primary' : 'text-txt-tertiary'}`}>Start minimized</div>
          <div className="text-xs text-txt-tertiary mt-0.5">
            Start hidden in the system tray instead of showing the window
          </div>
        </div>
        <Toggle enabled={startMinimized} onChange={handleStartMinimizedChange} />
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
          {version ? `Version ${version}` : 'Backspace Desktop'}
        </div>
        <div className="text-xs text-txt-tertiary mt-0.5">
          Check for new versions of the desktop app
        </div>
      </div>
      <button
        onClick={handleCheck}
        disabled={checking}
        className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors disabled:opacity-50"
      >
        {checking ? 'Checking...' : 'Check for Updates'}
      </button>
    </div>
  );
}

export function DesktopPanel() {
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">Desktop</h2>

      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-3">
        <AutoLaunchSettings />
        <UpdateSettings />

        <div className="border-t border-white/[0.04]" />

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-txt-primary font-medium">{window.location.origin}</div>
            <div className="text-xs text-txt-tertiary mt-0.5">Currently connected instance</div>
          </div>
          <button
            onClick={() => window.backspace?.clearInstanceUrl()}
            className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors"
          >
            Change Instance
          </button>
        </div>
      </div>
    </div>
  );
}
