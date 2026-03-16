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
  onUpdateError: (callback: (error: string) => void) => {
    ipcRenderer.on('update-error', (_event, error) => callback(error));
  },
  installUpdate: () => {
    ipcRenderer.send('install-update');
  },
  checkForUpdates: () => {
    ipcRenderer.send('check-for-updates');
  },

  // Window focus
  onWindowFocusChange: (callback: (focused: boolean) => void) => {
    ipcRenderer.on('window-focus-changed', (_event, focused) => callback(focused));
  },

  // Deep linking
  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on('deep-link', (_event, url) => callback(url));
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
});
