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
} from 'electron';
import path from 'path';
import fs from 'fs';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let pendingDeepLink: string | null = null;

const DEV_URL = 'http://localhost:5173';
const PROD_URL = 'http://localhost:3000';
const SERVER_URL = process.env.BACKSPACE_URL || (app.isPackaged ? PROD_URL : DEV_URL);

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
        canvas[idx] = 0x58;     // R (blurple)
        canvas[idx + 1] = 0x65; // G
        canvas[idx + 2] = 0xf2; // B
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
  const iconPath = path.join(__dirname, '..', 'build', 'tray-icon.png');
  try {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      const resized = icon.resize({ width: 16, height: 16 });
      if (process.platform === 'darwin') {
        resized.setTemplateImage(true);
      }
      return resized;
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
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#313338',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.loadURL(SERVER_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();

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
    mainWindow = null;
  });

  // Window focus IPC for notification suppression
  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('window-focus-changed', true);
  });
  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window-focus-changed', false);
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

function createTray(): void {
  const icon = loadTrayIcon();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Backspace',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Hide',
      click: () => {
        mainWindow?.hide();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Backspace');
  tray.setContextMenu(contextMenu);

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

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title,
      body,
      silent: false,
    });

    notification.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
    });

    notification.show();
  }
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
}

// ─── Auto-Update ────────────────────────────────────────────────────────────

function initAutoUpdater(): void {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info: { version: string }) => {
      mainWindow?.webContents.send('update-available', { version: info.version });
    });

    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      mainWindow?.webContents.send('update-downloaded', { version: info.version });
    });

    autoUpdater.on('error', (err: Error) => {
      mainWindow?.webContents.send('update-error', err.message);
    });

    // Initial check with 10s delay
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 10_000);

    // Periodic check every 4 hours
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);
  } catch {
    // Graceful degradation — no update URL configured or electron-updater not available
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

  app.whenReady().then(() => {
    registerIpcHandlers();
    createWindow();
    createTray();
    initAutoUpdater();

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
  });
}
