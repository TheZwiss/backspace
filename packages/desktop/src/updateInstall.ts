/**
 * How a downloaded update is installed when the user asks for it ("Restart",
 * the native notification, the recovery screen's Restart button).
 *
 * Windows installs silently and reopens the app by itself. `quitAndInstall()`
 * with no arguments runs the NSIS installer with its window (progress page and
 * all) and leaves the reopening to `autoRunAppAfterInstall`; `(true, true)`
 * passes `/S --force-run` instead, so the app closes, the installer works with
 * no window and Backspace comes back, the way Discord updates. (Closing the app
 * with an update already downloaded was already silent: electron-updater's quit
 * handler calls `install(true, false)`.)
 *
 * Other platforms keep the updater's own defaults: macOS ignores both flags (it
 * hands the staged update to Squirrel.Mac) and the Linux AppImage relaunches
 * through `autoRunAppAfterInstall`.
 */

export interface UpdaterInstallOptions {
  isSilent: boolean;
  isForceRunAfter: boolean;
}

export function updaterInstallOptions(platform: NodeJS.Platform = process.platform): UpdaterInstallOptions {
  return platform === 'win32'
    ? { isSilent: true, isForceRunAfter: true }
    : { isSilent: false, isForceRunAfter: false };
}

export interface InstallableUpdater {
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** Quit and install the downloaded update, silently on Windows. */
export function installDownloadedUpdate(
  updater: InstallableUpdater,
  platform: NodeJS.Platform = process.platform,
): void {
  const { isSilent, isForceRunAfter } = updaterInstallOptions(platform);
  updater.quitAndInstall(isSilent, isForceRunAfter);
}
