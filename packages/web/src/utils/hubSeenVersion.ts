/**
 * Per-user, per-browser record of the last instance version this user saw on
 * the Backspace page. Comparing it with the running version is what lights
 * the "updated" dot (`hubUpdateState` in `stores/projectHubStore.ts`).
 *
 * Stored per user id, following `utils/updateAck.ts` and the precedent at
 * `stores/instanceStore.ts` (`backspace_instances_<userId>`), so two accounts
 * sharing a browser do not clear each other's dot. localStorage is already
 * origin-partitioned and the Electron renderer loads each instance by URL, so
 * two instances never share a record.
 *
 * Every access is wrapped: a browser in private mode throws on access, and the
 * right failure there is to read as "never seen" rather than to break the
 * render. Losing the value costs at most one extra dot.
 */

const STORAGE_KEY_PREFIX = 'backspace_hub_seen_version';

type HubStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface StoredRecord {
  seenVersion: string;
}

/**
 * The browser's localStorage, resolved on every call rather than captured.
 * Some private modes throw on the `localStorage` lookup itself, not only on
 * `getItem`, and resolving it here puts that lookup inside the `try` of
 * whichever function below is calling.
 */
export const browserHubStorage: HubStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};

export function hubSeenVersionKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}_${userId}`;
}

export function readHubSeenVersion(storage: HubStorage, userId: string | null): string | null {
  if (userId === null) return null;
  try {
    const raw = storage.getItem(hubSeenVersionKey(userId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null
      && typeof (parsed as StoredRecord).seenVersion === 'string'
      && (parsed as StoredRecord).seenVersion !== ''
    ) {
      return (parsed as StoredRecord).seenVersion;
    }
  } catch {
    /* storage unavailable or corrupt: behave as never seen */
  }
  return null;
}

export function writeHubSeenVersion(storage: HubStorage, userId: string | null, version: string): void {
  if (userId === null) return;
  try {
    const record: StoredRecord = { seenVersion: version };
    storage.setItem(hubSeenVersionKey(userId), JSON.stringify(record));
  } catch {
    /* private mode: the value lives in memory for this session only */
  }
}
