import type { ClientKind } from '@backspace/shared';
import { isElectron } from './platform';

/** Sent once per WebSocket auth so the server can count client kinds by day. Never stored client-side. */
export function detectClientKind(): ClientKind {
  if (isElectron()) return 'desktop';
  if (typeof window !== 'undefined' && window.innerWidth < 768) return 'mobile';
  return 'web';
}
