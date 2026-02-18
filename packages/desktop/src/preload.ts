import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('opencord', {
  platform: process.platform,
  showNotification: (title: string, body: string) => {
    ipcRenderer.send('show-notification', { title, body });
  },
  setBadgeCount: (count: number) => {
    ipcRenderer.send('set-badge-count', count);
  },
  minimize: () => {
    ipcRenderer.send('minimize-window');
  },
  maximize: () => {
    ipcRenderer.send('maximize-window');
  },
  close: () => {
    ipcRenderer.send('close-window');
  },
});
