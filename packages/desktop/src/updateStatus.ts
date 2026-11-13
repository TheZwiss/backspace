import type { UpdateCapability } from './updateCapability';
import { isVersionDismissed } from './updateDismissal';

/**
 * The one place that says where a user is sent to fetch a build by hand.
 * Shared by the main process notification, the recovery surface, and the
 * renderer toast so the three cannot drift apart.
 */
export const RELEASES_URL = 'https://github.com/TheZwiss/backspace/releases/latest';

/**
 * Where the updater currently is.
 *
 * This replaces the two independent booleans the renderer used to hold. Those
 * could disagree: a stale "downloaded" outranked a fresh "failed" purely because
 * it was checked first in the render, which is why an install failure stayed
 * invisible until the user dismissed the toast in front of it. A single value
 * that every event replaces wholesale makes that class of bug unrepresentable.
 */
export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; version: string | null; message: string }
  | { phase: 'up-to-date'; checkedAt: number };

/**
 * Everything the renderer needs to render the update surfaces.
 *
 * `capability` and `dismissedVersion` are ambient facts about the install;
 * `status` is the event-driven part. They travel together so the renderer never
 * has to correlate two channels, and so a dismissed update stays *visible* in
 * settings while being *silent* in the toast. Suppressing it in the main process
 * instead would make a dismissed update unreachable, which is what would turn
 * "Later" into "never".
 */
export interface UpdateSnapshot {
  capability: UpdateCapability;
  dismissedVersion: string | null;
  status: UpdateStatus;
}

const INITIAL_STATUS: UpdateStatus = { phase: 'idle' };

/**
 * The version a status is about, or null when the phase carries no version.
 * `failed` may legitimately carry none, because a check can fail before any
 * version is known.
 */
export function statusVersion(status: UpdateStatus): string | null {
  switch (status.phase) {
    case 'available':
    case 'downloading':
    case 'ready':
      return status.version;
    case 'failed':
      return status.version;
    default:
      return null;
  }
}

/**
 * Whether this snapshot warrants interrupting the user.
 *
 * Both the in-app toast and the native notification ask this exact function, so
 * the two cannot disagree about whether the user has already said "later".
 *
 * `checking`, `downloading` and `up-to-date` are settings-panel states. They are
 * progress, not news, and a chat client has no business throwing a card over the
 * message list to report them.
 */
export function shouldPromptForUpdate(snapshot: UpdateSnapshot): boolean {
  if (snapshot.capability === 'external') return false;
  const { status } = snapshot;
  if (status.phase !== 'available' && status.phase !== 'ready' && status.phase !== 'failed') {
    return false;
  }
  const version = statusVersion(status);
  if (version === null) {
    // A check that failed before it learned a version. There is nothing
    // actionable to offer, so stay quiet and leave it to the settings panel.
    return false;
  }
  return !isVersionDismissed(version, snapshot.dismissedVersion);
}

/**
 * Whether the renderer should offer a Restart button for this snapshot.
 *
 * The renderer never reasons about code signing. It asks this, and this asks the
 * capability the main process measured.
 */
export function canInstallInPlace(snapshot: UpdateSnapshot): boolean {
  return snapshot.capability === 'auto' && snapshot.status.phase === 'ready';
}

export class UpdateStatusStore {
  private snapshot: UpdateSnapshot;
  private listeners = new Set<(s: UpdateSnapshot) => void>();

  constructor(capability: UpdateCapability, dismissedVersion: string | null) {
    this.snapshot = Object.freeze({
      capability,
      dismissedVersion,
      status: INITIAL_STATUS,
    });
  }

  get(): Readonly<UpdateSnapshot> {
    return this.snapshot;
  }

  /** Replaces the status wholesale. Latest event always wins. */
  setStatus(status: UpdateStatus): void {
    this.commit({ ...this.snapshot, status });
  }

  setDismissedVersion(version: string | null): void {
    this.commit({ ...this.snapshot, dismissedVersion: version });
  }

  subscribe(cb: (s: UpdateSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private commit(next: UpdateSnapshot): void {
    // Frozen for the same reason RecoveryStateStore freezes: get() hands out a
    // live reference and Readonly<> is only a compile-time hint.
    this.snapshot = Object.freeze(next);
    const listeners = Array.from(this.listeners);
    for (const cb of listeners) {
      try {
        cb(this.snapshot);
      } catch (err) {
        console.error('[update] status listener threw:', err);
      }
    }
  }
}
