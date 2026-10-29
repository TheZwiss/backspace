import { create } from 'zustand';

interface PlaybackState {
  identity: string | null;
  userId: string | null;
  setPlayback: (identity: string | null, userId: string | null) => void;
}

export const useSoundboardPlaybackStore = create<PlaybackState>((set) => ({
  identity: null,
  userId: null,
  setPlayback: (identity, userId) => set({ identity, userId }),
}));
