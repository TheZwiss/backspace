import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  nativeImage,
  ipcMain,
  shell,
  screen,
  session,
  desktopCapturer,
} from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { startActivityDetection, stopActivityDetection, getCurrentActivity } from './activityDetector';
import { KeybindManager } from './keybindManager';
import { deriveStartMinimizedFromArgs, parseExecPathFromDesktopFile, shouldReapplyAppImage } from './autoLaunch';
import {
  loadInstanceUrl,
  saveInstanceUrl,
  clearInstanceUrl,
  getPickerPath,
} from './instanceUrl';
import {
  recoveryStore,
  attachRecoveryHandlers,
  extractErrorCode,
  setAutoUpdater,
  setMainWindow,
  setOnQuitRequested,
  handleRendererReady,
  handleRecoveryAction,
  isValidRecoveryAction,
  buildTrayMenuTemplate,
  buildAppMenuTemplate,
  type RecoveryState,
} from './recovery';

let mainWindow: BrowserWindow | null = null;
const keybindManager = new KeybindManager();
let tray: Tray | null = null;
let isQuitting = false;
let pendingDeepLink: string | null = null;

const knownInstanceOrigins = new Set<string>();

// ─── Window State Persistence ───────────────────────────────────────────────

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1280,
  height: 800,
  isMaximized: false,
};

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    return {
      width: typeof parsed.width === 'number' ? parsed.width : DEFAULT_WINDOW_STATE.width,
      height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_WINDOW_STATE.height,
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      isMaximized: typeof parsed.isMaximized === 'boolean' ? parsed.isMaximized : false,
    };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function validateWindowBounds(state: WindowState): WindowState {
  if (state.x === undefined || state.y === undefined) return state;

  const bounds = { x: state.x, y: state.y, width: state.width, height: state.height };
  const display = screen.getDisplayMatching(bounds);
  const { x, y, width, height } = display.workArea;

  // Check if window is at least partially visible on the display
  const visible =
    bounds.x + bounds.width > x &&
    bounds.x < x + width &&
    bounds.y + bounds.height > y &&
    bounds.y < y + height;

  if (!visible) {
    // Strip position — let Electron auto-center
    return { width: state.width, height: state.height, isMaximized: state.isMaximized };
  }

  return state;
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const isMaximized = win.isMaximized();
    // Use the bounds from before maximize, to restore the un-maximized size
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    };
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state));
  } catch {
    // Non-critical — silently ignore write failures
  }
}

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

function loadAutoLaunchSettings(): AutoLaunchSettings {
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

function saveAutoLaunchSettings(settings: AutoLaunchSettings): void {
  fs.writeFileSync(getAutoLaunchSettingsPath(), JSON.stringify(settings));
}

function applyLoginItemSettings(openAtLogin: boolean, startMinimized: boolean): void {
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

// ─── Tray Icon ──────────────────────────────────────────────────────────────

function generateFallbackTrayIcon(): Electron.NativeImage {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        // NativeImage raw buffer uses BGRA on most platforms
        canvas[idx] = 0xf2;     // B (blurple #5865f2)
        canvas[idx + 1] = 0x65; // G
        canvas[idx + 2] = 0x58; // R
        canvas[idx + 3] = 0xff; // A
      } else {
        canvas[idx] = 0;
        canvas[idx + 1] = 0;
        canvas[idx + 2] = 0;
        canvas[idx + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function loadTrayIcon(): Electron.NativeImage {
  const resourcesDir = path.join(__dirname, '..', 'resources');
  try {
    if (process.platform === 'darwin') {
      // macOS template image: Electron auto-resolves @2x from the base path.
      // Template images adapt to light/dark menu bar automatically.
      const templatePath = path.join(resourcesDir, 'tray-iconTemplate.png');
      const icon = nativeImage.createFromPath(templatePath);
      if (!icon.isEmpty()) {
        icon.setTemplateImage(true);
        return icon;
      }
    } else if (process.platform === 'win32') {
      // Windows: multi-size .ico — Windows + Electron auto-pick best size for current DPI.
      const icoPath = path.join(resourcesDir, 'tray-icon.ico');
      const icon = nativeImage.createFromPath(icoPath);
      if (!icon.isEmpty()) {
        return icon;
      }
    } else {
      // Linux: single 22x22 PNG (AppIndicator / StatusNotifier convention).
      // No runtime resize — the source is already at correct tray size.
      const iconPath = path.join(resourcesDir, 'tray-icon.png');
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) {
        return icon;
      }
    }
  } catch {
    // Fall through to generated icon
  }
  return generateFallbackTrayIcon();
}

// ─── Window & Tray Creation ─────────────────────────────────────────────────

function createWindow(): void {
  const savedState = validateWindowBounds(loadWindowState());

  mainWindow = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    ...(savedState.x !== undefined && savedState.y !== undefined
      ? { x: savedState.x, y: savedState.y }
      : {}),
    minWidth: 940,
    minHeight: 500,
    title: 'Backspace',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin' ? {
      titleBarOverlay: {
        color: '#0b0b10',
        symbolColor: '#d8d8de',
        height: 32,
      },
    } : {}),
    backgroundColor: '#313338',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  setMainWindow(mainWindow);
  attachRecoveryHandlers(mainWindow);
  keybindManager.setWindow(mainWindow);

  if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  // URL resolution priority:
  // 1. BACKSPACE_URL env var (managed deployments)
  // 2. Saved instance URL from picker
  // 3. No URL → show instance picker
  const envUrl = process.env.BACKSPACE_URL;
  if (envUrl) {
    mainWindow.loadURL(envUrl);
  } else {
    const savedUrl = loadInstanceUrl();
    if (savedUrl) {
      mainWindow.loadURL(savedUrl);
    } else {
      mainWindow.loadFile(getPickerPath());
    }
  }

  mainWindow.once('ready-to-show', () => {
    // Hidden-launch detection. We pass `args: ['--hidden']` on all three platforms
    // (see applyLoginItemSettings), so the argv check is the primary signal. On
    // macOS we also honour `wasOpenedAsHidden` as a fallback for the legacy
    // openAsHidden path on macOS < 13.
    const launchedHidden =
      process.argv.includes('--hidden') ||
      (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden);

    if (!launchedHidden) {
      mainWindow?.show();
    }

    // Send any pending deep link that launched the app
    if (pendingDeepLink && mainWindow) {
      mainWindow.webContents.send('deep-link', pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  // Window state persistence — debounced save on resize/move
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  const debouncedSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        saveWindowState(mainWindow);
      }
    }, 300);
  };

  mainWindow.on('resize', debouncedSave);
  mainWindow.on('move', debouncedSave);

  mainWindow.on('close', (event) => {
    // Save state before close
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveWindowState(mainWindow);
    }

    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    setMainWindow(null);
    mainWindow = null;
  });

  // Window focus IPC for notification suppression
  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('window-focus-changed', true);
  });
  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window-focus-changed', false);
  });

  // Intercept own-instance /join/* URLs so they open in-app instead of the
  // system browser. Other URLs continue to open externally.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        knownInstanceOrigins.has(u.origin) &&
        u.pathname.startsWith('/join/')
      ) {
        mainWindow?.webContents.send('open-internal-route', u.pathname + u.search);
        return { action: 'deny' };
      }
    } catch { /* malformed URL — fall through to external */ }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

function createTray(): void {
  const icon = loadTrayIcon();
  tray = new Tray(icon);

  tray.setToolTip('Backspace');
  // Context menu is set by the recoveryStore subscriber in app.whenReady,
  // which keeps the menu in sync with update/recovery state.

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

// ─── Notifications ──────────────────────────────────────────────────────────

function showNotification(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', onClick ?? (() => {
    mainWindow?.show();
    mainWindow?.focus();
  }));
  notification.show();
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.on('show-notification', (_event, data: { title: string; body: string }) => {
    showNotification(data.title, data.body);
  });

  ipcMain.on('set-badge-count', (_event, count: number) => {
    if (app.setBadgeCount) {
      app.setBadgeCount(count);
    }
  });

  ipcMain.on('minimize-window', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('maximize-window', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('close-window', () => {
    mainWindow?.close();
  });

  // Connected-origins sync — renderer pushes the current set of instance origins
  // so setWindowOpenHandler can route /join/* URLs in-app synchronously.
  ipcMain.on('set-connected-origins', (_evt, origins: unknown) => {
    if (!Array.isArray(origins)) return;
    knownInstanceOrigins.clear();
    for (const o of origins) {
      if (typeof o === 'string' && o.length > 0) knownInstanceOrigins.add(o);
    }
  });

  // Instance URL management
  ipcMain.handle('get-instance-url', () => loadInstanceUrl());

  ipcMain.handle('set-instance-url', (_event, url: string) => {
    saveInstanceUrl(url);
    if (mainWindow) {
      mainWindow.loadURL(url);
      // Force Electron to re-evaluate drag regions after navigation
      mainWindow.webContents.once('did-finish-load', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const bounds = mainWindow.getBounds();
          mainWindow.setSize(bounds.width + 1, bounds.height);
          mainWindow.setSize(bounds.width, bounds.height);
        }
      });
    }
  });

  ipcMain.handle('clear-instance-url', () => {
    clearInstanceUrl();
    if (mainWindow) {
      mainWindow.loadFile(getPickerPath());
      // Force Electron to re-evaluate drag regions after navigation
      mainWindow.webContents.once('did-finish-load', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const bounds = mainWindow.getBounds();
          mainWindow.setSize(bounds.width + 1, bounds.height);
          mainWindow.setSize(bounds.width, bounds.height);
        }
      });
    }
  });

  // Auto-update IPC
  ipcMain.on('install-update', () => {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.quitAndInstall();
    } catch {
      // Auto-updater not available
    }
  });

  ipcMain.on('check-for-updates', () => {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.checkForUpdates().catch(() => {});
    } catch {
      // Auto-updater not available
    }
  });

  ipcMain.handle('get-app-version', () => app.getVersion());

  // Screen share picker coordination (used by setDisplayMediaRequestHandler)
  ipcMain.on('screen-share-selected', (_event, _sourceId: string | null, _shareAudio?: boolean) => {
    // Handled via ipcMain.once in the display media handler — this is just
    // a safety net to prevent unhandled-message warnings
  });

  // Auto-launch settings
  ipcMain.handle('get-auto-launch-settings', (): { openAtLogin: boolean; startMinimized: boolean } => {
    if (process.platform === 'win32') {
      // Pass path/args so getLoginItemSettings can find the matching launchItems[] entry.
      // We can't know in advance whether the user's saved choice was minimized or not,
      // so we query without args and inspect launchItems[] directly. Use
      // executableWillLaunchAtLogin to honour Task Manager's StartupApproved state.
      const osState = app.getLoginItemSettings({ path: process.execPath });
      const ownEntry = osState.launchItems?.find(
        (item) => item.name === 'Backspace' || item.path?.toLowerCase() === process.execPath.toLowerCase(),
      );
      // When the Run entry exists, its args are the source of truth for startMinimized.
      // When the entry is absent (autostart is off), there is no OS state to read, so we
      // fall back to the disk cache — this preserves the user's preference across an
      // off/on cycle so re-enabling restores their previous startMinimized choice.
      const startMinimized = ownEntry
        ? deriveStartMinimizedFromArgs(ownEntry.args)
        : loadAutoLaunchSettings().startMinimized;
      return {
        openAtLogin: osState.executableWillLaunchAtLogin ?? false,
        startMinimized,
      };
    }
    // macOS and Linux: getLoginItemSettings doesn't expose args, so startMinimized
    // is disk-cached. Rationale: parsing freedesktop Exec= lines on Linux is fragile
    // (quoting, escaping, third-party flags) and the out-of-band edit case is rare;
    // macOS has no introspection. openAtLogin is OS-authoritative on both platforms.
    const saved = loadAutoLaunchSettings();
    const osState = app.getLoginItemSettings();
    return {
      openAtLogin: osState.openAtLogin,
      startMinimized: saved.startMinimized,
    };
  });

  ipcMain.handle('set-auto-launch-settings', (_event, settings: { openAtLogin?: boolean; startMinimized?: boolean }) => {
    // Read current truth from the OS (not from disk) so a partial update preserves
    // whatever the user (or Task Manager / System Settings) most recently set.
    let currentOpenAtLogin: boolean;
    let currentStartMinimized: boolean;

    if (process.platform === 'win32') {
      const osState = app.getLoginItemSettings({ path: process.execPath });
      const ownEntry = osState.launchItems?.find(
        (item) => item.name === 'Backspace' || item.path?.toLowerCase() === process.execPath.toLowerCase(),
      );
      currentOpenAtLogin = osState.executableWillLaunchAtLogin ?? false;
      // See `get-auto-launch-settings`: when the entry is absent, fall back to disk
      // cache so a partial update that re-enables openAtLogin restores the user's
      // previously-saved startMinimized choice rather than resetting to false.
      currentStartMinimized = ownEntry
        ? deriveStartMinimizedFromArgs(ownEntry.args)
        : loadAutoLaunchSettings().startMinimized;
    } else {
      const osState = app.getLoginItemSettings();
      const saved = loadAutoLaunchSettings();
      currentOpenAtLogin = osState.openAtLogin;
      currentStartMinimized = saved.startMinimized;
    }

    const newOpenAtLogin = settings.openAtLogin ?? currentOpenAtLogin;
    const newStartMinimized = settings.startMinimized ?? currentStartMinimized;

    applyLoginItemSettings(newOpenAtLogin, newStartMinimized);

    // Persist startMinimized as a disk cache for the macOS / Linux read path.
    // We also save openAtLogin for forward compatibility / debugging, but it is
    // never the source of truth on read.
    saveAutoLaunchSettings({
      openAtLogin: newOpenAtLogin,
      startMinimized: newStartMinimized,
    });

    return { openAtLogin: newOpenAtLogin, startMinimized: newStartMinimized };
  });

  // Keybinds
  ipcMain.on('keybinds-sync', (_event, keybinds) => {
    keybindManager.updateKeybinds(keybinds);
  });

  ipcMain.handle('check-accessibility', () => {
    return keybindManager.checkAccessibility();
  });

  // Recovery / boot-stall protocol
  ipcMain.on('renderer-ready', () => {
    handleRendererReady();
  });

  ipcMain.on('recovery-action', (_e, action: unknown) => {
    if (!isValidRecoveryAction(action)) {
      console.warn('[recovery] ignored unknown action:', action);
      return;
    }
    handleRecoveryAction(action);
  });

  ipcMain.handle('get-recovery-state', () => recoveryStore.get());
}

// ─── Auto-Update ────────────────────────────────────────────────────────────

function initAutoUpdater(): void {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    setAutoUpdater(autoUpdater);

    let updateConfirmed = false;

    autoUpdater.on('checking-for-update', () => {
      recoveryStore.update({ updateState: 'checking', lastCheckResult: null });
      updateConfirmed = false;
    });

    autoUpdater.on('update-available', (info: { version: string }) => {
      updateConfirmed = true;
      recoveryStore.update({ updateState: 'downloading', updateVersion: info.version });
      mainWindow?.webContents.send('update-available', { version: info.version });
    });

    autoUpdater.on('update-not-available', () => {
      updateConfirmed = false;
      recoveryStore.update({ updateState: 'idle', lastCheckResult: 'up-to-date' });
      setTimeout(() => {
        if (recoveryStore.get().lastCheckResult === 'up-to-date') {
          recoveryStore.update({ lastCheckResult: null });
        }
      }, 5_000);
    });

    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      const version = info.version.slice(0, 32);
      recoveryStore.update({ updateState: 'downloaded', updateVersion: version });
      mainWindow?.webContents.send('update-downloaded', { version });

      // Symmetric focus-based suppression: if the user is looking at the
      // window, the in-app banner (normal mode) or recovery Restart button
      // (recovery mode) is visible — no need to also fire a native toast.
      if (!mainWindow?.isFocused()) {
        showNotification(
          'Backspace update ready',
          `Click to restart and install version ${version}.`,
          () => autoUpdater.quitAndInstall(),
        );
      }
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
      // Existing behavior preserved: only push renderer error IPC after
      // confirmed update. Check-phase errors stay silent.
      if (updateConfirmed) {
        mainWindow?.webContents.send('update-error', {
          message,
          releaseUrl: 'https://github.com/TheZwiss/backspace/releases/latest',
        });
      }
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

// ─── Deep Linking ───────────────────────────────────────────────────────────

function handleDeepLink(url: string): void {
  if (!url.startsWith('backspace://')) return;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deep-link', url);
    mainWindow.show();
    mainWindow.focus();
  } else {
    // App not ready yet — store for later
    pendingDeepLink = url;
  }
}


// Electron 36+ defaults to GTK 4 on GNOME, which crashes if GTK 2/3
// libraries are loaded in the same process. Force GTK 3 for compatibility.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3');
  // Chromium ships PulseAudio loopback for screen-share behind a feature flag.
  // Without it, returning `audio: 'loopback'` from setDisplayMediaRequestHandler
  // fails the whole getDisplayMedia request — screen share never starts when the
  // user has "Share system audio" enabled.
  app.commandLine.appendSwitch('enable-features', 'PulseaudioLoopbackForScreenShare');
}

// Windows: AppUserModelId so toast notifications attribute correctly to Backspace
// (without this, recovery / update notifications appear under "electron.exe").
if (process.platform === 'win32') {
  app.setAppUserModelId('com.backspace.desktop');
}

/**
 * Request a clean app quit. Sets the isQuitting flag so the window 'close'
 * handler doesn't intercept (which would just hide the window) and then
 * triggers app.quit(). Exported so the recovery module can request a quit
 * via setOnQuitRequested without reaching into private state.
 */
export function requestQuit(): void {
  isQuitting = true;
  app.quit();
}

// Set as default protocol handler
app.setAsDefaultProtocolClient('backspace');

// macOS: open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Windows/Linux: single instance lock — deep links come as second-instance args
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Find the deep link URL in the command line args
    const deepLinkArg = commandLine.find((arg) => arg.startsWith('backspace://'));
    if (deepLinkArg) {
      handleDeepLink(deepLinkArg);
    }

    // Focus the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ─── App Lifecycle ──────────────────────────────────────────────────────────

  app.whenReady().then(async () => {
    // Win/Linux: frameless window has no menu bar, but we still need an
    // application menu so keyboard accelerators (Ctrl+C/V/X/Z/A) work.
    // The macOS app menu is owned by the recoveryStore subscriber below
    // (so it can re-render with current update/recovery state).
    if (process.platform !== 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
      ]));
    }

    // Purge ALL stale caches so Electron always loads fresh code on launch
    await session.defaultSession.clearStorageData({ storages: ['serviceworkers'] });
    await session.defaultSession.clearCache();

    // Intercept getDisplayMedia() — show custom picker in renderer.
    // Audio loopback controlled by user's shareAudio toggle.
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      console.log('[Main:ScreenShare] Handler invoked');
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true,
        });
        console.log('[Main:ScreenShare] Got', sources.length, 'sources');

        if (sources.length === 0) {
          console.warn('[Main:ScreenShare] No sources — Screen Recording permission may not be granted');
          // @ts-ignore — Electron throws if we pass {} when video was requested; pass nothing to deny
          callback();
          return;
        }

        const serialized = sources.map((source) => ({
          id: source.id,
          name: source.name,
          thumbnailDataUrl: source.thumbnail.toDataURL(),
          appIconDataUrl: source.appIcon && !source.appIcon.isEmpty()
            ? source.appIcon.toDataURL() : null,
          isScreen: source.id.startsWith('screen:'),
        }));

        // Send sources to renderer, wait for user selection
        mainWindow?.webContents.send('screen-share-sources', serialized);

        const { sourceId, shareAudio } = await new Promise<{ sourceId: string | null; shareAudio: boolean }>((resolve) => {
          ipcMain.once('screen-share-selected', (_event, id: string | null, wantAudio?: boolean) => {
            resolve({ sourceId: id, shareAudio: wantAudio ?? true });
          });
        });
        console.log('[Main:ScreenShare] User selected:', sourceId, 'audio:', shareAudio);

        if (!sourceId) {
          // @ts-ignore — deny the request without crashing
          callback();
          return;
        }

        const selected = sources.find((s) => s.id === sourceId);
        if (!selected) {
          // @ts-ignore — deny the request without crashing
          callback();
          return;
        }

        // Provide the selected source — Electron creates the MediaStream.
        // System audio loopback support varies:
        //   - Windows: native (Chromium default).
        //   - macOS 13+: CoreAudio Tap; requires NSAudioCaptureUsageDescription
        //     in Info.plist (electron-builder injects it via mac.extendInfo).
        //   - Linux: PulseAudio loopback, gated behind the
        //     `PulseaudioLoopbackForScreenShare` feature flag we enable above.
        //     Fails on PipeWire-only systems without pulse compat — the
        //     renderer catches that and toasts the user.
        callback({ video: selected, ...(shareAudio ? { audio: 'loopback' } : {}) });
      } catch (err) {
        console.error('[Main:ScreenShare] Handler error:', err);
        // @ts-ignore — deny the request without crashing
        callback();
      }
    });

    registerIpcHandlers();
    createWindow();
    createTray();

    // Wire the recovery module's quit callback to the local requestQuit.
    setOnQuitRequested(() => requestQuit());

    // Tray + macOS app-menu actions. Defined once so the subscriber and the
    // initial-fire share one implementation (no drift on future menu changes).
    const trayActions = {
      onShow: () => { mainWindow?.show(); mainWindow?.focus(); },
      onHide: () => mainWindow?.hide(),
      onChangeInstance: () => {
        clearInstanceUrl();
        mainWindow?.loadFile(getPickerPath());
        mainWindow?.show();
        mainWindow?.focus();
      },
      onCheckForUpdates: () => handleRecoveryAction('check-update'),
      onRestartToInstall: () => handleRecoveryAction('install-update'),
      onQuit: () => requestQuit(),
    };

    const applyMenusForState = (state: RecoveryState): void => {
      if (tray) {
        tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(state, trayActions)));
      }
      if (process.platform === 'darwin') {
        Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(app.name, state, trayActions)));
      }
      // Mode-gated push to renderer (recovery.html subscribes to this).
      if (state.mode === 'recovery' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recovery-state-changed', state);
      }
    };

    recoveryStore.subscribe(applyMenusForState);
    applyMenusForState(recoveryStore.get());  // initial fire — subscribers don't auto-fire on subscribe

    initAutoUpdater();

    // ─── Activity Detection ────────────────────────────────────────────────
    startActivityDetection((activity) => {
      mainWindow?.webContents.send('activity-detected', activity);
    });

    ipcMain.handle('get-current-activity', () => getCurrentActivity());

    // Linux/AppImage path-refresh ONLY. On Windows and macOS the OS is the source
    // of truth for openAtLogin (Task 4) and we must not override user changes made
    // via Task Manager / System Settings by re-applying disk state here.
    //
    // For an AppImage install whose path changed (e.g. the user replaced the file
    // after an update), the autostart .desktop file's Exec= line points at the old
    // path. Re-apply only when $APPIMAGE differs from the recorded Exec= path.
    if (process.platform === 'linux' && process.env.APPIMAGE) {
      try {
        const desktopFilePath = path.join(
          os.homedir(),
          '.config',
          'autostart',
          'backspace.desktop',
        );
        let recordedExecPath: string | null = null;
        try {
          const content = fs.readFileSync(desktopFilePath, 'utf-8');
          recordedExecPath = parseExecPathFromDesktopFile(content);
        } catch {
          // No autostart entry exists. recordedExecPath stays null and shouldReapplyAppImage
          // will return false — a missing file is treated as user-disabled (out-of-band edit),
          // not a stale-path-needs-refresh signal.
        }
        const saved = loadAutoLaunchSettings();
        if (saved.openAtLogin && shouldReapplyAppImage(process.env.APPIMAGE, recordedExecPath)) {
          applyLoginItemSettings(saved.openAtLogin, saved.startMinimized);
        }
      } catch (err) {
        console.error('[autoLaunch] AppImage path-refresh check failed:', err);
      }
    }

    // Check if the app was launched with a deep link (Windows/Linux)
    const launchArg = process.argv.find((arg) => arg.startsWith('backspace://'));
    if (launchArg) {
      pendingDeepLink = launchArg;
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopActivityDetection();
    keybindManager.stop();
  });
}
