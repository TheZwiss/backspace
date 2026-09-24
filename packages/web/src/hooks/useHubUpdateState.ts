import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { hubUpdateState, useProjectHubStore, type HubUpdateState } from '../stores/projectHubStore';
import { browserHubStorage, readHubSeenVersion } from '../utils/hubSeenVersion';
import { useHomeInstanceInfo } from './useHomeInstanceInfo';

/**
 * Whether the home instance has updated since the signed-in user last opened
 * the Backspace page, and the version it runs (null while unknown).
 *
 * Every surface that shows the dot or the What's new text calls this. Nothing
 * else compares versions for that purpose.
 *
 * A first run marks the running version seen straight away, so a new user,
 * and every existing user on the day the page ships, sees no dot; the first
 * dot appears at the next update.
 */
export function useHubUpdateState(): { state: HubUpdateState; version: string | null } {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const load = useProjectHubStore((s) => s.load);
  const loadedUserId = useProjectHubStore((s) => s.userId);
  const loadedSeenVersion = useProjectHubStore((s) => s.seenVersion);
  const version = useHomeInstanceInfo()?.version ?? null;

  // Between a sign-in (or an account switch) and the load effect below, the
  // store still holds the previous user's record. Reading this user's record
  // directly for that one render keeps the previous user's value from showing
  // a wrong dot or, worse, reading as this user's first run.
  const seenVersion = loadedUserId === userId
    ? loadedSeenVersion
    : readHubSeenVersion(browserHubStorage, userId);
  const state = hubUpdateState(seenVersion, version);

  useEffect(() => {
    load(userId);
  }, [load, userId]);

  useEffect(() => {
    if (state !== 'first-run' || version === null || userId === null) return;
    // Re-derived from the store as it is now, after the load effect above
    // ran, so the write can only go to this user's record and only when this
    // user has none.
    const current = useProjectHubStore.getState();
    if (current.userId !== userId) return;
    if (hubUpdateState(current.seenVersion, version) !== 'first-run') return;
    current.markSeen(version);
  }, [state, version, userId]);

  return { state, version };
}
