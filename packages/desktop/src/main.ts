import { isSandboxed } from './updateCapability';
import { DesktopUpdater } from './desktopUpdater';
import { registerTranslationIpc } from './translation/ipc';
import { loadTrayIcon } from './trayIcon';
import { loadAutoLaunchSettings, saveAutoLaunchSettings, applyLoginItemSettings } from './autoLaunchSettings';
import { loadWindowState, validateWindowBounds, saveWindowState } from './windowState';
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  shell,
  session,
  desktopCapturer,
} from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { pathToFileURL } from 'url';
import { startActivityDetection, stopActivityDetection, getCurrentActivity } from './activityDetector';
import { KeybindManager } from './keybindManager';
import { deriveStartMinimizedFromArgs, parseExecPathFromDesktopFile, shouldReapplyAppImage } from './autoLaunch';
import {
  loadInstanceUrl,
  saveInstanceUrl,
  clearInstanceUrl,
  getPickerPath,
} from './instanceUrl';
import { ownAudioInSystemAudio } from './systemAudioCapability';
import {
  recoveryStore,
  attachRecoveryHandlers,
  setMainWindow,
  setOnQuitRequested,
  handleRendererReady,
  handleRecoveryAction,
  isValidRecoveryAction,
  buildTrayMenuTemplate,
  buildAppMenuTemplate,
  type RecoveryState,
} from './recovery';
import { migrateUserData } from './userDataMigration';
import { isNavigationAllowed } from './navigationPolicy';
import { NotificationRetainer } from './notificationRetention';
import {
  screenSharePickerMode,
  isPendingSelectionFresh,
  screenEnumerationDecision,
  type PendingScreenSelection,
  type ScreenSharePickerMode,
} from './screenSharePolicy';
import { getDesktopLanguage, isDesktopLanguage, saveStoredLanguage, translateDesktop } from './l10n';

// Override Electron's package.json-derived app name so userData lives at
// "<appData>/Backspace" instead of leaking the monorepo's "@backspace/desktop"
// package name. Must run before any app.getPath('userData') consumer.
app.setName('Backspace');

// One-time migration from the historical scoped path. After the move the old
// folder is gone, so subsequent launches hit the old-missing no-op branch.
{
  const appDataDir = app.getPath('appData');
  const oldParent = path.join(appDataDir, '@backspace');
  const result = migrateUserData({
    oldDir: path.join(oldParent, 'desktop'),
    newDir: path.join(appDataDir, 'Backspace'),
    oldParent,
  });
  if (result.kind === 'migrated') {
    console.log(`[userData] migrated ${result.from} → ${result.to}`);
  } else if (result.kind === 'failed') {
    console.error('[userData] migration failed:', result.error);
  }
}

let mainWindow: BrowserWindow | null = null;
const keybindManager = new KeybindManager();
let tray: Tray | null = null;
let isQuitting = false;
let pendingDeepLink: string | null = null;

const knownInstanceOrigins = new Set<string>();
const desktopUpdater = new DesktopUpdater({ getWindow: () => mainWindow, showNotification });

// ─── AGPL-3.0 § 13 source offer ─────────────────────────────────────────────
// Upstream fallback for the "Source code" menu items and the About panel.
// Used when the connected instance can't be reached or advertises no source URL.
const UPSTREAM_SOURCE_URL = 'https://github.com/TheZwiss/backspace';

/**
 * Resolve the Corresponding Source URL for the instance the desktop app is
 * pointed at, honouring an operator's modified fork via GET /api/instance/info.
 * Falls back to the upstream repo when no instance is loaded or the probe fails.
 */
async function resolveSourceUrl(): Promise<string> {
  let base: string | null = process.env.BACKSPACE_URL ?? loadInstanceUrl();
  if (!base && mainWindow && !mainWindow.isDestroyed()) {
    const current = mainWindow.webContents.getURL();
    if (current.startsWith('http://') || current.startsWith('https://')) base = current;
  }
  if (!base) return UPSTREAM_SOURCE_URL;

  try {
    const origin = new URL(base).origin;
    const res = await fetch(`${origin}/api/instance/info`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return UPSTREAM_SOURCE_URL;
    const info = (await res.json()) as { sourceCodeUrl?: unknown };
    if (typeof info.sourceCodeUrl === 'string' && /^https?:\/\//i.test(info.sourceCodeUrl)) {
      return info.sourceCodeUrl;
    }
  } catch {
    // Unreachable / malformed — fall back to upstream.
  }
  return UPSTREAM_SOURCE_URL;
}

/** Open the resolved source URL externally; upstream fallback on any failure. */
function openSourceCode(): void {
  resolveSourceUrl()
    .then((url) => shell.openExternal(url))
    .catch(() => { void shell.openExternal(UPSTREAM_SOURCE_URL); });
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
      mainWindow.loadFile(getPickerPath(), { query: { lang: getDesktopLanguage() } });
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
    // Clear recovery state so macOS dock-activate (which calls createWindow again)
    // gets a clean slate. Without this, the new window inherits inRecoveryMode=true
    // and the recovery surface is silently lost.
    recoveryStore.markRecoveryExited();
    recoveryStore.update({ mode: 'normal', reason: null });
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

  // Deny foreign top-level navigations. See navigationPolicy.ts for the
  // mechanism note on why this is safe for the initial instance load, the
  // file:// picker, and cross-instance switching (none of them are
  // `will-navigate` events). setWindowOpenHandler above is unaffected — this
  // only covers same-window top-level navigation, not new-window/tab opens.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isNavigationAllowed({
      targetUrl: url,
      currentUrl: mainWindow?.webContents.getURL() ?? null,
      pickerFileUrl: pathToFileURL(getPickerPath()).href,
      knownInstanceOrigins,
    });
    if (!allowed) {
      console.warn(`[main] Blocked will-navigate to disallowed target: ${url}`);
      event.preventDefault();
    }
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

/**
 * Every shown notification stays referenced until it is clicked, closed or
 * fails. Without it the object can be garbage-collected while the toast is
 * still up, and on Windows the click is then dropped (#394).
 */
const shownNotifications = new NotificationRetainer<Notification>();

function showNotification(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', onClick ?? (() => {
    mainWindow?.show();
    mainWindow?.focus();
  }));
  notification.on('failed', (_event, error) => {
    console.warn('[notifications] a notification could not be shown:', error);
  });
  shownNotifications.retain(notification);
  notification.show();
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Screen share sources
// ---------------------------------------------------------------------------

interface SerializedScreenSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
  isScreen: boolean;
}

let pendingScreenSelection: PendingScreenSelection | null = null;
/** Loopback preference for system-picker captures (no preselection carries it there). */
let lastSystemPickerShareAudio: boolean | null = null;
/** Last enumeration, so a preselected id resolves to its DesktopCapturerSource without a second scan. */
let lastScreenSources: Electron.DesktopCapturerSource[] = [];
/** Last list handed to the renderer, and when: what a throttled or unfocused caller gets back. */
let lastServedScreenSources: SerializedScreenSource[] = [];
let lastScreenEnumerationAt: number | null = null;

async function enumerateScreenSources(): Promise<Electron.DesktopCapturerSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  lastScreenSources = sources;
  return sources;
}

function serializeScreenSources(sources: Electron.DesktopCapturerSource[]): SerializedScreenSource[] {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnailDataUrl: source.thumbnail.toDataURL(),
    appIconDataUrl: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
    isScreen: source.id.startsWith('screen:'),
  }));
}

function currentPickerMode(): ScreenSharePickerMode {
  return screenSharePickerMode(process.platform, process.env);
}

/** One-shot: returns and clears the pending preselection, or null when absent or stale. */
function takePendingScreenSelection(): PendingScreenSelection | null {
  const pending = pendingScreenSelection;
  pendingScreenSelection = null;
  return isPendingSelectionFresh(pending, Date.now()) ? pending : null;
}

function registerIpcHandlers(): void {
  registerTranslationIpc({ getWindow: () => mainWindow, getInstanceUrl: () => process.env.BACKSPACE_URL ?? loadInstanceUrl() });
  ipcMain.on('show-notification', (event, data: { title: string; body: string; options?: { channelId?: string; spaceId?: string; userId?: string } }) => {
    if (event.sender !== mainWindow?.webContents) return;
    const sender = event.sender;
    const origin = new URL(sender.getURL()).origin;
    showNotification(data.title, data.body, () => {
      if (!mainWindow || mainWindow.isDestroyed() || sender.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      // A toast from a previous home instance must not open IDs on the new one.
      if (sender === mainWindow.webContents && new URL(sender.getURL()).origin === origin && data.options) {
        sender.send('notification-click', data.options);
      }
    });
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
      mainWindow.loadFile(getPickerPath(), { query: { lang: getDesktopLanguage() } });
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

  desktopUpdater.registerIpc();

  ipcMain.handle('get-app-version', () => app.getVersion());

  // Screen share picker coordination (used by setDisplayMediaRequestHandler)
  ipcMain.on('screen-share-selected', () => {
    // Handled via ipcMain.once in the display media handler — this is just
    // a safety net to prevent unhandled-message warnings
  });
  // Setup-screen flow: the renderer lists sources up front, and preselects one
  // right before it calls getDisplayMedia(); the handler answers from that.
  // Thumbnails of every open window are pixel data, and the renderer runs the
  // instance's web client — remote code. `screenEnumerationDecision` states the
  // policy: the app's own window only, focused only, and no faster than the
  // cache window, so a page polling on a timer cannot quietly photograph
  // whatever the user switched to.
  ipcMain.handle('get-screen-sources', async (event): Promise<SerializedScreenSource[]> => {
    const decision = screenEnumerationDecision({
      fromMainWindow: event.sender === mainWindow?.webContents,
      windowFocused: mainWindow?.isFocused() ?? false,
      lastEnumeratedAt: lastScreenEnumerationAt,
      now: Date.now(),
    });
    if (decision === 'deny') return [];
    if (decision === 'serve-cache') return lastServedScreenSources;
    lastServedScreenSources = serializeScreenSources(await enumerateScreenSources());
    lastScreenEnumerationAt = Date.now();
    return lastServedScreenSources;
  });
  ipcMain.handle('get-screen-share-picker-mode', (event) => {
    if (event.sender !== mainWindow?.webContents) return 'app';
    return currentPickerMode();
  });
  // Whether System Audio on this OS build carries Backspace's own playback
  // (the call) to viewers; the stream settings say so before it is turned on.
  ipcMain.handle('get-system-audio-capability', (event) => {
    if (event.sender !== mainWindow?.webContents) return 'unknown';
    return ownAudioInSystemAudio(process.platform, process.getSystemVersion());
  });
  // handle, not on: the renderer awaits this before calling getDisplayMedia(),
  // so the selection is guaranteed to be armed when the display-media handler
  // runs. Fire-and-forget left the two unordered — the handler could win, fall
  // back to the prompted flow, and leave this armed to hijack the next share.
  ipcMain.handle('screen-share-preselect', (event, sourceId: string, shareAudio?: boolean) => {
    if (event.sender !== mainWindow?.webContents) return;
    if (typeof sourceId !== 'string' || !sourceId) return;
    pendingScreenSelection = { sourceId, shareAudio: shareAudio === true, at: Date.now() };
  });
  // System-picker sessions have no tile to preselect; the renderer only tells
  // us whether loopback audio should ride along with whatever the portal returns.
  ipcMain.on('screen-share-audio-preference', (event, shareAudio?: boolean) => {
    if (event.sender !== mainWindow?.webContents) return;
    lastSystemPickerShareAudio = shareAudio === true;
  });

  // Auto-launch settings
  ipcMain.handle('get-auto-launch-settings', (): { openAtLogin: boolean; startMinimized: boolean } => {
    if (isSandboxed()) {
      return { openAtLogin: false, startMinimized: false };
    }

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
    if (isSandboxed()) {
      return { openAtLogin: false, startMinimized: false };
    }

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
  ipcMain.handle('keybinds-sync', (_event, keybinds) => {
    keybindManager.updateKeybinds(keybinds);
    return keybindManager.isHookRunning();
  });
  ipcMain.handle('keybind-portal-status', () => {
    keybindManager.refreshPortal();
    return keybindManager.getPortalStatus();
  });
  ipcMain.on('keybind-portal-retry', () => keybindManager.retryPortal());

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
    // Development runs inside the stock Electron.app bundle, whose Dock icon
    // macOS caches per bundle, so the copied icns in the dev script does not
    // show. Set it at runtime; packaged builds carry the icon in their own
    // bundle and skip this.
    if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
      app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
    }

    // Win/Linux: frameless window has no menu bar, but we still need an
    // application menu so keyboard accelerators (Ctrl+C/V/X/Z/A) work.
    // The macOS app menu is owned by the recoveryStore subscriber below
    // (so it can re-render with current update/recovery state). Rebuilt on a
    // language change, hence a function rather than a one-off.
    const applyEditOnlyMenu = (): void => {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
          label: translateDesktop(getDesktopLanguage(), 'menu.edit'),
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
    };
    if (process.platform !== 'darwin') {
      applyEditOnlyMenu();
    }

    // Purge ALL stale caches so Electron always loads fresh code on launch
    await session.defaultSession.clearStorageData({ storages: ['serviceworkers'] });
    await session.defaultSession.clearCache();

    // Intercept getDisplayMedia(). Two ways to answer it:
    //   1. Preselected (current web client): ScreenShareSetup listed the
    //      sources via get-screen-sources, the user picked a tile, and the
    //      renderer awaited screen-share-preselect before calling
    //      getDisplayMedia(). Answer immediately, no prompt.
    //   2. Prompted (older web clients, or nothing preselected): push the
    //      sources to the renderer and wait for screen-share-selected.
    // Audio loopback controlled by user's shareAudio toggle.
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      console.log('[Main:ScreenShare] Handler invoked');
      try {
        const pending = takePendingScreenSelection();
        if (pending) {
          let selected = lastScreenSources.find((s) => s.id === pending.sourceId);
          if (!selected) selected = (await enumerateScreenSources()).find((s) => s.id === pending.sourceId);
          if (!selected) {
            console.warn('[Main:ScreenShare] Preselected source vanished:', pending.sourceId);
            // @ts-ignore — deny the request without crashing
            callback();
            return;
          }
          console.log('[Main:ScreenShare] Using preselected source:', pending.sourceId, 'audio:', pending.shareAudio);
          callback({ video: selected, ...(pending.shareAudio ? { audio: 'loopback' } : {}) });
          return;
        }

        const sources = await enumerateScreenSources();
        console.log('[Main:ScreenShare] Got', sources.length, 'sources');

        if (sources.length === 0) {
          console.warn('[Main:ScreenShare] No sources — Screen Recording permission may not be granted, or the system picker was cancelled');
          // @ts-ignore — Electron throws if we pass {} when video was requested; pass nothing to deny
          callback();
          return;
        }

        // System picker (Wayland portal): the user already chose in the
        // portal dialog and this is the only source it returned. Answer
        // directly instead of showing a one-tile grid.
        if (currentPickerMode() === 'system' && sources.length === 1) {
          // Default off: this branch answers without consulting the renderer, so
          // a web client too old to send a preference must not have its audio
          // captured against the setting it thinks is in force.
          const shareAudio = lastSystemPickerShareAudio ?? false;
          console.log('[Main:ScreenShare] System picker returned one source:', sources[0]!.id, 'audio:', shareAudio);
          callback({ video: sources[0]!, ...(shareAudio ? { audio: 'loopback' } : {}) });
          return;
        }

        // Send sources to renderer, wait for user selection
        mainWindow?.webContents.send('screen-share-sources', serializeScreenSources(sources));

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
        //   - Windows: WASAPI loopback. Backspace's own
        //     playback is left out only on Windows 11, where Chromium honours
        //     the renderer's restrictOwnAudio (see systemAudioCapability.ts);
        //     on Windows 10 the whole mix, this call included, is captured.
        //   - macOS 13+: ScreenCaptureKit, or CoreAudio Tap from 14.2, which
        //     also leaves Backspace out; requires NSAudioCaptureUsageDescription
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
      } finally {
        // The caches exist only to serve one setup flow: the NativeImage list to
        // resolve a preselected id within this request, the serialized one to
        // answer a repeat call without a second scan. Both pin a thumbnail per
        // open window, so drop them as soon as the request is answered.
        lastScreenSources = [];
        lastServedScreenSources = [];
        lastScreenEnumerationAt = null;
      }
    });

    registerIpcHandlers();
    // Wire the recovery module's quit callback to the local requestQuit BEFORE
    // createWindow so a synchronous did-fail-load on first load finds a wired
    // Quit handler. requestQuit is a function declaration and is hoisted.
    setOnQuitRequested(() => requestQuit());
    createWindow();
    createTray();

    // AGPL-3.0 § 13: native About panel advertises the version + source repo.
    app.setAboutPanelOptions({
      applicationName: 'Backspace',
      applicationVersion: app.getVersion(),
      copyright: `AGPL-3.0-only · Source: ${UPSTREAM_SOURCE_URL}`,
      website: UPSTREAM_SOURCE_URL,
    });

    // Tray + macOS app-menu actions. Defined once so the subscriber and the
    // initial-fire share one implementation (no drift on future menu changes).
    const trayActions = {
      onShow: () => { mainWindow?.show(); mainWindow?.focus(); },
      onHide: () => mainWindow?.hide(),
      // Delegate to handleRecoveryAction so both the tray and the recovery
      // surface share one implementation path (avoids drift and ensures
      // recovery state is always cleared on a Change Instance action).
      onChangeInstance: () => handleRecoveryAction('change-instance'),
      onCheckForUpdates: () => handleRecoveryAction('check-update'),
      onRestartToInstall: () => handleRecoveryAction('install-update'),
      onOpenReleases: () => handleRecoveryAction('open-releases'),
      onOpenSource: () => openSourceCode(),
      onQuit: () => requestQuit(),
    };

    const applyMenusForState = (state: RecoveryState): void => {
      const language = getDesktopLanguage();
      if (tray) {
        tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(state, trayActions, language)));
      }
      if (process.platform === 'darwin') {
        Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(app.name, state, trayActions, language)));
      }
      // Mode-gated push to renderer (recovery.html subscribes to this).
      if (state.mode === 'recovery' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recovery-state-changed', state);
      }
    };

    recoveryStore.subscribe(applyMenusForState);
    applyMenusForState(recoveryStore.get());  // initial fire — subscribers don't auto-fire on subscribe

    // The renderer owns the language choice (settings → Language). Remember
    // it so the tray is right from the first paint next launch, and relabel
    // everything main draws right now.
    ipcMain.on('set-language', (_event, language: unknown) => {
      if (!isDesktopLanguage(language)) return;
      try {
        saveStoredLanguage(language);
      } catch (err) {
        console.warn('[main] Failed to persist language:', err);
      }
      if (process.platform !== 'darwin') applyEditOnlyMenu();
      applyMenusForState(recoveryStore.get());
    });

    desktopUpdater.initAutoUpdater();

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
