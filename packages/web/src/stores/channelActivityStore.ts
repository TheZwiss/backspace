import { create } from 'zustand';

interface ChannelActivityState {
  counts: Record<string, Record<string, number>>;
  pokeOrigins: Record<string, boolean>;
  hydrate: (origin: string, snapshot: { counts?: Record<string, number>; supportsPoke?: boolean }) => void;
  updateCounts: (origin: string, counts: Record<string, number>) => void;
  reset: () => void;
}
export const useChannelActivityStore = create<ChannelActivityState>(set => ({
  counts: {}, pokeOrigins: {},
  // Replace the origin snapshot on reconnect, including lost permissions/deleted channels.
  hydrate: (origin, snapshot) => set(s => ({
    counts: { ...s.counts, [origin]: snapshot.counts ?? {} },
    pokeOrigins: { ...s.pokeOrigins, [origin]: snapshot.supportsPoke === true },
  })),
  updateCounts: (origin, counts) => set(s => ({ counts: {
    ...s.counts, [origin]: { ...s.counts[origin], ...counts },
  } })),
  reset: () => set({ counts: {}, pokeOrigins: {} }),
}));
