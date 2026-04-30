import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import { Upload, type UploadOptions } from 'tus-js-client';
import type { Attachment } from '@backspace/shared';
import { useAuthStore } from './authStore';

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

  startUpload: (file: Blob, opts: { channelId?: string; tray?: boolean; origin?: string; fileHandleId?: string }) => Promise<string>;
  abortUpload: (id: string) => void;
  pauseUpload: (id: string) => void;
  resumeUpload: (id: string) => Promise<void>;

  get: (id: string) => Transfer | undefined;
  listVisible: () => Transfer[];
  listForChannel: (channelId: string) => Transfer[];
}

type TransferStore = TransferStoreState & TransferStoreActions;

function uuid(): string {
  return crypto.randomUUID();
}

// Live tus Upload instances — keyed by transferId. Not serializable, never persisted.
const liveUploads = new Map<string, Upload>();

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

      startUpload: async (file, opts) => {
        const token = useAuthStore.getState().token;
        const user = useAuthStore.getState().user;
        if (!token) throw new Error('Cannot start upload — not authenticated');

        const baseOrigin = opts.origin ?? '';
        const endpoint = `${baseOrigin}/api/files/`;

        const fileLike = file instanceof File
          ? { name: file.name, size: file.size, mimetype: file.type || 'application/octet-stream' }
          : { name: 'upload', size: file.size, mimetype: (file as Blob).type || 'application/octet-stream' };

        const id = get().createTransfer({
          type: 'upload',
          file: fileLike,
          tray: opts.tray ?? true,
          channelId: opts.channelId,
          origin: opts.origin,
          fileHandleId: opts.fileHandleId,
          uploaderUserId: user?.id,
        });

        const tusOpts: UploadOptions = {
          endpoint,
          retryDelays: [0, 1000, 3000, 5000, 10_000],
          metadata: {
            filename: fileLike.name,
            filetype: fileLike.mimetype,
          },
          chunkSize: 5 * 1024 * 1024,
          headers: { Authorization: `Bearer ${token}` },
          onProgress: (loaded: number) => {
            get().updateProgress(id, loaded);
            const t = get().get(id);
            if (t?.state === 'queued') get().setState_(id, 'active');
          },
          onAfterResponse: (_req, res) => {
            // res.getHeader returns string | undefined per tus-js-client v4 types.
            const location = res.getHeader('Location');
            const expires = res.getHeader('Upload-Expires');
            if (location && !get().get(id)?.tusUploadUrl) {
              const expiresMs = expires ? new Date(expires).getTime() : Date.now() + 24 * 60 * 60 * 1000;
              get().setTusUrl(id, location, expiresMs);
            }
          },
          onSuccess: (payload) => {
            try {
              const body = payload.lastResponse?.getBody?.() ?? '';
              const att = JSON.parse(body) as Attachment;
              get().setAttachmentId(id, att.id);
              get().setState_(id, 'completed');
              get().updateProgress(id, fileLike.size);
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Could not parse upload response';
              get().setError(id, { message: msg, permanent: true });
            } finally {
              liveUploads.delete(id);
            }
          },
          onError: (err: Error) => {
            const msg = err.message ?? 'Upload error';
            // Treat 4xx as permanent (no retry past tus's own retry chain).
            const permanent = /\b4\d\d\b/.test(msg);
            get().setError(id, { message: msg, permanent });
            liveUploads.delete(id);
          },
        };

        const upload = new Upload(file as File, tusOpts);
        liveUploads.set(id, upload);
        upload.start();
        return id;
      },

      abortUpload: (id) => {
        const u = liveUploads.get(id);
        if (u) {
          // tus-js-client v4: abort(true) deletes server-side state via DELETE.
          // We pass true so the user actually frees the slot, not just "pause".
          void u.abort(true).catch(() => { /* server may be unreachable; that's OK */ });
          liveUploads.delete(id);
        }
        get().setState_(id, 'aborted');
      },

      pauseUpload: (id) => {
        const u = liveUploads.get(id);
        if (u) {
          // abort(false) keeps server-side state — resumable.
          void u.abort(false).catch(() => { /* ignore */ });
          liveUploads.delete(id);
        }
        get().setState_(id, 'paused');
      },

      resumeUpload: async (id) => {
        const t = get().get(id);
        if (!t || t.type !== 'upload') return;
        if (!t.tusUploadUrl) {
          get().setError(id, { message: 'No tus URL — cannot resume', permanent: true });
          return;
        }
        if (Date.now() > (t.tusExpiresAt ?? 0)) {
          get().setError(id, { message: 'Upload expired', permanent: true });
          return;
        }

        const token = useAuthStore.getState().token;
        if (!token) {
          get().setError(id, { message: 'Not authenticated', permanent: true });
          return;
        }

        // Try to reacquire the file via the persisted FileSystemFileHandle.
        let blob: Blob | undefined;
        if (t.fileHandleId) {
          const { getHandle, ensurePermission } = await import('../utils/idbHandles');
          const handle = await getHandle(t.fileHandleId);
          if (handle) {
            const perm = await ensurePermission(handle, 'read');
            if (perm === 'granted') {
              const handleAny = handle as unknown as { getFile?: () => Promise<File> };
              if (typeof handleAny.getFile === 'function') {
                blob = await handleAny.getFile();
              }
            }
          }
        }

        if (!blob) {
          // No handle path — UI surfaces "re-pick to resume". Stay paused.
          get().setState_(id, 'paused');
          return;
        }

        const upload = new Upload(blob as File, {
          endpoint: t.origin ? `${t.origin}/api/files/` : '/api/files/',
          uploadUrl: t.tusUploadUrl,
          retryDelays: [0, 1000, 3000, 5000, 10_000],
          chunkSize: 5 * 1024 * 1024,
          headers: { Authorization: `Bearer ${token}` },
          onProgress: (loaded: number) => {
            get().updateProgress(id, loaded);
            const cur = get().get(id);
            if (cur?.state !== 'active') get().setState_(id, 'active');
          },
          onSuccess: (payload) => {
            try {
              const body = payload.lastResponse?.getBody?.() ?? '';
              const att = JSON.parse(body) as Attachment;
              get().setAttachmentId(id, att.id);
              get().setState_(id, 'completed');
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Resume completed but parse failed';
              get().setError(id, { message: msg, permanent: true });
            } finally {
              liveUploads.delete(id);
            }
          },
          onError: (err: Error) => {
            const msg = err.message ?? 'Resume error';
            const permanent = /\b4\d\d\b/.test(msg);
            get().setError(id, { message: msg, permanent });
            liveUploads.delete(id);
          },
        });
        liveUploads.set(id, upload);
        upload.start();
      },

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
