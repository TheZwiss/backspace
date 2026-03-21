/** Type augmentation for the Electron IPC bridge exposed by preload.ts */

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
}

interface Window {
  backspace?: BackspaceElectronAPI;
}
