import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import { Upload, type UploadOptions } from 'tus-js-client';
import type { Attachment } from '@backspace/shared';
import { useAuthStore } from './authStore';
import { getTokenForOrigin } from '../utils/crossStoreResolvers';
import { getHandle, putHandle, ensurePermission, queryHandlePermission } from '../utils/idbHandles';

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
  attachmentFilename?: string;
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
  /**
   * Mirrors the keys of the module-scoped `liveUploadFiles` map so React components
   * can subscribe to "do we still hold the original File for this transfer?" reactively.
   * Session-scoped — never persisted (the underlying File refs vanish on reload).
   */
  hasInMemoryFile: Set<string>;
}

interface TransferStoreActions {
  createTransfer: (input: CreateTransferInput) => string;
  setState_: (id: string, state: TransferState) => void;
  updateProgress: (id: string, loaded: number) => void;
  setError: (id: string, error: TransferError) => void;
  setTusUrl: (id: string, url: string, expiresAt: number) => void;
  setAttachmentRef: (id: string, attachmentId: string, filename: string) => void;
  remove: (id: string) => void;

  startUpload: (file: Blob, opts: { channelId?: string; tray?: boolean; origin?: string; fileHandleId?: string }) => Promise<string>;
  abortUpload: (id: string) => void;
  pauseUpload: (id: string) => void;
  resumeUpload: (id: string) => Promise<void>;

  startDownload: (url: string, opts: { filename: string; size?: number; mimetype?: string; tray?: boolean }) => Promise<string>;
  abortDownload: (id: string) => void;
  pauseDownload: (id: string) => void;
  resumeDownload: (id: string) => Promise<void>;

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

// Original File/Blob references — keyed by transferId. Survive pause; cleared
// on abort or success. Used for in-session resume when no FileSystemFileHandle exists
// (file picker, paste, or drag-drop on Firefox/Safari). Cross-reload resume still
// requires a handle — that path uses idbHandles.
const liveUploadFiles = new Map<string, Blob>();

// Live download AbortControllers — keyed by transferId. Not serializable, never persisted.
const liveDownloads = new Map<string, AbortController>();

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
    try {
      localStorage.setItem(name, payload);
    } catch (err) {
      console.warn(`[transferStore] persist failed:`, err);
    }
  },
  removeItem: (name) => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(name);
  },
};

export const useTransferStore = create<TransferStore>()(
  persist(
    (set, get) => {
      // DRY helper: keep the reactive `hasInMemoryFile` set in sync with the
      // module-scoped `liveUploadFiles` map. Both call-sites that mutate the map
      // immediately follow up with this so subscribers re-render.
      const setInMemoryRef = (id: string, present: boolean) => {
        set((s) => {
          const has = s.hasInMemoryFile.has(id);
          if (present === has) return s;
          const next = new Set(s.hasInMemoryFile);
          if (present) next.add(id); else next.delete(id);
          return { hasInMemoryFile: next };
        });
      };

      return ({
      transfers: new Map<string, Transfer>(),
      hasInMemoryFile: new Set<string>(),

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

      setAttachmentRef: (id, attachmentId, filename) => set((s) => {
        const t = s.transfers.get(id);
        if (!t) return s;
        const next = new Map(s.transfers);
        next.set(id, { ...t, attachmentId, attachmentFilename: filename });
        return { transfers: next };
      }),

      remove: (id) => {
        liveUploadFiles.delete(id);
        setInMemoryRef(id, false);
        set((s) => {
          if (!s.transfers.has(id)) return s;
          const next = new Map(s.transfers);
          next.delete(id);
          return { transfers: next };
        });
      },

      startUpload: async (file, opts) => {
        const token = getTokenForOrigin(opts.origin ?? '');
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
              get().setAttachmentRef(id, att.id, att.filename);
              get().setState_(id, 'completed');
              get().updateProgress(id, fileLike.size);
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Could not parse upload response';
              get().setError(id, { message: msg, permanent: true });
            } finally {
              liveUploads.delete(id);
              liveUploadFiles.delete(id);
              setInMemoryRef(id, false);
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
        liveUploadFiles.set(id, file);
        setInMemoryRef(id, true);
        upload.start();
        return id;
      },

      abortUpload: (id) => {
        const t = get().get(id);
        const u = liveUploads.get(id);
        if (u) {
          // tus-js-client v4: abort(true) deletes server-side state via DELETE.
          void u.abort(true).catch(() => { /* server may be unreachable; that's OK */ });
          liveUploads.delete(id);
        } else if (t?.tusUploadUrl && !t.attachmentId) {
          // No live instance, but server-side .tus state still exists (e.g., this
          // transfer failed mid-flight or was paused with a stored URL). Send DELETE
          // directly so the partial bytes don't sit on disk until the janitor sweeps.
          const token = getTokenForOrigin(t.origin ?? '');
          if (token) {
            const fullUrl = t.tusUploadUrl.startsWith('http')
              ? t.tusUploadUrl
              : `${t.origin ?? ''}${t.tusUploadUrl}`;
            void fetch(fullUrl, {
              method: 'DELETE',
              headers: {
                Authorization: `Bearer ${token}`,
                'Tus-Resumable': '1.0.0',
              },
            }).catch(() => { /* server unreachable — janitor will eventually clean */ });
          }
        }
        // Keep liveUploadFiles entry — needed for retry-after-abort. Cleared by remove().
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

        const token = getTokenForOrigin(t.origin ?? '');
        if (!token) {
          get().setError(id, { message: 'Not authenticated for this instance', permanent: true });
          return;
        }

        // Try in-memory File (same-session resume — file picker, paste, browsers
        // without getAsFileSystemHandle, or retry after abort).
        let blob: Blob | undefined = liveUploadFiles.get(id);

        // Fall back to persisted FileSystemFileHandle (cross-reload resume on Chrome/Edge).
        if (!blob && t.fileHandleId) {
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
          // No in-memory File (post-reload) AND no FS handle to reacquire bytes from.
          // The user must discard and re-upload. Setting 'failed' lets the orchestrator's
          // mark-failed sweep keep the bubble in failed state and Message.tsx surfaces
          // the discard control. The Retry button is hidden in this case (canRetry gate).
          get().setError(id, {
            message: 'File no longer available — discard and re-upload',
            permanent: true,
          });
          return;
        }

        // Resume the existing tus session if we have a valid, non-expired URL and
        // we weren't aborted. Otherwise start a fresh session reusing this transferId
        // (retry-after-abort, retry-after-failure, retry-after-expiry).
        const canResume =
          !!t.tusUploadUrl &&
          t.state !== 'aborted' &&
          Date.now() <= (t.tusExpiresAt ?? 0);

        if (!canResume) {
          // Reset transient state so a fresh tus session starts cleanly.
          set((s) => {
            const cur = s.transfers.get(id);
            if (!cur) return s;
            const next = new Map(s.transfers);
            next.set(id, {
              ...cur,
              tusUploadUrl: undefined,
              tusExpiresAt: undefined,
              attachmentId: undefined,
              attachmentFilename: undefined,
              error: undefined,
              progress: { loaded: 0, total: blob!.size },
            });
            return { transfers: next };
          });
        }

        get().setState_(id, 'queued');

        const fileLike = blob instanceof File
          ? { name: blob.name, mimetype: blob.type || 'application/octet-stream' }
          : { name: t.file.name, mimetype: blob.type || t.file.mimetype };

        const tusOpts: UploadOptions = {
          endpoint: t.origin ? `${t.origin}/api/files/` : '/api/files/',
          retryDelays: [0, 1000, 3000, 5000, 10_000],
          chunkSize: 5 * 1024 * 1024,
          headers: { Authorization: `Bearer ${token}` },
          ...(canResume
            ? { uploadUrl: t.tusUploadUrl }
            : { metadata: { filename: fileLike.name, filetype: fileLike.mimetype } }),
          onProgress: (loaded: number) => {
            get().updateProgress(id, loaded);
            const cur = get().get(id);
            if (cur?.state !== 'active') get().setState_(id, 'active');
          },
          onAfterResponse: (_req, res) => {
            // Capture the new Location for fresh sessions; resume reuses the existing one.
            if (canResume) return;
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
              get().setAttachmentRef(id, att.id, att.filename);
              get().setState_(id, 'completed');
              get().updateProgress(id, blob!.size);
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'Upload completed but parse failed';
              get().setError(id, { message: msg, permanent: true });
            } finally {
              liveUploads.delete(id);
              liveUploadFiles.delete(id);
              setInMemoryRef(id, false);
            }
          },
          onError: (err: Error) => {
            const msg = err.message ?? 'Upload error';
            const permanent = /\b4\d\d\b/.test(msg);
            get().setError(id, { message: msg, permanent });
            liveUploads.delete(id);
          },
        };

        // Retain the resolved blob in the in-memory map so a subsequent retry-after-failure
        // (e.g., transient network error) can resume without going through the handle path.
        liveUploadFiles.set(id, blob);
        setInMemoryRef(id, true);

        const upload = new Upload(blob as File, tusOpts);
        liveUploads.set(id, upload);
        upload.start();
      },

      startDownload: async (url, opts) => {
        const fileLike = {
          name: opts.filename,
          size: opts.size ?? 0,
          mimetype: opts.mimetype ?? 'application/octet-stream',
        };
        const id = get().createTransfer({
          type: 'download',
          file: fileLike,
          tray: opts.tray ?? true,
          sourceUrl: url,
        });

        const controller = new AbortController();
        liveDownloads.set(id, controller);
        get().setState_(id, 'active');

        // FS Access path: only when the API exists. We DON'T require opts.size —
        // size is unknown for some downloads and we want resume capability anyway.
        const supportsFs = typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';

        try {
          if (supportsFs) {
            const showSavePicker = (window as unknown as {
              showSaveFilePicker: (opts: { suggestedName: string }) => Promise<FileSystemFileHandle>;
            }).showSaveFilePicker;
            let handle: FileSystemFileHandle;
            try {
              handle = await showSavePicker({ suggestedName: opts.filename });
            } catch {
              // User canceled the picker — abort cleanly.
              get().setState_(id, 'aborted');
              liveDownloads.delete(id);
              return id;
            }
            const handleId = `dl-${id}`;
            await putHandle(handleId, handle);
            // Persist the handle key on the transfer.
            set((s) => {
              const t = s.transfers.get(id);
              if (!t) return s;
              const next = new Map(s.transfers);
              next.set(id, { ...t, destFileHandleId: handleId, bytesWrittenToDisk: 0 });
              return { transfers: next };
            });
            const writable = await handle.createWritable({ keepExistingData: false });
            const resp = await fetch(url, { signal: controller.signal });
            if (!resp.ok || !resp.body) throw new Error(`Download failed: ${resp.status}`);
            const reader = resp.body.getReader();
            let written = 0;
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              await writable.write(value);
              written += value.byteLength;
              get().updateProgress(id, written);
              set((s) => {
                const t = s.transfers.get(id);
                if (!t) return s;
                const next = new Map(s.transfers);
                next.set(id, { ...t, bytesWrittenToDisk: written });
                return { transfers: next };
              });
            }
            await writable.close();
            get().setState_(id, 'completed');
          } else {
            // Blob fallback — accumulate in memory, then trigger anchor click.
            const resp = await fetch(url, { signal: controller.signal });
            if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
            const total = Number(resp.headers.get('Content-Length') ?? opts.size ?? 0);
            const chunks: Uint8Array[] = [];
            const reader = resp.body!.getReader();
            let loaded = 0;
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              chunks.push(value);
              loaded += value.byteLength;
              if (total) get().updateProgress(id, loaded);
            }
            const blob = new Blob(chunks as BlobPart[], { type: fileLike.mimetype });
            const objUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objUrl;
            a.download = opts.filename;
            a.click();
            URL.revokeObjectURL(objUrl);
            get().setState_(id, 'completed');
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            // Aborted via abortDownload/pauseDownload — state already set there.
          } else {
            const msg = err instanceof Error ? err.message : 'Download failed';
            const permanent = /\b4\d\d\b/.test(msg);
            get().setError(id, { message: msg, permanent });
          }
        } finally {
          liveDownloads.delete(id);
        }

        return id;
      },

      abortDownload: (id) => {
        const c = liveDownloads.get(id);
        if (c) c.abort();
        liveDownloads.delete(id);
        get().setState_(id, 'aborted');
      },

      pauseDownload: (id) => {
        const c = liveDownloads.get(id);
        if (c) c.abort();
        liveDownloads.delete(id);
        get().setState_(id, 'paused');
      },

      resumeDownload: async (id) => {
        const t = get().get(id);
        if (!t || t.type !== 'download' || !t.sourceUrl) return;
        if (!t.destFileHandleId) {
          get().setError(id, { message: 'No destination handle — cannot resume', permanent: true });
          return;
        }
        const handle = await getHandle(t.destFileHandleId);
        if (!handle) {
          get().setError(id, { message: 'Destination handle missing', permanent: true });
          return;
        }
        const perm = await ensurePermission(handle, 'readwrite');
        if (perm !== 'granted') {
          get().setError(id, { message: 'Permission denied', permanent: false });
          return;
        }
        const handleAny = handle as unknown as {
          getFile?: () => Promise<File>;
          createWritable?: (opts: { keepExistingData: boolean }) => Promise<FileSystemWritableFileStream>;
        };
        const fileNow = await handleAny.getFile!();
        const offset = fileNow.size;
        const writable = await handleAny.createWritable!({ keepExistingData: true });
        await (writable as unknown as { seek: (pos: number) => Promise<void> }).seek(offset);

        const controller = new AbortController();
        liveDownloads.set(id, controller);
        get().setState_(id, 'active');
        try {
          const resp = await fetch(t.sourceUrl, {
            signal: controller.signal,
            headers: { Range: `bytes=${offset}-` },
          });
          if (!resp.ok && resp.status !== 206) throw new Error(`Resume failed: ${resp.status}`);
          const reader = resp.body!.getReader();
          let written = offset;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            await writable.write(value);
            written += value.byteLength;
            get().updateProgress(id, written);
            set((s) => {
              const cur = s.transfers.get(id);
              if (!cur) return s;
              const next = new Map(s.transfers);
              next.set(id, { ...cur, bytesWrittenToDisk: written });
              return { transfers: next };
            });
          }
          await writable.close();
          get().setState_(id, 'completed');
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            get().setState_(id, 'paused');
          } else {
            const msg = err instanceof Error ? err.message : 'Resume failed';
            const permanent = /\b4\d\d\b/.test(msg);
            get().setError(id, { message: msg, permanent });
          }
        } finally {
          liveDownloads.delete(id);
        }
      },

      get: (id) => get().transfers.get(id),
      listVisible: () => Array.from(get().transfers.values()).filter((t) => t.tray),
      listForChannel: (channelId) =>
        Array.from(get().transfers.values()).filter((t) => t.channelId === channelId),
    });
    },
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
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        // Normalize on the next tick so the store is fully wired before we mutate
        // it, and so async work (handle probe + auto-resume) doesn't block the
        // rehydrate path.
        queueMicrotask(() => {
          void normalizeRehydratedTransfers();
        });
      },
    },
  ),
);

/**
 * Boot-time normalization of rehydrated transfers.
 *
 * 1. Demotes any leaked 'active' state to 'paused' (defensive — partialize already
 *    filters most, but a transfer mid-progress can still slip through if it had a
 *    tusUploadUrl).
 * 2. Marks bytes-unrecoverable paused transfers as 'failed' with an actionable
 *    message — we have no in-memory File post-reload and no FS handle to reacquire
 *    bytes from, so showing a paused state would be misleading.
 * 3. For paused transfers with a stored handle whose permission is already
 *    'granted', silently auto-resumes. For 'prompt' / 'denied', leaves paused so
 *    the user's explicit Resume click provides the user-gesture for
 *    `requestPermission`.
 *
 * Idempotent — re-running is harmless.
 */
async function normalizeRehydratedTransfers(): Promise<void> {
  const store = useTransferStore.getState();
  const transfers = Array.from(store.transfers.values());

  for (const t of transfers) {
    // 1) Demote any leaked 'active' state — no live worker exists post-reload.
    if (t.state === 'active') {
      store.setState_(t.id, 'paused');
    }

    const current = useTransferStore.getState().get(t.id);
    if (!current) continue;

    // 2) Bytes-unrecoverable paused transfers → immediately fail.
    if (current.state === 'paused') {
      const isUpload = current.type === 'upload';
      const handleId = isUpload ? current.fileHandleId : current.destFileHandleId;
      if (!handleId) {
        store.setError(current.id, {
          message: isUpload
            ? 'File no longer available — discard and re-upload'
            : 'Download cannot resume — bytes lost. Restart the download.',
          permanent: true,
        });
        continue;
      }

      // 3) Auto-resume when permission is already 'granted'.
      try {
        const handle = await getHandle(handleId);
        if (!handle) {
          store.setError(current.id, {
            message: isUpload
              ? 'File handle missing — discard and re-upload'
              : 'Destination handle missing — restart the download',
            permanent: true,
          });
          continue;
        }
        const mode: 'read' | 'readwrite' = isUpload ? 'read' : 'readwrite';
        const perm = await queryHandlePermission(handle, mode);
        if (perm === 'granted') {
          // Use the live store reference so subsequent state changes are visible
          // to subscribers.
          if (isUpload) {
            void useTransferStore.getState().resumeUpload(current.id);
          } else {
            void useTransferStore.getState().resumeDownload(current.id);
          }
        }
        // perm === 'prompt' or 'denied' → user must click Resume to trigger
        // requestPermission with a user-gesture.
      } catch {
        // Probe failed (IDB unavailable, etc.) — leave paused. User can click
        // Resume to retry through the normal path.
      }
    }
  }
}
