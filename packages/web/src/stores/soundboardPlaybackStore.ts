import { create } from 'zustand';

export interface SoundboardSender {
  identity: string;
  userId: string;
}

interface PlaybackState {
  identities: Set<string>;
  userIds: Set<string>;
  setPlaybacks: (senders: SoundboardSender[]) => void;
}

export const useSoundboardPlaybackStore = create<PlaybackState>((set) => ({
  identities: new Set(),
  userIds: new Set(),
  setPlaybacks: (senders) => set({
    identities: new Set(senders.map((sender) => sender.identity)),
    userIds: new Set(senders.map((sender) => sender.userId)),
  }),
}));
