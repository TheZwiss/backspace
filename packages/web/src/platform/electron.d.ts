/** Type augmentation for the Electron IPC bridge exposed by preload.ts */

// Recovery mode types (Task 11)
type RecoveryReasonCode = 'load-failed' | 'render-gone' | 'unresponsive' | 'renderer-stalled';
type UpdateState = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error';
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

interface BackspaceElectronAPI {
  // Platform info
  platform: NodeJS.Platform;

  // Window controls
  minimize: () => void;
  maximize: () => void;
  close: () => void;

  // Notifications & badge
  showNotification: (title: string, body: string) => void;
  setBadgeCount: (count: number) => void;

  // Auto-update (Task 2.1)
  onUpdateAvailable: (callback: (info: { version: string }) => void) => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => void;
  onUpdateError: (callback: (error: { message: string; releaseUrl: string }) => void) => void;
  installUpdate: () => void;
  checkForUpdates: () => void;
  getVersion: () => Promise<string>;

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
