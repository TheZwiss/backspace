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

/**
 * Whether a System Audio share on this OS build carries Backspace's own
 * playback to viewers. See packages/desktop/src/systemAudioCapability.ts.
 */
type OwnAudioInSystemAudio = 'excluded' | 'included' | 'unavailable' | 'unknown';

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

interface LocalTextVoiceStatus {
  phase: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  device?: 'auto' | 'cpu' | 'gpu';
  backend?: 'cpu' | 'webgpu';
  progress?: number;
  adapter?: { vendor: string; architecture: string; description: string } | null;
  error?: string;
}

interface BackspaceElectronAPI {
  getTextVoiceStatus?: () => Promise<LocalTextVoiceStatus>;
  prepareTextVoice?: (device: 'auto' | 'cpu' | 'gpu') => Promise<LocalTextVoiceStatus>;
  synthesizeTextVoice?: (text: string, voice: string, speed: number) => Promise<{ audio: ArrayBuffer; generationMs: number; audioSeconds: number; backend: string }>;
  releaseTextVoice?: () => Promise<void>;
  onTextVoiceStatus?: (callback: (status: LocalTextVoiceStatus) => void) => () => void;
  // Platform info
  platform: NodeJS.Platform;
  // Window controls
  controlCallWindow?: (action: 'minimize' | 'maximize' | 'close') => void;
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
  /**
   * Optional: desktop builds before the setup-screen flow lack these two. The
   * web client feature-detects them and falls back to the prompted flow
   * (getDisplayMedia → onScreenShareSources → selectScreenSource).
   */
  /**
   * `thumbnails: false` asks for ids, names and icons only — the cheap poll the
   * setup screen runs while it is open. Older desktop builds ignore the
   * argument and always return previews.
   */
  getScreenSources?: (options?: { thumbnails?: boolean }) => Promise<ElectronScreenSource[]>;
  preselectScreenSource?: (
    sourceId: string,
    shareAudio?: boolean,
    targetId?: string,
    /** A window source whose audio to take while `sourceId` is only its display. */
    audioSourceId?: string,
  ) => Promise<void>;
  /**
   * Where a window is on its display, for the borderless window-capture path.
   * Null where the build or the machine cannot answer; the caller then shares
   * the window through Chromium as before.
   */
  getWindowCaptureTarget?: (sourceId: string) => Promise<{
    screenSourceId: string;
    monitor: { width: number; height: number };
    crop: { x: number; y: number; width: number; height: number };
    minimized: boolean;
    /** False while another window is focused: the share shows a paused card. */
    foreground: boolean;
  } | null>;
  /**
   * 'system' when the OS picks the source (Wayland screencast portal): the
   * renderer shows a "choose" card that triggers the portal on click instead
   * of listing sources, which would prompt on every open. 'app' elsewhere.
   */
  getScreenSharePickerMode?: () => Promise<'app' | 'system'>;
  /** System-picker captures carry no preselection; this tells main whether to add loopback audio. */
  setScreenShareAudioPreference?: (shareAudio: boolean) => void;
  /**
   * Optional: older desktop builds lack it, and the stream settings
   * then keep their generic per-platform System Audio note.
   */
  getSystemAudioCapability?: (usesAppSource?: boolean) => Promise<OwnAudioInSystemAudio>;
  /**
   * Linux: route every other app's playback into a virtual source that the
   * renderer opens as a microphone (`label` names the device). Optional: only
   * desktop builds that ship it have it.
   */
  setSystemAudioTarget?: (targetId: string) => Promise<void>;
  getSystemAudioTargets?: () => Promise<Array<{ id: string; name: string }>>;
  onProcessAudio?: (onData: (data: Uint8Array) => void, onEnded: () => void) => () => void;
  startSystemAudio?: () => Promise<
    | { ok: true; label: string; pcm?: false }
    | { ok: true; pcm: true }
    | { ok: false; reason: 'unsupported-platform' | 'sandboxed' | 'module-missing' | 'no-pipewire' | 'link-failed' | 'process-capture-failed' | 'audio-target-required' }
  >;
  stopSystemAudio?: () => Promise<void>;

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
  /** Every game running at once. Absent in desktop builds that predate multi-game detection. */
  onActivitiesDetected?: (callback: (activities: unknown) => void) => (() => void);
  getCurrentActivities?: () => Promise<unknown>;
  /** Game names for the manual-game picker (dictionary + installed games); absent on older desktops. */
  listKnownGames?: () => Promise<string[]>;
  /** Programs the player can tie their game to. Absent in desktop builds that predate the binding. */
  listRunningPrograms?: () => Promise<Array<{ label: string; process: string }>>;
  /** Running Wine programs no detected game owns. Absent in desktop builds that predate it. */
  getUnknownWinePrograms?: () => Promise<Array<{ label: string; process: string }>>;
  setManualGameBindings?: (bindings: Array<{ name: string; process: string }>) => Promise<void>;
  setManualGameBinding?: (binding: { name: string; process: string } | null) => Promise<void>;
  /**
   * Locally extracted game icon (Steam library cache, .desktop entries,
   * AppImage/GOG directories) as base64, or null when none was found. The
   * renderer uploads it to the user's instance and attaches the instance's
   * URL to the activity it sends.
   */
  getGameIcon?: (name: string) => Promise<{ data: string; mime: string } | null>;
  getActivitySettings?: () => Promise<{ enablePreemption: boolean }>;
  setActivitySettings?: (settings: { enablePreemption?: boolean }) => Promise<{ enablePreemption: boolean }>;
  getMediaSetupHint?: () => Promise<string | null>;
  onMediaSetupHint?: (callback: (hint: string) => void) => (() => void);

  // Keybind support
  getKeybindPortalStatus?: () => Promise<KeybindPortalStatus | null>;
  onKeybindPortalStatus?: (callback: (status: KeybindPortalStatus) => void) => () => void;
  retryKeybindPortal?: () => void;
  configureKeybindPortal?: () => Promise<boolean>;
  integrateKeybindAppImage?: () => Promise<boolean>;
  // Older installed shells use send-based IPC and return void.
  syncKeybinds: (keybinds: Array<{ actionId: string; keys: number[]; mouseButton?: number }>) => Promise<boolean> | void;
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

interface KeybindPortalStatus {
  state: 'idle' | 'pending' | 'ready' | 'unavailable';
  shortcuts: Record<string, string>;
  reason?: 'missingDesktopEntry';
  canIntegrateAppImage?: boolean;
}
