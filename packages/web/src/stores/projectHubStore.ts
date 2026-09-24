import { create } from 'zustand';
import { browserHubStorage, readHubSeenVersion, writeHubSeenVersion } from '../utils/hubSeenVersion';

/**
 * Whether the home instance has updated since the signed-in user last opened
 * the Backspace page.
 *
 * The sidebar item, the mobile row, the mobile You tab and the page all read
 * this through `useHubUpdateState`, never by comparing versions themselves.
 */
export type HubUpdateState = 'unknown' | 'first-run' | 'current' | 'updated';

/**
 * The one derived view of the seen record against the running version.
 *
 * | version | seenVersion        | result      | dot |
 * |---------|--------------------|-------------|-----|
 * | null    | any                | `unknown`   | no  |
 * | known   | null               | `first-run` | no  |
 * | known   | equal to version   | `current`   | no  |
 * | known   | different          | `updated`   | yes |
 *
 * "Different", not "older": a rollback is news to the user as well, and the
 * version strings of forks and dev builds do not order.
 */
export function hubUpdateState(seenVersion: string | null, version: string | null): HubUpdateState {
  if (version === null) return 'unknown';
  if (seenVersion === null) return 'first-run';
  return seenVersion === version ? 'current' : 'updated';
}

interface ProjectHubState {
  /** User id the value below belongs to; null before sign-in. */
  userId: string | null;
  /** Last version this user saw on the Backspace page; null when none recorded. */
  seenVersion: string | null;
  /** Load the stored value for `userId` (no-op when it is already loaded). */
  load: (userId: string | null) => void;
  /** Record `version` as seen for the loaded user, in memory and in storage. */
  markSeen: (version: string) => void;
}

export const useProjectHubStore = create<ProjectHubState>()((set, get) => ({
  userId: null,
  seenVersion: null,

  load: (userId) => {
    if (get().userId === userId) return;
    set({ userId, seenVersion: readHubSeenVersion(browserHubStorage, userId) });
  },

  markSeen: (version) => {
    const { userId, seenVersion } = get();
    if (userId === null || seenVersion === version) return;
    writeHubSeenVersion(browserHubStorage, userId, version);
    set({ seenVersion: version });
  },
}));
