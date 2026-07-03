import { useState, useCallback } from 'react';
import { useInstanceStore, DifferentPasswordError } from '../stores/instanceStore';

/**
 * Reusable hook for connecting to a federated instance.
 * Handles both new connections (probeInstance → connectToRemote)
 * and reconnections (reauthenticateInstance).
 *
 * All permanent state is delegated to instanceStore.
 * This hook only holds ephemeral UI state.
 */
export function useInstanceConnect() {
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const connect = useCallback(async (domain: string, password: string): Promise<'new' | 'reconnect'> => {
    setIsConnecting(true);
    setError(null);

    try {
      const store = useInstanceStore.getState();
      // Determine if instance already exists in the store (disconnected/errored)
      const existing = store.instances.find(i => {
        try { return new URL(i.origin).host === domain; } catch { return false; }
      });

      if (existing) {
        // Reconnect path: instance exists but is disconnected/errored
        await store.reauthenticateInstance(existing.origin, password);
        return 'reconnect';
      } else {
        // New connection path: probe → connect
        const probeResult = await store.probeInstance(domain);
        await store.connectToRemote(probeResult.origin, password);
        return 'new';
      }
    } catch (err) {
      let message: string;
      if (err instanceof DifferentPasswordError) {
        message = 'An account already exists on this instance with a different password. Enter the password for that account.';
      } else if (err instanceof Error) {
        message = err.message;
      } else {
        message = 'Connection failed';
      }
      setError(message);
      throw err;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  return { connect, isConnecting, error, clearError };
}
