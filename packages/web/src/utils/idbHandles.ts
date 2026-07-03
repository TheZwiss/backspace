import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'backspace-transfers';
const STORE = 'fs-handles';
const VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      },
    });
  }
  return dbPromise;
}

/** Store a FileSystemFileHandle (or any structured-cloneable handle) under a key. */
export async function putHandle(key: string, handle: FileSystemHandle): Promise<void> {
  const db = await getDB();
  await db.put(STORE, handle, key);
}

/** Retrieve a stored handle, or undefined if not present. */
export async function getHandle(key: string): Promise<FileSystemHandle | undefined> {
  const db = await getDB();
  return db.get(STORE, key);
}

/** Delete a stored handle. No-op if missing. */
export async function deleteHandle(key: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE, key);
}

/** Wipe every handle from the store. Used in tests and on logout. */
export async function clearAllHandles(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE);
}

/** True iff the browser exposes the FS Access file picker (Chrome/Edge). */
export function supportsFsHandles(): boolean {
  return typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function';
}

/** True iff DataTransferItem.getAsFileSystemHandle is available (Chrome/Edge drag-drop). */
export function supportsDnDHandles(): boolean {
  return typeof DataTransferItem !== 'undefined'
    && typeof (DataTransferItem.prototype as unknown as { getAsFileSystemHandle?: unknown }).getAsFileSystemHandle === 'function';
}

/**
 * Silently query the current permission state on a stored handle.
 * Never prompts; returns whatever the browser reports right now. Used by the
 * boot-time rehydrate path so we can auto-resume only when permission is
 * already 'granted' and avoid a "user gesture required" failure for 'prompt'.
 */
export async function queryHandlePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite',
): Promise<PermissionState> {
  const handleAny = handle as unknown as {
    queryPermission?: (opts: { mode: string }) => Promise<PermissionState>;
  };
  if (typeof handleAny.queryPermission !== 'function') return 'denied';
  return handleAny.queryPermission({ mode });
}

/**
 * Re-prompt for permission on a stored handle. Returns 'granted', 'denied', or 'prompt'.
 * Some non-standard FS Access surfaces don't expose `queryPermission`/`requestPermission` —
 * if missing, returns 'denied' so callers fall back to re-pick.
 */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: 'read' | 'readwrite',
): Promise<PermissionState> {
  const opts = { mode };
  const handleAny = handle as unknown as {
    queryPermission?: (opts: { mode: string }) => Promise<PermissionState>;
    requestPermission?: (opts: { mode: string }) => Promise<PermissionState>;
  };
  if (typeof handleAny.queryPermission !== 'function') return 'denied';
  const current = await handleAny.queryPermission(opts);
  if (current === 'granted') return 'granted';
  if (typeof handleAny.requestPermission !== 'function') return 'denied';
  return handleAny.requestPermission(opts);
}
