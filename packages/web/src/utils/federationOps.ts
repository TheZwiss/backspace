import { useInstanceStore } from '../stores/instanceStore';
import { translate } from '../i18n';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface FederationOpResult {
  origin: string;
  success: boolean;
  error?: string;
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
          error: err instanceof Error ? err.message : translate('runtime.selected.federationOps.unknownError2'),
        };
      }
    })
  );

  return results.map(r => r.status === 'fulfilled' ? r.value : { origin: '', success: false, error: translate('runtime.selected.federationOps.unexpectedError2') });
}
