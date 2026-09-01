import { useEffect, useRef } from 'react';
import { useInstanceStore, type ConnectedInstance } from '../stores/instanceStore';
import { useUIStore } from '../stores/uiStore';
import { translate } from '../i18n';

/**
 * Watches instanceStore for status changes on remote instances and fires
 * toast notifications when connections are lost or restored.
 */
export function useFederationToasts() {
  const instances = useInstanceStore((s) => s.instances);
  const addToast = useUIStore((s) => s.addToast);
  const prevStatuses = useRef<Map<string, ConnectedInstance['status']>>(new Map());

  useEffect(() => {
    const prev = prevStatuses.current;

    for (const inst of instances) {
      const prevStatus = prev.get(inst.origin);
      if (prevStatus === undefined) {
        // First time seeing this instance — record but don't toast
        continue;
      }
      if (prevStatus === inst.status) continue;

      const label = inst.label || (() => { try { return new URL(inst.origin).host; } catch { return inst.origin; } })();

      if (
        prevStatus === 'connected' &&
        (inst.status === 'disconnected' || inst.status === 'error')
      ) {
        addToast(translate('runtime.manual.lostConnectionReconnecting', { label }), 'warning');
      } else if (
        (prevStatus === 'disconnected' || prevStatus === 'error' || prevStatus === 'connecting') &&
        inst.status === 'connected'
      ) {
        addToast(translate('runtime.manual.reconnectedTo', { label }), 'success');
      }
    }

    // Update prev statuses
    const next = new Map<string, ConnectedInstance['status']>();
    for (const inst of instances) {
      next.set(inst.origin, inst.status);
    }
    prevStatuses.current = next;
  }, [instances, addToast]);
}
