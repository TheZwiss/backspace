/** Type augmentation for the Electron IPC bridge exposed by preload.ts */

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
  onUpdateError: (callback: (error: string) => void) => void;
  installUpdate: () => void;
  checkForUpdates: () => void;

  // Window focus (Task 2.2)
  onWindowFocusChange: (callback: (focused: boolean) => void) => void;

  // Deep linking (Task 2.3)
  onDeepLink: (callback: (url: string) => void) => void;

  // Instance URL management
  getInstanceUrl: () => Promise<string | null>;
  setInstanceUrl: (url: string) => Promise<void>;
  clearInstanceUrl: () => Promise<void>;
}

interface Window {
  backspace?: BackspaceElectronAPI;
}
