import { create } from 'zustand';

/** Pokes are served by the space's host, not relayed into DMs or unsupported hosts. */
export const useChannelPokeStore = create<{
  hosts: Record<string, boolean>;
  setHost: (origin: string, supported: boolean) => void;
  reset: () => void;
}>((set) => ({
  hosts: {},
  setHost: (origin, supported) => set(state => ({ hosts: { ...state.hosts, [origin]: supported } })),
  reset: () => set({ hosts: {} }),
}));
