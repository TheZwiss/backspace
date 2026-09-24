import { useSyncExternalStore } from 'react';
import type { InstanceInfoResponse } from '@backspace/shared';
import { api } from '../api/client';

/**
 * The home instance's public info (`GET /api/instance/info`), shared by every
 * surface of the Backspace page: the sidebar item, the mobile row, the You
 * tab and the page itself. They read the version and `supportCardEnabled`
 * only through this hook, so they never disagree about either.
 *
 * Fetch rule: whenever a subscriber mounts while there is no cached value and
 * no request in flight, one request starts on the home API client and every
 * concurrent subscriber shares it. A success is cached for the session. A
 * failure leaves null and nothing in flight, and nothing retries on a timer:
 * the next subscriber mount (opening the page, for example) tries again. On
 * desktop the sidebar stays mounted, so after a failure its dot stays off
 * until a page mount or a reload; losing a dot is the safe failure.
 *
 * The older ad-hoc readers of this endpoint (`UserSettings`, `ExplorePage`,
 * the auth pages, the admin panels) keep their own requests; `ExplorePage`
 * rereads once per mount on purpose.
 */

let cached: InstanceInfoResponse | null = null;
let inFlight: Promise<void> | null = null;
/**
 * Bumped by every invalidation. A request remembers the generation it started
 * in and drops its answer if that has moved on, so a response already in
 * flight when an admin saved cannot land the pre-save values over the reread.
 */
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function fetchIfNeeded(): void {
  if (cached !== null || inFlight !== null) return;
  const startedIn = generation;
  inFlight = api.instance.info().then(
    (info) => {
      if (startedIn !== generation) return;
      cached = info;
      inFlight = null;
      emit();
    },
    () => {
      if (startedIn !== generation) return;
      inFlight = null;
    },
  );
}

/**
 * Subscribing is mounting, so this is where the fetch rule runs. React calls
 * it once per mounted subscriber; the stable module-level identity means it is
 * not called again on re-render.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  fetchIfNeeded();
  return () => { listeners.delete(listener); };
}

function getSnapshot(): InstanceInfoResponse | null {
  return cached;
}

export function useHomeInstanceInfo(): InstanceInfoResponse | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Drops the cached info and, if anything is subscribed, rereads it at once.
 * `GeneralPanel` calls this after a successful save, so turning the Support
 * card off shows on the page without a reload.
 */
export function invalidateHomeInstanceInfo(): void {
  generation += 1;
  cached = null;
  inFlight = null;
  emit();
  if (listeners.size > 0) fetchIfNeeded();
}

/** Test-only: forget everything, including subscribers a failed test left behind. */
export function __resetHomeInstanceInfoForTests(): void {
  generation += 1;
  cached = null;
  inFlight = null;
  listeners.clear();
}
