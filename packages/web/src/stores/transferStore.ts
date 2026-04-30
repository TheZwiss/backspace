import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';

export type TransferType = 'upload' | 'download';
export type TransferState =
  | 'queued' | 'active' | 'paused' | 'completed' | 'failed' | 'aborted';

export interface TransferError {
  message: string;
  permanent: boolean;
}

export interface Transfer {
  id: string;
  type: TransferType;
  state: TransferState;
  file: { name: string; size: number; mimetype: string };
  progress: { loaded: number; total: number };
  error?: TransferError;
  channelId?: string;
  tray: boolean;
  origin?: string;

  // Upload-specific
  tusUploadUrl?: string;
  tusExpiresAt?: number;
  fileHandleId?: string;
  attachmentId?: string;
  uploaderUserId?: string;

  // Download-specific
  sourceUrl?: string;
  destFileHandleId?: string;
  bytesWrittenToDisk?: number;
}

export interface CreateTransferInput {
  type: TransferType;
  file: { name: string; size: number; mimetype: string };
  tray: boolean;
  channelId?: string;
  origin?: string;
  fileHandleId?: string;
  destFileHandleId?: string;
  sourceUrl?: string;
  uploaderUserId?: string;
}

interface TransferStoreState {
  transfers: Map<string, Transfer>;
}

interface TransferStoreActions {
  createTransfer: (input: CreateTransferInput) => string;
  setState_: (id: string, state: TransferState) => void;
  updateProgress: (id: string, loaded: number) => void;
  setError: (id: string, error: TransferError) => void;
  setTusUrl: (id: string, url: string, expiresAt: number) => void;
  setAttachmentId: (id: string, attachmentId: string) => void;
  remove: (id: string) => void;

  get: (id: string) => Transfer | undefined;
  listVisible: () => Transfer[];
  listForChannel: (channelId: string) => Transfer[];
}

type TransferStore = TransferStoreState & TransferStoreActions;

function uuid(): string {
  return crypto.randomUUID();
}

// Custom storage that serializes Map<string, Transfer> as an array of entries.
// Only the `transfers` slice is persisted; partialize controls which entries.
const mapAwareStorage: PersistStorage<Pick<TransferStoreState, 'transfers'>> = {
  getItem: (name) => {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { state: { transfers: [string, Transfer][] }; version?: number };
      const stateOut: Pick<TransferStoreState, 'transfers'> = {
        transfers: new Map<string, Transfer>(parsed.state.transfers ?? []),
      };
      return { state: stateOut, version: parsed.version } as StorageValue<Pick<TransferStoreState, 'transfers'>>;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (typeof localStorage === 'undefined') return;
    const entries = Array.from(value.state.transfers.entries());
    const payload = JSON.stringify({ state: { transfers: entries }, version: value.version });
    localStorage.setItem(name, payload);
  },
  removeItem: (name) => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(name);
  },
};

export const useTransferStore = create<TransferStore>()(
  persist(
    (set, get) => ({
      transfers: new Map<string, Transfer>(),

      createTransfer: (input) => {
        const id = uuid();
        const t: Transfer = {
          id,
          type: input.type,
          state: 'queued',
          file: input.file,
          progress: { loaded: 0, total: input.file.size },
          tray: input.tray,
          channelId: input.channelId,
          origin: input.origin,
          fileHandleId: input.fileHandleId,
          destFileHandleId: input.destFileHandleId,
          sourceUrl: input.sourceUrl,
          uploaderUserId: input.uploaderUserId,
        };
        set((s) => {
          const next = new Map(s.transfers);
          next.set(id, t);
          return { transfers: next };
        });
        return id;
      },

      setState_: (id, state) => set((s) => {
        const t = s.transfers.get(id);
        if (!t) return s;
        const next = new Map(s.transfers);
        next.set(id, { ...t, state });
        return { transfers: next };
      }),

      updateProgress: (id, loaded) => set((s) => {
        const t = s.transfers.get(id);
        if (!t) return s;
        const next = new Map(s.transfers);
        next.set(id, { ...t, progress: { ...t.progress, loaded } });
        return { transfers: next };
      }),

      setError: (id, error) => set((s) => {
        const t = s.transfers.get(id);
        if (!t) return s;
        const next = new Map(s.transfers);
        next.set(id, { ...t, error, state: 'failed' });
        return { transfers: next };
      }),

      setTusUrl: (id, tusUploadUrl, tusExpiresAt) => set((s) => {
        const t = s.transfers.get(id);
        if (!t) return s;
        const next = new Map(s.transfers);
        next.set(id, { ...t, tusUploadUrl, tusExpiresAt });
        return { transfers: next };
      }),

      setAttachmentId: (id, attachmentId) => set((s) => {
        const t = s.transfers.get(id);
        if (!t) return s;
        const next = new Map(s.transfers);
        next.set(id, { ...t, attachmentId });
        return { transfers: next };
      }),

      remove: (id) => set((s) => {
        if (!s.transfers.has(id)) return s;
        const next = new Map(s.transfers);
        next.delete(id);
        return { transfers: next };
      }),

      get: (id) => get().transfers.get(id),
      listVisible: () => Array.from(get().transfers.values()).filter((t) => t.tray),
      listForChannel: (channelId) =>
        Array.from(get().transfers.values()).filter((t) => t.channelId === channelId),
    }),
    {
      name: 'transferStore@v1',
      storage: mapAwareStorage,
      version: 1,
      // Only persist transfers that are meaningful to rehydrate:
      //   - completed uploads waiting for the deferred POST (have attachmentId)
      //   - in-flight uploads with a tusUploadUrl (resumable on reload)
      //   - failed transfers (user may want to retry / discard)
      // Drop active in-flight without a tusUrl (their state is lost), drop aborted (user discarded).
      partialize: (s) => ({
        transfers: new Map(
          Array.from(s.transfers.entries()).filter(([, t]) =>
            t.attachmentId !== undefined ||
            t.tusUploadUrl !== undefined ||
            t.state === 'failed' ||
            t.state === 'paused'
          )
        ),
      }),
    },
  ),
);
