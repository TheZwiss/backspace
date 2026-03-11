import { useInstanceStore, type ConnectedInstance } from '../stores/instanceStore';

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

// ─── Password change propagation ────────────────────────────────────────

/**
 * Change password on all connected remote instances.
 * For federated users, only newPassword is needed (JWT auth is sufficient).
 */
export async function changePasswordOnRemotes(newPassword: string): Promise<FederationOpResult[]> {
  const { instances } = useInstanceStore.getState();
  const connected = instances.filter(i => i.status === 'connected');

  if (connected.length === 0) return [];

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

        return { origin: inst.origin, success: true };
      } catch (err) {
        // Mark as pending sync for later retry
        useInstanceStore.getState().setPendingPasswordSync(inst.origin, true);

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
