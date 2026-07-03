import { useInstanceStore } from '../stores/instanceStore';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface FederationOpResult {
  origin: string;
  success: boolean;
  error?: string;
}

// ─── Retry helper ────────────────────────────────────────────────────────

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelay = 2000,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}

// ─── Background retry state ─────────────────────────────────────────────

/** Active retry timers per origin — cleared on new password change or logout */
const activeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Cancel any active retry loop for the given origin */
function cancelRetryTimer(origin: string): void {
  const timer = activeRetryTimers.get(origin);
  if (timer) {
    clearTimeout(timer);
    activeRetryTimers.delete(origin);
  }
}

/** Cancel all active retry loops (called on logout) */
export function clearPasswordSyncTimers(): void {
  for (const timer of activeRetryTimers.values()) {
    clearTimeout(timer);
  }
  activeRetryTimers.clear();
}

/**
 * Schedule background retries for a failed password sync.
 * Retry schedule: every 30s for 5 min, then every 5 min for 1 hour.
 */
function scheduleBackgroundRetry(
  origin: string,
  newPassword: string,
): void {
  // Build the retry schedule: [delayMs, ...]
  const schedule: number[] = [
    ...Array(10).fill(30_000),    // 10 × 30s = 5 min
    ...Array(12).fill(300_000),   // 12 × 5min = 60 min
  ];

  let attempt = 0;

  function tryNext(): void {
    if (attempt >= schedule.length) {
      // Exhausted — mark as pending and stop
      useInstanceStore.getState().setPendingPasswordSync(origin, true);
      activeRetryTimers.delete(origin);
      return;
    }

    const delay = schedule[attempt]!;
    attempt++;

    const timer = setTimeout(async () => {
      try {
        // Look up current instance from store — the original reference may be
        // stale (token refreshed, instance reconnected) after minutes/hours
        const current = useInstanceStore.getState().instances.find(i => i.origin === origin);
        if (!current || current.status !== 'connected') {
          // Instance was removed or disconnected — stop retrying
          activeRetryTimers.delete(origin);
          return;
        }

        const response = await current.api.users.changePassword({ newPassword });
        useInstanceStore.getState().updateInstanceToken(origin, response.token);
        useInstanceStore.getState().setPendingPasswordSync(origin, false);
        activeRetryTimers.delete(origin);
      } catch {
        // Still failing — schedule next attempt
        tryNext();
      }
    }, delay);

    activeRetryTimers.set(origin, timer);
  }

  tryNext();
}

// ─── Password change propagation ────────────────────────────────────────

/**
 * Change password on all connected remote instances.
 * For federated users, only newPassword is needed (JWT auth is sufficient).
 * Failed instances get background retry scheduling.
 */
export async function changePasswordOnRemotes(newPassword: string): Promise<FederationOpResult[]> {
  const { instances } = useInstanceStore.getState();
  const connected = instances.filter(i => i.status === 'connected');

  if (connected.length === 0) return [];

  // Cancel any existing retry loops for these origins (handles rapid password changes)
  for (const inst of connected) {
    cancelRetryTimer(inst.origin);
  }

  const results = await Promise.allSettled(
    connected.map(async (inst): Promise<FederationOpResult> => {
      try {
        const response = await retryWithBackoff(
          () => inst.api.users.changePassword({ newPassword }),
          3,
          2000,
        );

        // Update the cached token for this instance
        useInstanceStore.getState().updateInstanceToken(inst.origin, response.token);
        useInstanceStore.getState().setPendingPasswordSync(inst.origin, false);

        return { origin: inst.origin, success: true };
      } catch (err) {
        // Initial retries failed — start background retry scheduler.
        // Pass origin (not the ConnectedInstance) so the retry loop looks up
        // the current instance from the store at each attempt, avoiding stale references.
        scheduleBackgroundRetry(inst.origin, newPassword);

        return {
          origin: inst.origin,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    })
  );

  return results.map(r => r.status === 'fulfilled' ? r.value : { origin: '', success: false, error: 'Unexpected error' });
}

// ─── Account deletion propagation ───────────────────────────────────────

/**
 * Delete account on all connected remote instances (best-effort).
 * For federated users on remotes, password verification is skipped server-side.
 */
export async function deleteAccountOnRemotes(): Promise<FederationOpResult[]> {
  const { instances } = useInstanceStore.getState();
  const connected = instances.filter(i => i.status === 'connected');

  if (connected.length === 0) return [];

  const results = await Promise.allSettled(
    connected.map(async (inst): Promise<FederationOpResult> => {
      try {
        await inst.api.users.deleteAccount({
          password: '', // Not needed for federated users
          username: inst.username,
        });
        return { origin: inst.origin, success: true };
      } catch (err) {
        return {
          origin: inst.origin,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    })
  );

  return results.map(r => r.status === 'fulfilled' ? r.value : { origin: '', success: false, error: 'Unexpected error' });
}
