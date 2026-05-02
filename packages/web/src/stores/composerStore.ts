import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';

export interface ComposerState {
  draftText: string;
  replyTo: { id: string; userId: string; content: string | null } | null;
  stagedTransferIds: string[];
}

interface ComposerStoreState {
  states: Map<string, ComposerState>;
}

interface ComposerStoreActions {
  get: (channelId: string) => ComposerState;
  attach: (channelId: string, transferId: string) => void;
  removeStaged: (channelId: string, transferId: string) => void;
  setDraft: (channelId: string, draft: string) => void;
  setReplyTo: (channelId: string, replyTo: ComposerState['replyTo']) => void;
  clear: (channelId: string) => void;
}

type ComposerStore = ComposerStoreState & ComposerStoreActions;

const EMPTY: ComposerState = { draftText: '', replyTo: null, stagedTransferIds: [] };

// Custom storage that serializes Map<string, ComposerState> as an array of entries.
// Mirrors transferStore's mapAwareStorage pattern; only the `states` slice is persisted.
const mapAwareStorage: PersistStorage<Pick<ComposerStoreState, 'states'>> = {
  getItem: (name) => {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { state: { states: [string, ComposerState][] }; version?: number };
      const stateOut: Pick<ComposerStoreState, 'states'> = {
        states: new Map<string, ComposerState>(parsed.state.states ?? []),
      };
      return { state: stateOut, version: parsed.version } as StorageValue<Pick<ComposerStoreState, 'states'>>;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (typeof localStorage === 'undefined') return;
    const entries = Array.from(value.state.states.entries());
    const payload = JSON.stringify({ state: { states: entries }, version: value.version });
    try {
      localStorage.setItem(name, payload);
    } catch (err) {
      console.warn(`[composerStore] persist failed:`, err);
    }
  },
  removeItem: (name) => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(name);
  },
};

export const useComposerStore = create<ComposerStore>()(
  persist(
    (set, get) => ({
      states: new Map<string, ComposerState>(),

      get: (channelId) => get().states.get(channelId) ?? EMPTY,

      attach: (channelId, transferId) =>
        set((s) => {
          const cur = s.states.get(channelId) ?? EMPTY;
          if (cur.stagedTransferIds.includes(transferId)) return s;
          const next = new Map(s.states);
          next.set(channelId, { ...cur, stagedTransferIds: [...cur.stagedTransferIds, transferId] });
          return { states: next };
        }),

      removeStaged: (channelId, transferId) =>
        set((s) => {
          const cur = s.states.get(channelId) ?? EMPTY;
          const next = new Map(s.states);
          next.set(channelId, {
            ...cur,
            stagedTransferIds: cur.stagedTransferIds.filter((t) => t !== transferId),
          });
          return { states: next };
        }),

      setDraft: (channelId, draftText) =>
        set((s) => {
          const cur = s.states.get(channelId) ?? EMPTY;
          const next = new Map(s.states);
          next.set(channelId, { ...cur, draftText });
          return { states: next };
        }),

      setReplyTo: (channelId, replyTo) =>
        set((s) => {
          const cur = s.states.get(channelId) ?? EMPTY;
          const next = new Map(s.states);
          next.set(channelId, { ...cur, replyTo });
          return { states: next };
        }),

      clear: (channelId) =>
        set((s) => {
          const next = new Map(s.states);
          next.set(channelId, EMPTY);
          return { states: next };
        }),
    }),
    {
      name: 'composerStore@v1',
      version: 1,
      storage: mapAwareStorage,
      partialize: (s) => ({ states: s.states }),
    },
  ),
);
