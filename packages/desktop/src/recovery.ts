import { app, shell } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import type { AppUpdater } from 'electron-updater';
import path from 'path';
import { loadInstanceUrl, clearInstanceUrl, getPickerPath } from './instanceUrl';

export type RecoveryReasonCode =
  | 'load-failed'
  | 'render-gone'
  | 'unresponsive'
  | 'renderer-stalled';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface RecoveryState {
  mode: 'normal' | 'recovery';
  reason: { code: RecoveryReasonCode; detail: string } | null;
  updateState: UpdateState;
  updateVersion: string | null;
  lastUpdateError: { message: string; code: string | null; at: number } | null;
  lastCheckResult: 'up-to-date' | 'failed' | null;
}

const INITIAL_STATE: RecoveryState = {
  mode: 'normal',
  reason: null,
  updateState: 'idle',
  updateVersion: null,
  lastUpdateError: null,
  lastCheckResult: null,
};

export class RecoveryStateStore {
  // Freeze so the initial get() return cannot be mutated by callers.
  private state: RecoveryState = Object.freeze({ ...INITIAL_STATE }) as RecoveryState;
  private listeners = new Set<(s: RecoveryState) => void>();
  private inRecoveryMode = false;

  get(): Readonly<RecoveryState> {
    return this.state;
  }

  update(partial: Partial<RecoveryState>): void {
    // Freeze so consumers (incl. subscribers, IPC-cloned renderer reads via
    // get-recovery-state) cannot mutate the shared state through the live
    // reference returned by get(). Compile-time Readonly<> is a hint only.
    this.state = Object.freeze({ ...this.state, ...partial }) as RecoveryState;
    // Snapshot before iterating: a listener can subscribe/unsubscribe others
    // (or itself) during notification without affecting the current notify pass.
    const snapshot = Array.from(this.listeners);
    for (const cb of snapshot) {
      try {
        cb(this.state);
      } catch (err) {
        console.error('[recovery] listener threw:', err);
      }
    }
  }

  subscribe(cb: (s: RecoveryState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  isInRecoveryMode(): boolean {
    return this.inRecoveryMode;
  }

  markRecoveryEntered(): void {
    this.inRecoveryMode = true;
  }

  markRecoveryExited(): void {
    this.inRecoveryMode = false;
  }
}

export const recoveryStore = new RecoveryStateStore();

export function extractErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

interface MenuActions {
  onShow: () => void;
  onHide: () => void;
  onChangeInstance: () => void;
  onCheckForUpdates: () => void;
  onRestartToInstall: () => void;
  onQuit: () => void;
}

function checkForUpdatesItem(state: RecoveryState, click: () => void): MenuItemConstructorOptions {
  switch (state.updateState) {
    case 'checking':
      return { id: 'check-for-updates', label: 'Checking for Updates…', enabled: false };
    case 'downloading':
      return { id: 'check-for-updates', label: 'Downloading Update…', enabled: false };
    case 'downloaded':
      return { id: 'check-for-updates', label: 'Update Ready', enabled: false };
    case 'error':
      return { id: 'check-for-updates', label: 'Check for Updates… (last attempt failed)', enabled: true, click };
    case 'idle':
    default:
      return { id: 'check-for-updates', label: 'Check for Updates…', enabled: true, click };
  }
}

export function buildTrayMenuTemplate(
  state: RecoveryState,
  actions?: Partial<MenuActions>,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: 'Show Backspace', click: actions?.onShow },
    { label: 'Hide', click: actions?.onHide },
    { type: 'separator' },
    checkForUpdatesItem(state, () => actions?.onCheckForUpdates?.()),
  ];

  if (state.updateState === 'downloaded') {
    items.push({
      id: 'restart-to-install',
      label: 'Restart to Install Update',
      enabled: true,
      click: actions?.onRestartToInstall,
    });
  }

  items.push(
    { type: 'separator' },
    { label: 'Change Instance', click: actions?.onChangeInstance },
    { type: 'separator' },
    { label: 'Quit', click: actions?.onQuit },
  );

  return items;
}

export function buildAppMenuTemplate(
  appName: string,
  state: RecoveryState,
  actions?: Partial<MenuActions>,
): MenuItemConstructorOptions[] {
  const appSubmenu: MenuItemConstructorOptions[] = [
    { role: 'about' },
    { type: 'separator' },
    checkForUpdatesItem(state, () => actions?.onCheckForUpdates?.()),
  ];

  if (state.updateState === 'downloaded') {
    appSubmenu.push({
      id: 'restart-to-install',
      label: 'Restart to Install Update',
      enabled: true,
      click: actions?.onRestartToInstall,
    });
  }

  appSubmenu.push(
    { type: 'separator' },
    { label: 'Change Instance', click: actions?.onChangeInstance },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' },
  );

  return [
    { label: appName, submenu: appSubmenu },
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
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Boot-completion timer
// ---------------------------------------------------------------------------
// Arms when the renderer navigates to an http(s) URL in a packaged build.
// If the renderer does not call rendererReady() within BOOT_TIMEOUT_MS, the
// onBootStallCallback fires and main.ts triggers recovery mode.
// ---------------------------------------------------------------------------

const BOOT_TIMEOUT_MS = 20_000;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let bootArmed = false;
let onBootStallCallback: (() => void) | null = null;

/**
 * Register the callback fired when the boot timer expires.
 * Wired by main.ts to call enterRecoveryMode({ code: 'renderer-stalled', ... }).
 * Kept as a setter to avoid a forward-reference cycle: the setter shape mirrors
 * setMainWindow/setAutoUpdater and keeps the timer logic independently testable.
 */
export function setOnBootStall(cb: (() => void) | null): void {
  onBootStallCallback = cb;
}

/**
 * Arm the boot-completion timer for the given window.
 * Only arms in packaged builds (no-ops in dev) and only for http(s):// URLs
 * (so file:// picker/recovery pages do not trip the timer).
 */
export function armBootTimer(win: BrowserWindow): void {
  if (!app.isPackaged) return;
  const url = win.webContents.getURL();
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;
  clearBootTimer();
  bootArmed = true;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    if (!bootArmed) return;
    bootArmed = false;
    onBootStallCallback?.();
  }, BOOT_TIMEOUT_MS);
}

/** Disarm and clear the boot timer. Called on renderer-ready or window destroy. */
export function clearBootTimer(): void {
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
  bootArmed = false;
}

/** Returns true while the boot timer is armed and waiting for renderer-ready. */
export function isBootArmed(): boolean {
  return bootArmed;
}

/**
 * Called from the renderer-ready IPC handler.
 * Disarms the boot timer — the renderer booted successfully.
 */
export function handleRendererReady(): void {
  if (bootArmed) clearBootTimer();
}

// ---------------------------------------------------------------------------
// Reference setters
// ---------------------------------------------------------------------------
// recovery.ts holds its own refs to the live Electron objects it needs.
// Setters are used instead of direct imports to keep recovery.ts free of
// circular dependencies on main.ts.
// ---------------------------------------------------------------------------

let mainWindowRef: BrowserWindow | null = null;
let autoUpdaterRef: AppUpdater | null = null;
let onQuitRequestedCallback: (() => void) | null = null;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win;
}

export function setAutoUpdater(au: AppUpdater | null): void {
  autoUpdaterRef = au;
}

/**
 * Wired by main.ts to call its own requestQuit() (which sets isQuitting + app.quit()).
 * Kept as a callback so recovery.ts doesn't import from main.ts (would create a cycle).
 */
export function setOnQuitRequested(cb: (() => void) | null): void {
  onQuitRequestedCallback = cb;
}

// ---------------------------------------------------------------------------
// Recovery mode entry
// ---------------------------------------------------------------------------

export function enterRecoveryMode(reason: { code: RecoveryReasonCode; detail: string }): void {
  recoveryStore.update({ mode: 'recovery', reason });

  if (recoveryStore.isInRecoveryMode()) {
    // Already in recovery — state.reason updated for display, no re-navigation.
    // Loop prevention: if recovery.html itself fails to load, this guard keeps
    // us from infinite re-loading. User-visible outcome is contained failure
    // (blank window, escape via tray Quit) — acceptable because a corrupt
    // recovery.html means a corrupt build.
    return;
  }
  recoveryStore.markRecoveryEntered();

  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;

  mainWindowRef.loadFile(path.join(__dirname, '..', 'resources', 'recovery.html'));
  // Force-show even when launched hidden (--hidden via autostart) — recovery
  // must be visible regardless of prior visibility state.
  mainWindowRef.show();
  mainWindowRef.focus();
}

// Wire the boot-stall callback at module load time. The setter pattern from
// Task 6 exists to avoid a forward reference (armBootTimer is defined before
// enterRecoveryMode and tests target it in isolation).
setOnBootStall(() => {
  enterRecoveryMode({
    code: 'renderer-stalled',
    detail: `no rendererReady within 20000ms`,
  });
});

// ---------------------------------------------------------------------------
// Recovery action funnel
// ---------------------------------------------------------------------------

export type RecoveryAction =
  | 'reload'
  | 'check-update'
  | 'install-update'
  | 'change-instance'
  | 'open-releases'
  | 'quit';

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  'reload',
  'check-update',
  'install-update',
  'change-instance',
  'open-releases',
  'quit',
]);

export function isValidRecoveryAction(action: unknown): action is RecoveryAction {
  return typeof action === 'string' && VALID_ACTIONS.has(action);
}

export function handleRecoveryAction(action: RecoveryAction): void {
  switch (action) {
    case 'reload': {
      const url = loadInstanceUrl();
      // Optimistic exit — clear recovery state BEFORE loading. If the load
      // fails, did-fail-load re-enters recovery. If it stalls, boot timer fires.
      recoveryStore.markRecoveryExited();
      recoveryStore.update({ mode: 'normal', reason: null });
      if (!url) {
        mainWindowRef?.loadFile(getPickerPath());
        return;
      }
      mainWindowRef?.loadURL(url);
      return;
    }
    case 'check-update': {
      recoveryStore.update({ updateState: 'checking', lastCheckResult: null });
      autoUpdaterRef?.checkForUpdates().catch(() => { /* check-phase errors stay silent */ });
      return;
    }
    case 'install-update': {
      // Defense in depth: only act when an update is actually downloaded. The
      // recovery.html UI hides the Restart button unless updateState='downloaded',
      // but a buggy/malicious renderer could send this action at any time.
      if (recoveryStore.get().updateState !== 'downloaded') return;
      // Direct quitAndInstall — does NOT rely on autoInstallOnAppQuit.
      // Force-kill-fix: if user reaches recovery and clicks here, install
      // happens cleanly even if the on-quit hook would otherwise be bypassed.
      autoUpdaterRef?.quitAndInstall();
      return;
    }
    case 'change-instance': {
      clearInstanceUrl();
      recoveryStore.markRecoveryExited();
      recoveryStore.update({ mode: 'normal', reason: null });
      mainWindowRef?.loadFile(getPickerPath());
      // Ensure visible — tray clicks may happen with window hidden, and the
      // recovery surface should also remain visible during the navigation.
      // When invoked from recovery.html (window already showing), these are
      // idempotent no-ops.
      mainWindowRef?.show();
      mainWindowRef?.focus();
      return;
    }
    case 'open-releases': {
      shell.openExternal('https://github.com/TheZwiss/backspace/releases/latest');
      return;
    }
    case 'quit': {
      onQuitRequestedCallback?.();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// webContents event handlers
// ---------------------------------------------------------------------------
// Attaches Electron BrowserWindow event listeners that feed into recovery mode.
// All closure-local state (pendingArm, unresponsiveTimer) is scoped to the
// function call so each window attachment gets its own independent instance.
// ---------------------------------------------------------------------------

const UNRESPONSIVE_GRACE_MS = 10_000;

export function attachRecoveryHandlers(win: BrowserWindow): void {
  let pendingArm = false;
  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;

  // did-navigate fires only for top-level non-same-document navigation.
  // SPA in-page routing (history.pushState, hash) fires did-navigate-in-page,
  // which we deliberately ignore — keeps the boot timer from misfiring on
  // every channel switch.
  win.webContents.on('did-navigate', () => {
    clearBootTimer();
    pendingArm = true;
  });

  win.webContents.on('did-finish-load', () => {
    if (pendingArm) {
      pendingArm = false;
      armBootTimer(win);
    }
  });

  win.webContents.on('did-fail-load',
    (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;       // ignore sub-resource failures (favicon, broken <img>)
      if (errorCode === -3) return;   // ERR_ABORTED — intentional nav interruption
      enterRecoveryMode({
        code: 'load-failed',
        detail: `${errorCode} ${errorDescription} @ ${validatedURL}`,
      });
    });

  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;  // normal quit, ignore
    enterRecoveryMode({
      code: 'render-gone',
      detail: details.reason,  // crashed | killed | oom | launch-failed | integrity-failure
    });
  });

  // unresponsive grace period — Chrome's own pattern. Renderers often recover
  // from a long sync op or GC pause within seconds; only enter recovery if
  // the renderer stays stuck for the full grace window.
  win.webContents.on('unresponsive', () => {
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      enterRecoveryMode({ code: 'unresponsive', detail: `main thread blocked >${UNRESPONSIVE_GRACE_MS}ms` });
    }, UNRESPONSIVE_GRACE_MS);
  });

  win.webContents.on('responsive', () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
  });
}
