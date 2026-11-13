import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UsageState {
  counts: Record<string, Record<string, number>>;
  recordPlay: (origin: string, userId: string, soundId: string) => void;
}

export const useSoundboardUsageStore = create<UsageState>()(persist((set) => ({
  counts: {},
  recordPlay: (origin, userId, soundId) => set((state) => {
    const key = JSON.stringify([origin, userId]);
    const counts = state.counts[key] ?? {};
    return { counts: { ...state.counts, [key]: { ...counts, [soundId]: (counts[soundId] ?? 0) + 1 } } };
  }),
}), { name: 'soundboard-usage' }));
