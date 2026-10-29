import type { Activity } from '@backspace/shared';
import { useActivityStore } from '../stores/activityStore';
import { syncManualBindings } from './manualGameBinding';
import { boundGames } from '../utils/gameOverrides';

let unsubscribe: (() => void) | null = null;

/** What a desktop client sends: a list, or (older builds) one activity or null. */
export function toActivityList(value: unknown): Activity[] {
  if (Array.isArray(value)) return value.filter((item): item is Activity => !!item && typeof item === 'object');
  return value && typeof value === 'object' ? [value as Activity] : [];
}

/**
 * The desktop's current detected activities, from whichever channel this
 * build has: the list channel, or the single-activity one of older builds.
 */
export function fetchCurrentActivities(): Promise<Activity[]> {
  const bridge = window.backspace;
  if (!bridge) return Promise.resolve([]);
  if (bridge.getCurrentActivities) return bridge.getCurrentActivities().then(toActivityList);
  if (bridge.getCurrentActivity) return bridge.getCurrentActivity().then(toActivityList);
  return Promise.resolve([]);
}

export function initActivityBridge(): void {
  if (unsubscribe) return; // already initialized
  const bridge = window.backspace;
  if (!bridge?.onActivityDetected) return; // not Electron

  // Subscribe to future changes. A desktop that knows several games sends the
  // list; an older one only the first activity. Listening to one channel keeps
  // a new desktop from pushing the same state twice.
  const push = (value: unknown) => useActivityStore.getState().pushActivities(toActivityList(value));
  unsubscribe = bridge.onActivitiesDetected
    ? bridge.onActivitiesDetected(push)
    : bridge.onActivityDetected(push);

  // The desktop forgets the binding with its process: hand it over again
  const bound = boundGames(useActivityStore.getState().manualGames ?? []);
  if (bound.length > 0) syncManualBindings(bound);

  // Request current state (handles instance-switch: game was already running)
  fetchCurrentActivities().then((activities) => {
    if (activities.length > 0) useActivityStore.getState().pushActivities(activities);
  }).catch(() => {});
}

export function teardownActivityBridge(): void {
  unsubscribe?.();
  unsubscribe = null;
}
