/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('backspace', {
  getTextVoiceStatus: () => ipcRenderer.invoke('local-text-voice-status'),
  prepareTextVoice: (device: 'auto' | 'cpu' | 'gpu') => ipcRenderer.invoke('local-text-voice-prepare', device),
  synthesizeTextVoice: (text: string, voice: string, speed: number) => ipcRenderer.invoke('local-text-voice-speech', { text, voice, speed }),
  releaseTextVoice: () => ipcRenderer.invoke('local-text-voice-release'),
  onTextVoiceStatus: (callback: (status: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on('local-text-voice-status', handler);
    return () => ipcRenderer.removeListener('local-text-voice-status', handler);
  },
  // Platform info
  platform: process.platform,
  // Window controls
  controlCallWindow: (action: 'minimize' | 'maximize' | 'close') => {
    ipcRenderer.send('call-window-control', action);
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

  // Notifications & badge
  showNotification: (title: string, body: string, options?: { channelId?: string; spaceId?: string; userId?: string }) => {
    ipcRenderer.send('show-notification', { title, body, options });
  },
  onNotificationClick: (callback: (options: { channelId?: string; spaceId?: string; userId?: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, options: { channelId?: string; spaceId?: string; userId?: string }) => callback(options);
    ipcRenderer.on('notification-click', handler);
    return () => { ipcRenderer.removeListener('notification-click', handler); };
  },
  setBadgeCount: (count: number) => {
    ipcRenderer.send('set-badge-count', count);
  },

  // Auto-update, legacy per-event channels.
  //
  // Superseded by getUpdateStatus/onUpdateStatusChanged below and unused by the
  // current web client, but deliberately kept. The desktop app and the instance
  // it connects to version independently: a newer app can be pointed at an older
  // instance that still serves a client calling these. Removing them would make
  // that client throw inside a useEffect and take the whole renderer down.
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

  // Auto-update, current surface. One snapshot carrying the capability of this
  // build, the version the user has already waved away, and the current status.
  getUpdateStatus: (): Promise<unknown> => ipcRenderer.invoke('get-update-status'),
  isSandboxed: (): Promise<boolean> => ipcRenderer.invoke('is-sandboxed'),

  onUpdateStatusChanged: (callback: (snapshot: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('update-status-changed', handler);
    return () => { ipcRenderer.removeListener('update-status-changed', handler); };
  },

  dismissUpdate: (version: string): void => {
    ipcRenderer.send('dismiss-update', { version });
  },

  openReleasePage: (): void => {
    ipcRenderer.send('open-release-page');
  },

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
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  // invoke, not send: the renderer must know the preselection has landed in the
  // main process before it calls getDisplayMedia(), or the two race.
  preselectScreenSource: (sourceId: string, shareAudio?: boolean, targetId?: string) =>
    ipcRenderer.invoke('screen-share-preselect', sourceId, shareAudio ?? true),
  getScreenSharePickerMode: () => ipcRenderer.invoke('get-screen-share-picker-mode'),
  // `true` from a web client that opens the system-audio source (startSystemAudio)
  // itself; an older client passes nothing and gets the loopback's answer.
  getSystemAudioCapability: (usesAppSource?: boolean) =>
    ipcRenderer.invoke('get-system-audio-capability', usesAppSource === true),
  onProcessAudio: (onData: (data: Uint8Array) => void, onEnded: () => void) => {
    const data = (_event: Electron.IpcRendererEvent, bytes: Uint8Array) => onData(bytes);
    const ended = () => onEnded();
    ipcRenderer.on('process-audio-data', data);
    ipcRenderer.on('process-audio-ended', ended);
    return () => { ipcRenderer.removeListener('process-audio-data', data); ipcRenderer.removeListener('process-audio-ended', ended); };
  },
  setSystemAudioTarget: (targetId: string) => ipcRenderer.invoke('system-audio-target', targetId),
  getSystemAudioTargets: () => ipcRenderer.invoke('system-audio-targets'),
  startSystemAudio: () => ipcRenderer.invoke('system-audio-start'),
  stopSystemAudio: () => ipcRenderer.invoke('system-audio-stop'),
  setScreenShareAudioPreference: (shareAudio: boolean) => {
    ipcRenderer.send('screen-share-audio-preference', shareAudio);
  },

  // Instance URL management
  getInstanceUrl: () => ipcRenderer.invoke('get-instance-url'),
  setInstanceUrl: (url: string) => ipcRenderer.invoke('set-instance-url', url),
  clearInstanceUrl: () => ipcRenderer.invoke('clear-instance-url'),

  // Language: the renderer owns the choice; main relabels its tray and menus.
  setLanguage: (language: string) => ipcRenderer.send('set-language', language),

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
  onActivitiesDetected: (callback: (activities: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, activities: unknown) => callback(activities);
    ipcRenderer.on('activities-detected', handler);
    return () => { ipcRenderer.removeListener('activities-detected', handler); };
  },
  getCurrentActivities: () => ipcRenderer.invoke('get-current-activities'),
  listKnownGames: (): Promise<string[]> => ipcRenderer.invoke('list-known-games'),
  // Programs the player can tie their game to, and the tie itself
  listRunningPrograms: (): Promise<Array<{ label: string; process: string }>> => ipcRenderer.invoke('list-running-programs'),
  getUnknownWinePrograms: (): Promise<Array<{ label: string; process: string }>> => ipcRenderer.invoke('get-unknown-wine-programs'),
  setManualGameBindings: (bindings: Array<{ name: string; process: string }>): Promise<void> => ipcRenderer.invoke('set-manual-game-bindings', bindings),
  setManualGameBinding: (binding: { name: string; process: string } | null): Promise<void> => ipcRenderer.invoke('set-manual-game-binding', binding),
  // Locally extracted game icon (Steam library cache, .desktop entries,
  // AppImage/GOG directories), base64; the renderer uploads it to the
  // user's instance so the activity can carry an instance-hosted icon URL.
  getGameIcon: (name: string): Promise<{ data: string; mime: string } | null> =>
    ipcRenderer.invoke('get-game-icon', name),
  getActivitySettings: () => ipcRenderer.invoke('get-activity-settings'),
  setActivitySettings: (settings: { enablePreemption?: boolean }) =>
    ipcRenderer.invoke('set-activity-settings', settings),
  getMediaSetupHint: () => ipcRenderer.invoke('get-media-setup-hint'),
  onMediaSetupHint: (callback: (hint: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, hint: unknown) => callback(hint);
    ipcRenderer.on('media-setup-hint', handler);
    return () => { ipcRenderer.removeListener('media-setup-hint', handler); };
  },

  // Keybind support
  getKeybindPortalStatus: () => ipcRenderer.invoke('keybind-portal-status'),
  retryKeybindPortal: () => ipcRenderer.send('keybind-portal-retry'),
  configureKeybindPortal: () => ipcRenderer.invoke('keybind-portal-configure'),
  integrateKeybindAppImage: () => ipcRenderer.invoke('keybind-appimage-integrate'),
  onKeybindPortalStatus: (callback: (status: import('./portalShortcut').PortalKeybindStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: import('./portalShortcut').PortalKeybindStatus) => callback(status);
    ipcRenderer.on('keybind-portal-status', handler);
    return () => { ipcRenderer.removeListener('keybind-portal-status', handler); };
  },
  syncKeybinds: (keybinds: Array<{ actionId: string; keys: number[]; mouseButton?: number }>) => {
    return ipcRenderer.invoke('keybinds-sync', keybinds);
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

// Linux uses a custom frame so Chromium cannot omit minimize/maximize controls.
// Keep these in preload so older self-hosted web clients retain window controls.
if (process.platform === 'linux' && !window.opener) {
  window.addEventListener('DOMContentLoaded', () => {
    const controls = document.createElement('div');
    controls.setAttribute('aria-label', 'Window controls');
    Object.assign(controls.style, {
      position: 'fixed', top: '0', right: '0', zIndex: '2147483647',
      display: 'flex', height: 'calc(32px / var(--interface-scale, 1))',
      color: '#d8d8de', background: '#0b0b10', fontFamily: 'sans-serif',
    });
    const buttons: Array<[string, string, string]> = [
      ['Minimize', '−', 'minimize-window'],
      ['Maximize or restore', '□', 'maximize-window'],
      ['Close', '×', 'close-window'],
    ];
    for (const [label, symbol, channel] of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.textContent = symbol;
      Object.assign(button.style, {
        width: 'calc(46px / var(--interface-scale, 1))', height: '100%',
        border: '0', padding: '0', color: 'inherit', background: 'transparent',
        fontSize: 'calc(18px / var(--interface-scale, 1))', cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
      });
      button.addEventListener('mouseenter', () => { button.style.background = channel === 'close-window' ? '#c42b1c' : '#ffffff20'; });
      button.addEventListener('mouseleave', () => { button.style.background = 'transparent'; });
      button.addEventListener('click', () => ipcRenderer.send(channel));
      controls.appendChild(button);
    }
    document.body.appendChild(controls);
  });
}
