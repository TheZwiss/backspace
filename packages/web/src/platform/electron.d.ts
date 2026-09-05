/** Type augmentation for the Electron IPC bridge exposed by preload.ts */

// Recovery mode types (Task 11)
type RecoveryReasonCode = 'load-failed' | 'render-gone' | 'unresponsive' | 'renderer-stalled';
// 'available-manual': an update exists but this build cannot install it in
// place, so the recovery surface offers a download rather than a Restart button
// that would do nothing. See packages/desktop/src/updateCapability.ts.
type UpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'available-manual'
  | 'external'
  | 'downloaded'
  | 'error';
interface RecoveryState {
  mode: 'normal' | 'recovery';
  reason: { code: RecoveryReasonCode; detail: string } | null;
  updateState: UpdateState;
  updateVersion: string | null;
  lastUpdateError: { message: string; code: string | null; at: number } | null;
  lastCheckResult: 'up-to-date' | 'failed' | null;
}
type RecoveryAction =
  | 'reload'
  | 'check-update'
  | 'install-update'
  | 'change-instance'
  | 'open-releases'
  | 'quit';

interface ElectronScreenSource {
  id: string;                      // "screen:0:0" or "window:12345:0"
  name: string;                    // "Entire Screen" or "Firefox"
  thumbnailDataUrl: string;        // PNG data URL at 320×180
  appIconDataUrl: string | null;   // App icon (windows only)
  isScreen: boolean;               // true = display, false = window
}

/**
 * Where the desktop updater currently is.
 *
 * Declared without `export` on purpose: this file is a global ambient
 * declaration that augments `interface Window`. A single `export` would turn it
 * into a module and drop that augmentation across the whole package.
 *
 * Mirrors `UpdateStatus` in `packages/desktop/src/updateStatus.ts`. The two are
 * separate declarations on purpose: this is a wire contract across a process
 * boundary between two packages that ship and version independently, and the
 * web client must not take a build dependency on the Electron package. The
 * runtime guard in `updateStore.ts` is what keeps them honest.
 */
type DesktopUpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; version: string | null; message: string }
  | { phase: 'up-to-date'; checkedAt: number };

/**
 * `auto` means this build can install its own updates. `manual` means it cannot
 * and the user has to download a new build, which is the case for ad-hoc signed
 * macOS builds. The renderer never reasons about code signing; it reads this.
 */
type DesktopUpdateCapability = 'auto' | 'manual' | 'external';

interface DesktopUpdateSnapshot {
  capability: DesktopUpdateCapability;
  dismissedVersion: string | null;
  status: DesktopUpdateStatus;
}

interface BackspaceElectronAPI {
  // Platform info
  platform: NodeJS.Platform;
  // Window controls
  minimize: () => void;
  maximize: () => void;
  close: () => void;

  // Notifications & badge
  showNotification: (title: string, body: string, options?: import('./notifications').NotificationOptions) => void;
  onNotificationClick?: (callback: (options: import('./notifications').NotificationOptions) => void) => () => void;
  setBadgeCount: (count: number) => void;

  // Auto-update, legacy per-event channels.
  //
  // Kept because the desktop app and the instance it connects to version
  // independently. Unused by this client; the snapshot API below replaces them.
  onUpdateAvailable: (callback: (info: { version: string }) => void) => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => void;
  onUpdateError: (callback: (error: { message: string; releaseUrl: string }) => void) => void;
  installUpdate: () => void;
  checkForUpdates: () => void;
  getVersion: () => Promise<string>;

  // Auto-update, current surface.
  //
  // Optional because an older desktop app does not expose them. A client served
  // by a newer instance can find itself running inside an older app, so every
  // call site must feature-detect. See updateStore.ts.
  getUpdateStatus?: () => Promise<unknown>;
  isSandboxed?: () => Promise<boolean>;
  onUpdateStatusChanged?: (callback: (snapshot: unknown) => void) => (() => void);
  dismissUpdate?: (version: string) => void;
  openReleasePage?: () => void;

  // Window focus (Task 2.2)
  onWindowFocusChange: (callback: (focused: boolean) => void) => void;

  // Deep linking (Task 2.3)
  onDeepLink: (callback: (url: string) => void) => void;

  // Instance-origin-aware URL routing
  setConnectedOrigins: (origins: string[]) => void;
  onOpenInternalRoute: (callback: (path: string) => void) => (() => void);

  // Screen share picker coordination
  onScreenShareSources: (callback: (sources: ElectronScreenSource[]) => void) => void;
  selectScreenSource: (sourceId: string | null, shareAudio?: boolean) => void;

  // Instance URL management
  getInstanceUrl: () => Promise<string | null>;
  setInstanceUrl: (url: string) => Promise<void>;
  clearInstanceUrl: () => Promise<void>;

  // Language: the renderer owns the choice; main relabels its tray and menus.
  // Optional because an older desktop app does not expose it.
  setLanguage?: (language: string) => void;

  // Auto-launch settings
  getAutoLaunchSettings: () => Promise<{ openAtLogin: boolean; startMinimized: boolean }>;
  setAutoLaunchSettings: (settings: { openAtLogin?: boolean; startMinimized?: boolean }) =>
    Promise<{ openAtLogin: boolean; startMinimized: boolean }>;

  // Activity detection (game/app process scanning)
  onActivityDetected: (callback: (activity: unknown) => void) => (() => void);
  getCurrentActivity: () => Promise<unknown>;

  // Keybind support
  syncKeybinds: (keybinds: Array<{ actionId: string; keys: number[]; mouseButton?: number }>) => void;
  onKeybindAction: (callback: (action: { actionId: string; pressed: boolean }) => void) => (() => void);
  onAccessibilityStatus: (callback: (status: { trusted: boolean }) => void) => (() => void);
  onKeybindHookError: (callback: (error: { message: string }) => void) => (() => void);
  checkAccessibility: () => Promise<boolean>;

  // Recovery mode bridge (Task 11)
  rendererReady: () => void;
  getRecoveryState: () => Promise<RecoveryState>;
  onRecoveryStateChanged: (cb: (state: RecoveryState) => void) => () => void;
  recoveryAction: (action: RecoveryAction) => void;
}

interface Window {
  backspace?: BackspaceElectronAPI;
}
