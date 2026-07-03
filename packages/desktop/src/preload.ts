import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('backspace', {
  // Platform info
  platform: process.platform,

  // Window controls
  minimize: () => {
    ipcRenderer.send('minimize-window');
  },
  maximize: () => {
    ipcRenderer.send('maximize-window');
  },
  close: () => {
    ipcRenderer.send('close-window');
  },

  // Notifications & badge
  showNotification: (title: string, body: string) => {
    ipcRenderer.send('show-notification', { title, body });
  },
  setBadgeCount: (count: number) => {
    ipcRenderer.send('set-badge-count', count);
  },

  // Auto-update
  onUpdateAvailable: (callback: (info: { version: string }) => void) => {
    ipcRenderer.on('update-available', (_event, info) => callback(info));
  },
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => {
    ipcRenderer.on('update-downloaded', (_event, info) => callback(info));
  },
  onUpdateError: (callback: (error: { message: string; releaseUrl: string }) => void) => {
    ipcRenderer.on('update-error', (_event, error) => callback(error));
  },
  installUpdate: () => {
    ipcRenderer.send('install-update');
  },
  checkForUpdates: () => {
    ipcRenderer.send('check-for-updates');
  },
  getVersion: () => ipcRenderer.invoke('get-app-version'),

  // Window focus
  onWindowFocusChange: (callback: (focused: boolean) => void) => {
    ipcRenderer.on('window-focus-changed', (_event, focused) => callback(focused));
  },

  // Deep linking
  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on('deep-link', (_event, url) => callback(url));
  },

  // Instance-origin-aware URL routing
  setConnectedOrigins: (origins: string[]) => {
    ipcRenderer.send('set-connected-origins', origins);
  },
  onOpenInternalRoute: (callback: (path: string) => void) => {
    const handler = (_evt: Electron.IpcRendererEvent, path: string) => callback(path);
    ipcRenderer.on('open-internal-route', handler);
    return () => { ipcRenderer.removeListener('open-internal-route', handler); };
  },

  // Screen share picker coordination
  onScreenShareSources: (callback: (sources: unknown[]) => void) => {
    ipcRenderer.on('screen-share-sources', (_event, sources) => callback(sources));
  },
  selectScreenSource: (sourceId: string | null, shareAudio?: boolean) => {
    ipcRenderer.send('screen-share-selected', sourceId, shareAudio ?? true);
  },

  // Instance URL management
  getInstanceUrl: () => ipcRenderer.invoke('get-instance-url'),
  setInstanceUrl: (url: string) => ipcRenderer.invoke('set-instance-url', url),
  clearInstanceUrl: () => ipcRenderer.invoke('clear-instance-url'),

  // Auto-launch settings
  getAutoLaunchSettings: () => ipcRenderer.invoke('get-auto-launch-settings'),
  setAutoLaunchSettings: (settings: { openAtLogin?: boolean; startMinimized?: boolean }) =>
    ipcRenderer.invoke('set-auto-launch-settings', settings),

  // Activity detection (game/app process scanning)
  onActivityDetected: (callback: (activity: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, activity: unknown) => callback(activity);
    ipcRenderer.on('activity-detected', handler);
    return () => { ipcRenderer.removeListener('activity-detected', handler); };
  },
  getCurrentActivity: () => ipcRenderer.invoke('get-current-activity'),

  // Keybind support
  syncKeybinds: (keybinds: Array<{ actionId: string; keys: number[]; mouseButton?: number }>) => {
    ipcRenderer.send('keybinds-sync', keybinds);
  },
  onKeybindAction: (callback: (action: { actionId: string; pressed: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: { actionId: string; pressed: boolean }) => callback(action);
    ipcRenderer.on('keybind-action', handler);
    return () => { ipcRenderer.removeListener('keybind-action', handler); };
  },
  onAccessibilityStatus: (callback: (status: { trusted: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: { trusted: boolean }) => callback(status);
    ipcRenderer.on('accessibility-status', handler);
    return () => { ipcRenderer.removeListener('accessibility-status', handler); };
  },
  onKeybindHookError: (callback: (error: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: { message: string }) => callback(error);
    ipcRenderer.on('keybind-hook-error', handler);
    return () => { ipcRenderer.removeListener('keybind-hook-error', handler); };
  },
  checkAccessibility: () => ipcRenderer.invoke('check-accessibility'),

  // Recovery mode bridge (Task 11)
  rendererReady: (): void => {
    ipcRenderer.send('renderer-ready');
  },

  getRecoveryState: (): Promise<unknown> => {
    return ipcRenderer.invoke('get-recovery-state');
  },

  onRecoveryStateChanged: (cb: (state: unknown) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: unknown) => cb(state);
    ipcRenderer.on('recovery-state-changed', handler);
    return () => { ipcRenderer.removeListener('recovery-state-changed', handler); };
  },

  recoveryAction: (action: string): void => {
    ipcRenderer.send('recovery-action', action);
  },
});
