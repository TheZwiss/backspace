import { app } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

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
  private state: RecoveryState = Object.freeze({ ...INITIAL_STATE }) as RecoveryState;
  private listeners = new Set<(s: RecoveryState) => void>();
  private inRecoveryMode = false;

  get(): Readonly<RecoveryState> {
    return this.state;
  }

  update(partial: Partial<RecoveryState>): void {
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
