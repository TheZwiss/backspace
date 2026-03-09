import { create } from 'zustand';
import type { InstanceStreamingLimits, InstanceAdminSettings } from '@backspace/shared';
import { api } from '../api/client';

interface SettingsState {
  streamingLimits: InstanceStreamingLimits | null;
  instanceSettings: InstanceAdminSettings | null;
  isAdmin: boolean;
  fetchStreamingLimits: () => Promise<void>;
  updateStreamingLimits: (limits: Partial<InstanceStreamingLimits>) => Promise<void>;
  fetchInstanceSettings: () => Promise<void>;
  updateInstanceSettings: (data: Partial<InstanceAdminSettings>) => Promise<void>;
  setIsAdmin: (isAdmin: boolean) => void;
}

const DEFAULT_LIMITS: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080],
  allowedFramerates: [30, 45, 60],
  maxResolution: 1080,
  maxFramerate: 60,
  discoveryEnabled: true,
};

export function getStreamingLimits(): InstanceStreamingLimits {
  return useSettingsStore.getState().streamingLimits ?? DEFAULT_LIMITS;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  streamingLimits: null,
  instanceSettings: null,
  isAdmin: false,

  fetchStreamingLimits: async () => {
    try {
      const limits = await api.settings.getStreaming();
      set({ streamingLimits: limits });
    } catch (err) {
      console.warn('[Settings] Failed to fetch streaming limits, using defaults:', err);
      set({ streamingLimits: DEFAULT_LIMITS });
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
    // If discoveryEnabled changed, also update it in streamingLimits for the DiscoveryPanel warning banner
    if (data.discoveryEnabled !== undefined) {
      set((state) => ({
        streamingLimits: state.streamingLimits
          ? { ...state.streamingLimits, discoveryEnabled: updated.discoveryEnabled }
          : state.streamingLimits,
      }));
    }
  },

  setIsAdmin: (isAdmin: boolean) => set({ isAdmin }),
}));
