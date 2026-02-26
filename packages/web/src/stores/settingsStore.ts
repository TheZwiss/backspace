import { create } from 'zustand';
import type { InstanceStreamingLimits } from '@opencord/shared';
import { api } from '../api/client';

interface SettingsState {
  streamingLimits: InstanceStreamingLimits | null;
  isAdmin: boolean;
  fetchStreamingLimits: () => Promise<void>;
  updateStreamingLimits: (limits: Partial<InstanceStreamingLimits>) => Promise<void>;
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
};

export function getStreamingLimits(): InstanceStreamingLimits {
  return useSettingsStore.getState().streamingLimits ?? DEFAULT_LIMITS;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  streamingLimits: null,
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

  setIsAdmin: (isAdmin: boolean) => set({ isAdmin }),
}));
