import { create } from 'zustand';
import type { InstanceStreamingLimits, InstanceAdminSettings, TelemetryPayload, TelemetryStatus, InstanceUpdateStatus } from '@backspace/shared';
import { api } from '../api/client';
import { describeError } from '../i18n/errors';
import { EMPTY_ACK, readUpdateAck, writeUpdateAck, pendingUpdateVersion, type UpdateAck } from '../utils/updateAck';
import { clearDismissal } from '../utils/telemetryAsk';
import { getApiForOrigin } from '../utils/crossStoreResolvers';

interface SettingsState {
  /** Home's streaming document. Also carries home's discovery flags. */
  streamingLimits: InstanceStreamingLimits | null;
  /**
   * Streaming documents of other instances, keyed by origin. A voice channel in
   * a federated space streams through that instance's LiveKit, so its limits
   * are the ones a screen share there obeys. Filled by
   * `fetchStreamingLimitsFor` when a voice connection to that origin starts.
   */
  streamingLimitsByOrigin: Record<string, InstanceStreamingLimits>;
  instanceSettings: InstanceAdminSettings | null;
  isAdmin: boolean;
  gifEnabled: boolean;
  telemetry: TelemetryStatus | null;
  telemetryPreview: TelemetryPayload | null;
  fetchStreamingLimits: () => Promise<void>;
  /** Fetch a remote instance's streaming document; `''` is a no-op (home has its own field). */
  fetchStreamingLimitsFor: (origin: string) => Promise<void>;
  updateStreamingLimits: (limits: Partial<InstanceStreamingLimits>) => Promise<void>;
  fetchInstanceSettings: () => Promise<void>;
  updateInstanceSettings: (data: Partial<InstanceAdminSettings>) => Promise<void>;
  fetchGifEnabled: () => Promise<void>;
  fetchTelemetry: () => Promise<void>;
  fetchTelemetryPreview: () => Promise<void>;
  setTelemetryEnabled: (enabled: boolean) => Promise<void>;
  setIsAdmin: (isAdmin: boolean) => void;
  updateStatus: InstanceUpdateStatus | null;
  updateStatusLoading: boolean;
  updateStatusError: string;
  updateAck: UpdateAck;
  updateAckUserId: string | null;
  fetchUpdateStatus: (refresh?: boolean) => Promise<void>;
  markUpdateSeen: () => void;
  markUpdateToastShown: () => void;
  setUpdateAckUser: (userId: string | null) => void;
  stopUpdateStatusRefresh: () => void;
  resetUpdateState: () => void;
}

export const DEFAULT_STREAMING_LIMITS: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080],
  allowedFramerates: [30, 45, 60],
  maxResolution: 1080,
  maxFramerate: 60,
  discoveryEnabled: true,
  directoryEnabled: false,
  // The screen-share path is the only reader of these defaults and never
  // asks this; false is the value that claims nothing.
  directoryConfigured: false,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
};

/**
 * The streaming document of the instance at `origin` (`''` = home), or null
 * while it is not known. Readers that state a fact to the user use this and
 * treat null as unknown.
 */
export function selectStreamingLimits(
  state: Pick<SettingsState, 'streamingLimits' | 'streamingLimitsByOrigin'>,
  origin: string,
): InstanceStreamingLimits | null {
  if (!origin) return state.streamingLimits;
  return state.streamingLimitsByOrigin[origin] ?? null;
}

/**
 * The limits of the instance at `origin`, with the defaults standing in while
 * its document is unknown.
 *
 * This is the one place a default may be substituted: a screen share has to
 * pick a bitrate whatever the server said. Everything that states a fact to
 * the user, or offers to change one, reads `selectStreamingLimits` and treats
 * null as unknown. An unknown remote falls back to the defaults, never to
 * home's document, which says nothing about another instance.
 */
export function getStreamingLimits(origin: string): InstanceStreamingLimits {
  return selectStreamingLimits(useSettingsStore.getState(), origin) ?? DEFAULT_STREAMING_LIMITS;
}

/**
 * How often a live session re-asks for the update status.
 *
 * Matched to the server's own six-hour success cache, so a refresh that lands
 * inside the window costs nothing outbound. Without this, the admin the feature
 * exists for — the one who never opens settings and never reloads a long-lived
 * desktop window — would learn about a release only on their next sign-in.
 */
export const UPDATE_STATUS_REFRESH_MS = 6 * 60 * 60 * 1000;

let updateStatusTimer: ReturnType<typeof setTimeout> | null = null;
/** Coalesces concurrent callers (WS ready and a panel mount) into one request. */
let updateStatusInFlight: Promise<void> | null = null;

export const useSettingsStore = create<SettingsState>((set) => ({
  streamingLimits: null,
  streamingLimitsByOrigin: {},
  instanceSettings: null,
  isAdmin: false,
  gifEnabled: false,
  telemetry: null,
  telemetryPreview: null,

  fetchStreamingLimits: async () => {
    try {
      const limits = await api.settings.getStreaming();
      set({ streamingLimits: limits });
    } catch (err) {
      // Left null, not filled with defaults. The document carries the two
      // discovery flags, and `DEFAULT_STREAMING_LIMITS` asserts
      // `directoryEnabled: false`: substituting it told an admin on a listed
      // instance that their spaces are not listed, next to a button that
      // writes the setting. Every reader of this field already handles null,
      // and the one consumer that needs a number whatever happened (the
      // screen-share config) goes through `getStreamingLimits(origin)`, which
      // falls back at read time.
      console.warn('[Settings] Failed to fetch streaming limits:', err);
    }
  },

  fetchStreamingLimitsFor: async (origin: string) => {
    if (!origin) return;
    try {
      const limits = await getApiForOrigin(origin).settings.getStreaming();
      set((state) => ({ streamingLimitsByOrigin: { ...state.streamingLimitsByOrigin, [origin]: limits } }));
    } catch (err) {
      // A document this instance sent earlier is still its policy, so a failed
      // refresh keeps it rather than dropping to the defaults.
      console.warn(`[Settings] Failed to fetch streaming limits from ${origin}:`, err);
    }
  },

  updateStreamingLimits: async (limits: Partial<InstanceStreamingLimits>) => {
    const updated = await api.settings.updateStreaming(limits);
    set({ streamingLimits: updated });
  },

  fetchInstanceSettings: async () => {
    try {
      const settings = await api.settings.getInstance();
      set({ instanceSettings: settings });
    } catch (err) {
      console.warn('[Settings] Failed to fetch instance settings:', err);
    }
  },

  updateInstanceSettings: async (data: Partial<InstanceAdminSettings>) => {
    const updated = await api.settings.updateInstance(data);
    set({ instanceSettings: updated });
    // The space settings DiscoveryPanel reads both flags from streamingLimits,
    // the document any signed-in user may fetch. Mirror them from the server's
    // answer rather than from the request: turning discovery off clears the
    // directory server-side, and the answer is where that shows.
    set((state) => ({
      streamingLimits: state.streamingLimits
        ? {
            ...state.streamingLimits,
            discoveryEnabled: updated.discoveryEnabled,
            directoryEnabled: updated.directoryEnabled,
          }
        : state.streamingLimits,
    }));
  },

  fetchGifEnabled: async () => {
    try {
      const { enabled } = await api.gif.enabled();
      set({ gifEnabled: enabled });
    } catch {
      set({ gifEnabled: false });
    }
  },

  // Telemetry errors propagate to the caller, which shows them. The store does
  // not swallow them, the same as updateInstanceSettings.
  fetchTelemetry: async () => {
    const telemetry = await api.admin.telemetry.get();
    set({ telemetry });
  },

  fetchTelemetryPreview: async () => {
    const telemetryPreview = await api.admin.telemetry.preview();
    set({ telemetryPreview });
  },

  // Both the modal and the settings panel answer through here, so this is
  // where a stored answer forgets the browser's snooze: a "later" clicked
  // before a no has nothing left to hold back, and left in place it would
  // delay the ask the next minor release brings.
  setTelemetryEnabled: async (enabled: boolean) => {
    const telemetry = await api.admin.telemetry.set(enabled);
    set({ telemetry });
    clearDismissal(localStorage);
  },

  setIsAdmin: (isAdmin: boolean) => set({ isAdmin }),

  updateStatus: null,
  updateStatusLoading: false,
  updateStatusError: '',
  updateAck: EMPTY_ACK,
  updateAckUserId: null,

  /**
   * Records whose acknowledgements to read and write, handed over by the
   * WebSocket `ready` handler. It lives here rather than being read from
   * `authStore` because importing that store into this one drags the audio
   * pipeline into every test that touches settings.
   */
  setUpdateAckUser: (userId) => {
    set({ updateAckUserId: userId, updateAck: readUpdateAck(localStorage, userId) });
  },

  /**
   * Asks the home instance whether a newer release exists.
   *
   * Admin-gated on the client as well as the server, so a non-admin session
   * never issues a request that could only 403. The reschedule happens on every
   * completed call, including an explicit panel refresh, which keeps exactly one
   * timer alive regardless of how many callers there are.
   */
  fetchUpdateStatus: async (refresh = false) => {
    // Deliberately NOT gated on `isAdmin` here. That flag is set only by the
    // WebSocket `ready` handler, so a panel rendered before `ready` lands (or
    // during a reconnect) would be permanently stuck on an empty error state
    // with a "Try again" button that also did nothing. Both call sites are
    // admin-only by construction: the `ready` handler checks the flag it just
    // received, and UpdatesPanel only renders inside the admin-gated Instance
    // settings tab.
    //
    // An explicit refresh never joins an in-flight cached fetch: doing so would
    // silently downgrade a "Check again" click to whatever the earlier call
    // asked for.
    if (!refresh && updateStatusInFlight !== null) return updateStatusInFlight;

    set({ updateStatusLoading: true, updateStatusError: '' });

    updateStatusInFlight = (async () => {
      try {
        const result = await api.admin.updateStatus(refresh);
        set({
          updateStatus: result,
          updateAck: readUpdateAck(localStorage, useSettingsStore.getState().updateAckUserId),
          updateStatusError: '',
        });
      } catch (err) {
        set({ updateStatusError: describeError(err) });
      } finally {
        set({ updateStatusLoading: false });
        updateStatusInFlight = null;
        if (updateStatusTimer !== null) clearTimeout(updateStatusTimer);
        updateStatusTimer = setTimeout(() => {
          void useSettingsStore.getState().fetchUpdateStatus();
        }, UPDATE_STATUS_REFRESH_MS);
      }
    })();

    return updateStatusInFlight;
  },

  markUpdateSeen: () => {
    const version = pendingUpdateVersion(useSettingsStore.getState().updateStatus);
    if (version === null) return;
    const userId = useSettingsStore.getState().updateAckUserId;
    const next: UpdateAck = { ...useSettingsStore.getState().updateAck, seenVersion: version };
    writeUpdateAck(localStorage, userId, next);
    set({ updateAck: next });
  },

  markUpdateToastShown: () => {
    const version = pendingUpdateVersion(useSettingsStore.getState().updateStatus);
    if (version === null) return;
    const userId = useSettingsStore.getState().updateAckUserId;
    const next: UpdateAck = { ...useSettingsStore.getState().updateAck, toastShownFor: version };
    writeUpdateAck(localStorage, userId, next);
    set({ updateAck: next });
  },

  /**
   * Called by `resetUpdateState` (itself called on logout, from `authStore`'s
   * `resetUserStores`) and directly by tests, so a dead session leaves no
   * timer behind.
   */
  stopUpdateStatusRefresh: () => {
    if (updateStatusTimer !== null) {
      clearTimeout(updateStatusTimer);
      updateStatusTimer = null;
    }
  },

  /**
   * Clears everything about instance-update state on logout.
   *
   * `isAdmin` and `updateStatus` are permission-scoped, not instance-scoped:
   * unlike `streamingLimits` or `instanceSettings`, which describe the
   * instance itself and stay valid for whoever signs in next, these describe
   * the PREVIOUS user's admin status. Left in place, a non-admin signing in
   * on the same tab would render an admin-only update dot until the next
   * WebSocket `ready` overwrites it, and the six-hour refresh timer would
   * keep hitting `/api/admin/instance/update-status` for the life of the tab
   * with no admin session behind it.
   *
   * Deliberately does not import `authStore` to know when to run — see the
   * comment on `setUpdateAckUser` above. `authStore.resetUserStores()` calls
   * this instead, keeping the import direction one-way.
   */
  resetUpdateState: () => {
    useSettingsStore.getState().stopUpdateStatusRefresh();
    set({
      isAdmin: false,
      updateStatus: null,
      updateStatusLoading: false,
      updateStatusError: '',
      updateAck: EMPTY_ACK,
      updateAckUserId: null,
    });
  },
}));
