import type { InstanceUpdateStatus } from '@backspace/shared';

/**
 * Per-admin, per-browser record of what has already been acknowledged about an
 * available instance update.
 *
 * Two acknowledgements, deliberately kept apart:
 *
 *  - `toastShownFor` is written when the toast is SHOWN, not when it is
 *    dismissed. The toast model cannot distinguish a dismissal from its own
 *    5-second timeout, so "shown at most once per version per browser" is the
 *    only guarantee it can actually honour.
 *  - `seenVersion` is written when the admin opens the Updates panel, and is
 *    what clears the dot.
 *
 * Stored per user id, following the precedent at `stores/instanceStore.ts`
 * (`backspace_instances_<userId>`), so two admins sharing a browser do not
 * silence each other's dot. localStorage is already origin-partitioned and the
 * Electron renderer loads each instance by URL, so two instances never share a
 * record.
 *
 * Every access is wrapped: a browser in private mode throws on access, and the
 * right failure there is to show the dot again rather than to break the render.
 */

const STORAGE_KEY_PREFIX = 'backspace_update_ack';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export interface UpdateAck {
  /** Latest version whose Updates panel the admin has opened. Clears the dot. */
  seenVersion: string | null;
  /** Latest version the toast has been shown for. Suppresses a repeat toast. */
  toastShownFor: string | null;
}

export const EMPTY_ACK: UpdateAck = { seenVersion: null, toastShownFor: null };

export function ackStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}_${userId}`;
}

export function readUpdateAck(storage: Store, userId: string | null): UpdateAck {
  if (userId === null) return EMPTY_ACK;
  try {
    const raw = storage.getItem(ackStorageKey(userId));
    if (raw === null) return EMPTY_ACK;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null
      && (typeof (parsed as UpdateAck).seenVersion === 'string' || (parsed as UpdateAck).seenVersion === null)
      && (typeof (parsed as UpdateAck).toastShownFor === 'string' || (parsed as UpdateAck).toastShownFor === null)
    ) {
      return parsed as UpdateAck;
    }
  } catch {
    /* storage unavailable or corrupt: behave as never acknowledged */
  }
  return EMPTY_ACK;
}

export function writeUpdateAck(storage: Store, userId: string | null, ack: UpdateAck): void {
  if (userId === null) return;
  try {
    storage.setItem(ackStorageKey(userId), JSON.stringify(ack));
  } catch {
    /* private mode: the dot returns next session, which is the safe failure */
  }
}

/**
 * The version an admin should be told about, or null.
 *
 * Guarded on `state` rather than on `latest` alone. `latest !== null` with
 * `state: 'unknown'` is reachable — the server reports `unknown` when the
 * RUNNING version fails to parse, even though it successfully read a release —
 * and badging off `latest` there would nag an operator the server cannot
 * actually compare. This mirrors `UpdatesPanel`'s own `updateAvailable` guard.
 */
export function pendingUpdateVersion(status: InstanceUpdateStatus | null): string | null {
  if (status === null) return null;
  if (status.state !== 'update-available') return null;
  return status.latest?.version ?? null;
}

export function shouldBadgeUpdate(
  status: InstanceUpdateStatus | null,
  ack: UpdateAck,
  isAdmin: boolean,
): boolean {
  if (!isAdmin) return false;
  const version = pendingUpdateVersion(status);
  return version !== null && ack.seenVersion !== version;
}

export function shouldToastUpdate(
  status: InstanceUpdateStatus | null,
  ack: UpdateAck,
  isAdmin: boolean,
): boolean {
  if (!isAdmin) return false;
  const version = pendingUpdateVersion(status);
  return version !== null && ack.toastShownFor !== version;
}
