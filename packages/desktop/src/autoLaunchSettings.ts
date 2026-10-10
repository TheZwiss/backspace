import { app } from 'electron';
import fs from 'fs';
import path from 'path';

// ─── Auto-Launch Settings ────────────────────────────────────────────────────

interface AutoLaunchSettings {
  openAtLogin: boolean;
  startMinimized: boolean;
}

const DEFAULT_AUTO_LAUNCH: AutoLaunchSettings = {
  openAtLogin: false,
  startMinimized: true,
};

function getAutoLaunchSettingsPath(): string {
  return path.join(app.getPath('userData'), 'auto-launch.json');
}

export function loadAutoLaunchSettings(): AutoLaunchSettings {
  try {
    const raw = fs.readFileSync(getAutoLaunchSettingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AutoLaunchSettings>;
    return {
      openAtLogin: typeof parsed.openAtLogin === 'boolean' ? parsed.openAtLogin : DEFAULT_AUTO_LAUNCH.openAtLogin,
      startMinimized: typeof parsed.startMinimized === 'boolean' ? parsed.startMinimized : DEFAULT_AUTO_LAUNCH.startMinimized,
    };
  } catch {
    return { ...DEFAULT_AUTO_LAUNCH };
  }
}

export function saveAutoLaunchSettings(settings: AutoLaunchSettings): void {
  fs.writeFileSync(getAutoLaunchSettingsPath(), JSON.stringify(settings));
}

export function applyLoginItemSettings(openAtLogin: boolean, startMinimized: boolean): void {
  if (process.platform === 'darwin') {
    // macOS: pass `args` in addition to `openAsHidden` so the renderer/main can
    // detect a hidden launch via `process.argv.includes('--hidden')` on macOS 13+
    // where the new ServiceManagement-backed implementation may not honour
    // `wasOpenedAsHidden`. Both detection paths now work (defence in depth).
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: startMinimized,
      args: startMinimized ? ['--hidden'] : [],
    });
  } else if (process.platform === 'win32') {
    // Windows: `enabled` is REQUIRED to undo a Task-Manager-side disable.
    // Without it, re-enabling our toggle leaves the StartupApproved\Run
    // "disabled" marker in place and the user's Run entry still won't fire.
    // We pass `enabled: openAtLogin` so toggling ON re-enables, toggling OFF
    // removes the entry entirely (deletion supersedes the disable marker).
    // `path` and `args` are passed explicitly so subsequent get() calls can
    // match the right launchItems[] entry.
    app.setLoginItemSettings({
      openAtLogin,
      enabled: openAtLogin,
      path: process.execPath,
      args: startMinimized ? ['--hidden'] : [],
      name: 'Backspace',
    });
  } else {
    // Linux: setLoginItemSettings creates ~/.config/autostart/<name>.desktop.
    // - We pass an explicit `name: 'backspace'` so the filename is deterministic
    //   across deb/AppImage installs and Electron versions.
    // - For AppImage, $APPIMAGE points to the (possibly newly-updated) AppImage
    //   path; pass it as `path` so the autostart entry tracks updates.
    //   Electron's TypeScript types don't list `path`/`args`/`name` on Linux,
    //   but the runtime accepts them.
    const opts: Record<string, unknown> = {
      openAtLogin,
      name: 'backspace',
    };
    if (process.env.APPIMAGE) {
      opts.path = process.env.APPIMAGE;
    }
    if (startMinimized) {
      opts.args = ['--hidden'];
    }
    app.setLoginItemSettings(opts as Electron.Settings);
  }
}
