import { create } from 'zustand';
import { isElectron } from '../platform/platform';

/**
 * Desktop update state for the renderer.
 *
 * The main process owns the truth: whether this build can install its own
 * updates, which version the user already waved away, and where the updater is.
 * This store mirrors that one snapshot and exposes the actions. It deliberately
 * holds no opinion about code signing, platforms, or Squirrel.
 *
 * Two compatibility facts shape this file:
 *
 *  1. The desktop app and the instance it connects to version independently. A
 *     client served by a newer instance can be running inside an older desktop
 *     app that has no snapshot API, so every call is feature-detected and there
 *     is a legacy path that reconstructs the same state from the old per-event
 *     channels.
 *  2. The snapshot arrives over IPC as `unknown`. It is validated here rather
 *     than trusted, because "an older app sent a different shape" is a real
 *     case, not a hypothetical one.
 */

export interface UpdateStoreState {
  /** Null until the first snapshot arrives, or forever outside Electron. */
  snapshot: DesktopUpdateSnapshot | null;
  /** The running app's version, for copy like "You are on 1.0.3". */
  currentVersion: string | null;
  /**
   * True when the host app predates the snapshot API. Dismissal then lives only
   * for this session, because the old app has nowhere to persist it.
   */
  legacyBridge: boolean;

  /** Subscribes to the main process. Returns a teardown. Safe to call twice. */
  initialize: () => () => void;
  dismiss: () => void;
  install: () => void;
  openDownloadPage: () => void;
  checkNow: () => void;
}

/**
 * Validates an IPC payload into a snapshot, or returns null.
 *
 * Exported for tests. Every field is checked because a malformed snapshot must
 * degrade to "no update surface" rather than render a card with `undefined` in
 * it or throw during a render pass.
 */
export function coerceSnapshot(value: unknown): DesktopUpdateSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  const capability = raw.capability;
  if (capability !== 'auto' && capability !== 'manual') return null;

  const dismissedVersion = raw.dismissedVersion;
  if (dismissedVersion !== null && typeof dismissedVersion !== 'string') return null;

  const status = coerceStatus(raw.status);
  if (status === null) return null;

  return { capability, dismissedVersion, status };
}

function coerceStatus(value: unknown): DesktopUpdateStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const version = typeof raw.version === 'string' ? raw.version : null;

  switch (raw.phase) {
    case 'idle':
      return { phase: 'idle' };
    case 'checking':
      return { phase: 'checking' };
    case 'available':
      return version === null ? null : { phase: 'available', version };
    case 'downloading':
      if (version === null) return null;
      return {
        phase: 'downloading',
        version,
        percent: typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? raw.percent : 0,
        bytesPerSecond:
          typeof raw.bytesPerSecond === 'number' && Number.isFinite(raw.bytesPerSecond)
            ? raw.bytesPerSecond
            : 0,
      };
    case 'ready':
      return version === null ? null : { phase: 'ready', version };
    case 'failed':
      return {
        phase: 'failed',
        version,
        message: typeof raw.message === 'string' ? raw.message : 'The update failed.',
      };
    case 'up-to-date':
      return {
        phase: 'up-to-date',
        checkedAt: typeof raw.checkedAt === 'number' ? raw.checkedAt : 0,
      };
    default:
      return null;
  }
}

/** The version a status is about, or null when it carries none. */
export function statusVersion(status: DesktopUpdateStatus): string | null {
  switch (status.phase) {
    case 'available':
    case 'downloading':
    case 'ready':
      return status.version;
    case 'failed':
      return status.version;
    default:
      return null;
  }
}

/**
 * Whether the toast should interrupt the user.
 *
 * Mirrors `shouldPromptForUpdate` in the desktop package, which is also what the
 * native notification asks. Keeping the rule identical on both sides is what
 * stops the OS notification and the in-app card disagreeing about "later".
 *
 * `checking`, `downloading` and `up-to-date` are progress, not news. A chat
 * client has no business throwing a card over the message list to report them.
 */
export function shouldPrompt(snapshot: DesktopUpdateSnapshot | null): boolean {
  if (snapshot === null) return false;
  const { status, dismissedVersion } = snapshot;
  if (status.phase !== 'available' && status.phase !== 'ready' && status.phase !== 'failed') {
    return false;
  }
  const version = statusVersion(status);
  // A check that failed before it learned a version has nothing actionable to
  // offer. It belongs in settings, not in the user's face.
  if (version === null) return false;
  return version !== dismissedVersion;
}

/**
 * Whether to offer a Restart button.
 *
 * False on a build that cannot install in place, which is what removes the dead
 * button. `ready` on a manual-capability build should not happen (the download
 * never starts), but it is handled rather than assumed away.
 */
export function canRestartToInstall(snapshot: DesktopUpdateSnapshot | null): boolean {
  return snapshot?.capability === 'auto' && snapshot.status.phase === 'ready';
}

// Refcounted so the toast and the settings panel can both subscribe, and so
// React StrictMode's double-invoked effects do not double-register listeners.
let subscriberCount = 0;
let teardown: (() => void) | null = null;

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
  snapshot: null,
  currentVersion: null,
  legacyBridge: false,

  initialize: () => {
    subscriberCount += 1;

    if (subscriberCount === 1) {
      teardown = startBridge(set);
    }

    return () => {
      subscriberCount -= 1;
      if (subscriberCount === 0 && teardown) {
        teardown();
        teardown = null;
      }
    };
  },

  dismiss: () => {
    const snapshot = get().snapshot;
    const version = snapshot ? statusVersion(snapshot.status) : null;
    if (version === null || snapshot === null) return;

    const api = window.backspace;
    if (api?.dismissUpdate) {
      // The main process persists it and echoes a new snapshot back, so the
      // store is not updated optimistically here. If the write fails, the
      // prompt honestly stays rather than silently vanishing.
      api.dismissUpdate(version);
      return;
    }

    // Legacy host: no persistence available, so hold it for this session only.
    set({ snapshot: { ...snapshot, dismissedVersion: version } });
  },

  install: () => {
    window.backspace?.installUpdate();
  },

  openDownloadPage: () => {
    const api = window.backspace;
    if (api?.openReleasePage) {
      api.openReleasePage();
      return;
    }
    // Older host with no dedicated channel. The renderer's window.open is
    // intercepted by setWindowOpenHandler and routed to the default browser.
    window.open('https://github.com/TheZwiss/backspace/releases/latest', '_blank', 'noopener');
  },

  checkNow: () => {
    window.backspace?.checkForUpdates();
  },
}));

type SetState = (
  partial:
    | Partial<UpdateStoreState>
    | ((state: UpdateStoreState) => Partial<UpdateStoreState>),
) => void;

/**
 * Wires the store to the host app, and returns a teardown.
 *
 * Outside Electron this does nothing at all, so the browser client never
 * renders an update surface.
 */
function startBridge(set: SetState): () => void {
  if (!isElectron() || !window.backspace) return () => {};
  const api = window.backspace;

  api.getVersion()
    .then((version) => set({ currentVersion: version }))
    .catch(() => { /* version is decoration; its absence changes no behaviour */ });

  if (api.getUpdateStatus && api.onUpdateStatusChanged) {
    const unsubscribe = api.onUpdateStatusChanged((raw) => {
      const snapshot = coerceSnapshot(raw);
      if (snapshot !== null) set({ snapshot });
    });

    api.getUpdateStatus()
      .then((raw) => {
        const snapshot = coerceSnapshot(raw);
        if (snapshot !== null) set({ snapshot });
      })
      .catch(() => { /* a live snapshot will arrive on the next updater event */ });

    return unsubscribe;
  }

  return startLegacyBridge(set, api);
}

/**
 * Reconstructs a snapshot from the pre-1.0.5 per-event channels.
 *
 * Those channels have no cleanup functions, so the listeners registered here
 * outlive the teardown. That is why the bridge is refcounted and started once:
 * a leak of one listener per app lifetime is acceptable, a leak per mount is
 * not.
 *
 * Capability is reported as `auto` because that is what the old app behaved
 * like. It always offered Restart. The one thing this path does fix on an old
 * host is the ordering bug: a failure arriving after a ready state now wins,
 * instead of hiding behind it.
 */
function startLegacyBridge(set: SetState, api: BackspaceElectronAPI): () => void {
  let disposed = false;
  set({ legacyBridge: true });

  api.onUpdateDownloaded((info) => {
    if (disposed) return;
    set({
      snapshot: {
        capability: 'auto',
        dismissedVersion: null,
        status: { phase: 'ready', version: info.version },
      },
    });
  });

  api.onUpdateError((error) => {
    if (disposed) return;
    set((prev) => ({
      snapshot: {
        capability: 'auto',
        dismissedVersion: prev.snapshot?.dismissedVersion ?? null,
        status: {
          phase: 'failed',
          version: prev.snapshot ? statusVersion(prev.snapshot.status) : null,
          message: error.message,
        },
      },
    }));
  });

  return () => { disposed = true; };
}
