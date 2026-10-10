import { ipcMain, shell, type BrowserWindow } from 'electron';
import { createRequire } from 'module';
import { getUpdateCapability, isSandboxed } from './updateCapability';
import { loadDismissedVersion, setDismissedVersion } from './updateDismissal';
import { purgeUpdaterCache } from './updaterCache';
import { UpdateStatusStore, RELEASES_URL, shouldPromptForUpdate, statusVersion, type UpdateSnapshot } from './updateStatus';
import { recoveryStore, extractErrorCode, setAutoUpdater } from './recovery';
const loadUpdater = createRequire(__filename);
interface UpdaterContext {
  getWindow: () => BrowserWindow | null;
  showNotification: (title: string, body: string, onClick?: () => void) => void;
}

// ─── Auto-Update ────────────────────────────────────────────────────────────

/**
 * How long to wait for `quitAndInstall()` to actually take the app down before
 * concluding it silently did nothing.
 *
 * electron-updater's `quitAndInstall()` can return normally without starting an
 * install. On macOS this is the documented shape of MacUpdater.quitAndInstall():
 * when Squirrel never staged the update it registers a listener for an event
 * that will never fire and returns. No error, no exception, no restart. That is
 * exactly the dead button this watchdog exists to catch on any platform where
 * the same thing can happen.
 */
const INSTALL_WATCHDOG_MS = 4_000;

export class DesktopUpdater {
  constructor(private readonly context: UpdaterContext) {}
  private updateStore: UpdateStatusStore | null = null;

  /**
   * The update status store, built on first use.
   *
   * Construction needs `app.getPath('userData')` and the signature probe, so it
   * cannot run at module load. Every caller is post-`whenReady`, and the lazy
   * getter means the IPC handlers (registered before the updater starts) and the
   * updater itself share one instance without ordering constraints.
   */
  getUpdateStore(): UpdateStatusStore {
    if (this.updateStore === null) {
      this.updateStore = new UpdateStatusStore(getUpdateCapability(), loadDismissedVersion());
      this.updateStore.subscribe((snapshot) => {
        this.context.getWindow()?.webContents.send('update-status-changed', snapshot);
      });
    }
    return this.updateStore;
  }

  /**
   * Fires the native update notification, if this snapshot warrants one.
   *
   * Asks `shouldPromptForUpdate` rather than deciding for itself, so the toast and
   * the notification cannot disagree about whether the user already said "later".
   *
   * The body branches on capability. Telling a macOS user to "click to restart and
   * install" when the build physically cannot install is the same lie as the dead
   * Restart button, just delivered by the OS instead of the app.
   */
  notifyAboutUpdate(
    snapshot: UpdateSnapshot,
    updater: { quitAndInstall: () => void },
  ): void {
    if (!shouldPromptForUpdate(snapshot)) return;
    // A focused user can see the in-app toast. Notifying as well is noise.
    if (this.context.getWindow()?.isFocused()) return;

    const version = statusVersion(snapshot.status);
    if (version === null) return;

    if (snapshot.status.phase === 'ready' && snapshot.capability === 'auto') {
      this.context.showNotification(
        'Backspace update ready',
        `Click to restart and install version ${version}.`,
        () => updater.quitAndInstall(),
      );
      return;
    }

    this.context.showNotification(
      `Backspace ${version} is available`,
      'Click to open the download page.',
      () => { void shell.openExternal(RELEASES_URL); },
    );
  }

  initAutoUpdater(): void {
    const capability = getUpdateCapability();
    const store = this.getUpdateStore();

    if (capability === 'external') {
      recoveryStore.update({ updateState: 'external' });
      console.log('[update] capability=external (updates are managed by Flatpak)');
      return;
    }

    try {
      const { autoUpdater } = loadUpdater('electron-updater') as typeof import('electron-updater');

      // A build that cannot install its own updates must not download them.
      //
      // With autoDownload on, an ad-hoc signed macOS build pulls the full release
      // archive, hands it to Squirrel.Mac, and Squirrel rejects it because the
      // running app's designated requirement is a literal cdhash that no other
      // build can satisfy. The archive then sits on disk forever (228 MB measured
      // on a real machine, since it is stored twice) and the whole cycle repeats
      // on the next check. Turning the download off removes the wasted transfer,
      // the wasted disk, and the spurious install error all at once.
      autoUpdater.autoDownload = capability === 'auto';
      autoUpdater.autoInstallOnAppQuit = capability === 'auto';

      if (capability === 'manual') {
        // Reclaim whatever earlier versions of this app already stranded.
        purgeUpdaterCache(process.resourcesPath);
      }

      setAutoUpdater(autoUpdater);

      let updateConfirmed = false;
      // The version the current check cycle is about. `download-progress` and the
      // `error` event carry no version of their own, so it is tracked here.
      let pendingVersion: string | null = null;
      // Last percent pushed to the renderer. download-progress fires per chunk;
      // only whole-percent changes are worth an IPC message.
      let lastPercent = -1;

      autoUpdater.on('checking-for-update', () => {
        recoveryStore.update({ updateState: 'checking', lastCheckResult: null });
        store.setStatus({ phase: 'checking' });
        updateConfirmed = false;
        lastPercent = -1;
      });

      autoUpdater.on('update-available', (info: { version: string }) => {
        const version = info.version.slice(0, 32);
        pendingVersion = version;
        // Only an auto-capable build is about to attempt anything, so only there
        // can a later error be an install failure worth reporting.
        updateConfirmed = capability === 'auto';

        if (capability === 'auto') {
          recoveryStore.update({ updateState: 'downloading', updateVersion: version });
          store.setStatus({ phase: 'downloading', version, percent: 0, bytesPerSecond: 0 });
        } else {
          recoveryStore.update({ updateState: 'available-manual', updateVersion: version });
          store.setStatus({ phase: 'available', version });
        }

        this.context.getWindow()?.webContents.send('update-available', { version });

        // In manual mode this is the end of the line, so this is the moment to
        // tell the user. In auto mode the notification waits for the download.
        if (capability === 'manual') {
          this.notifyAboutUpdate(store.get(), autoUpdater);
        }
      });

      autoUpdater.on('update-not-available', () => {
        updateConfirmed = false;
        pendingVersion = null;
        recoveryStore.update({ updateState: 'idle', lastCheckResult: 'up-to-date' });
        store.setStatus({ phase: 'up-to-date', checkedAt: Date.now() });
        setTimeout(() => {
          if (recoveryStore.get().lastCheckResult === 'up-to-date') {
            recoveryStore.update({ lastCheckResult: null });
          }
          if (store.get().status.phase === 'up-to-date') {
            store.setStatus({ phase: 'idle' });
          }
        }, 5_000);
      });

      autoUpdater.on('download-progress', (progress: { percent?: number; bytesPerSecond?: number }) => {
        if (pendingVersion === null) return;
        const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
        if (percent === lastPercent) return;
        lastPercent = percent;
        store.setStatus({
          phase: 'downloading',
          version: pendingVersion,
          percent,
          bytesPerSecond: Math.max(0, Math.round(progress.bytesPerSecond ?? 0)),
        });
      });

      autoUpdater.on('update-downloaded', (info: { version: string }) => {
        const version = info.version.slice(0, 32);
        pendingVersion = version;
        recoveryStore.update({ updateState: 'downloaded', updateVersion: version });
        store.setStatus({ phase: 'ready', version });
        this.context.getWindow()?.webContents.send('update-downloaded', { version });
        this.notifyAboutUpdate(store.get(), autoUpdater);
      });

      autoUpdater.on('error', (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const code = extractErrorCode(err);
        recoveryStore.update({
          updateState: 'error',
          lastUpdateError: { message, code, at: Date.now() },
          lastCheckResult: 'failed',
        });
        setTimeout(() => {
          if (recoveryStore.get().lastCheckResult === 'failed') {
            recoveryStore.update({ lastCheckResult: null });
          }
        }, 5_000);

        if (updateConfirmed) {
          // An update was actually being applied. This is news.
          store.setStatus({ phase: 'failed', version: pendingVersion, message });
          this.context.getWindow()?.webContents.send('update-error', { message, releaseUrl: RELEASES_URL });
          this.notifyAboutUpdate(store.get(), autoUpdater);
          return;
        }

        // A check-phase failure: nothing was attempted, so there is nothing for
        // the user to act on. Recorded with no version, which keeps it out of the
        // toast (see shouldPromptForUpdate) while the settings panel still shows
        // it. Interrupting someone because a background poll hit a flaky network
        // is exactly the kind of noise this rewrite is removing.
        store.setStatus({ phase: 'failed', version: null, message });
      });

      // Initial check with 10s delay (existing behavior)
      setTimeout(() => {
        updateConfirmed = false;
        autoUpdater.checkForUpdates().catch(() => {});
      }, 10_000);

      // Periodic check every 4 hours (existing behavior)
      setInterval(() => {
        updateConfirmed = false;
        autoUpdater.checkForUpdates().catch(() => {});
      }, 4 * 60 * 60 * 1000);
    } catch {
      // Auto-updater unavailable — recovery surface still functions, just
      // without update affordances. autoUpdaterRef stays null; recovery action
      // handlers no-op on update-related actions.
    }
  }

  registerIpc(): void {
  // Auto-update IPC
  ipcMain.on('install-update', () => {
    const store = this.getUpdateStore();
    const snapshot = store.get();

    // A build that cannot install in place has no in-place install to run. Send
    // the user to the download instead of calling a method that returns without
    // doing anything, which is the defect this whole path exists to remove.
    if (snapshot.capability === 'external') return;
    if (snapshot.capability === 'manual') {
      void shell.openExternal(RELEASES_URL);
      return;
    }

    try {
      const { autoUpdater } = loadUpdater('electron-updater') as typeof import('electron-updater');
      autoUpdater.quitAndInstall();
    } catch {
      store.setStatus({
        phase: 'failed',
        version: statusVersion(snapshot.status),
        message: 'The updater is not available in this build.',
      });
      return;
    }

    // If the install started, the app is gone before this fires. If it did not,
    // the user is still looking at a Restart button that appears to have done
    // nothing, and now the app says so instead of leaving them guessing.
    setTimeout(() => {
      const current = this.getUpdateStore().get();
      if (current.status.phase !== 'ready') return;
      this.getUpdateStore().setStatus({
        phase: 'failed',
        version: statusVersion(current.status),
        message: 'Restarting to install the update did not start.',
      });
    }, INSTALL_WATCHDOG_MS);
  });

  ipcMain.on('check-for-updates', () => {
    if (getUpdateCapability() === 'external') return;
    try {
      const { autoUpdater } = loadUpdater('electron-updater') as typeof import('electron-updater');
      autoUpdater.checkForUpdates().catch(() => {});
    } catch {
      // Auto-updater not available
    }
  });

  ipcMain.handle('get-update-status', () => this.getUpdateStore().get());

  // Sandbox restrictions are independent of update capability. A package may
  // delegate updates while still supporting host login-item registration.
  ipcMain.handle('is-sandboxed', () => isSandboxed());

  ipcMain.on('dismiss-update', (_event, payload: { version?: unknown }) => {
    const version = typeof payload?.version === 'string' ? payload.version.trim() : '';
    if (version === '') return;
    setDismissedVersion(version);
    // Read back rather than assume. If the write failed, the store keeps the old
    // value and the prompt honestly reappears next launch instead of silently
    // vanishing from a user who would then never see the update again.
    this.getUpdateStore().setDismissedVersion(loadDismissedVersion());
  });

  ipcMain.on('open-release-page', () => {
    void shell.openExternal(RELEASES_URL);
  });

  }
}
