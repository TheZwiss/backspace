import type { FederationPeerStatusReason } from '@backspace/shared';
import i18n from '../i18n';

/**
 * The toast text for a `federation_peer_rejected` event: why messages to the
 * peer are not delivered, localized from the event's `reasonCode`. A server
 * that predates the code sends only English `reason` text, and a newer one may
 * send a code this client does not know; the fallback line carries the
 * server's text for both.
 */
export function peerRejectedToast(event: {
  peerOrigin: string;
  peerLabel?: string;
  reason: string;
  reasonCode?: FederationPeerStatusReason;
}): string {
  const name = event.peerLabel || event.peerOrigin.replace(/^https?:\/\//, '');
  switch (event.reasonCode) {
    case 'auth_failures': return i18n.t('federation:peerRejected.auth_failures', { name });
    case 'peer_reset_detected': return i18n.t('federation:peerRejected.peer_reset_detected', { name });
    case 'repeer_incomplete': return i18n.t('federation:peerRejected.repeer_incomplete', { name });
    case 'denied_by_local_admin': return i18n.t('federation:peerRejected.denied_by_local_admin', { name });
    case 'denied_by_remote': return i18n.t('federation:peerRejected.denied_by_remote', { name });
    case 'revoked_by_remote': return i18n.t('federation:peerRejected.revoked_by_remote', { name });
    case 'expired_on_remote': return i18n.t('federation:peerRejected.expired_on_remote', { name });
    case 'stale_peering_on_remote': return i18n.t('federation:peerRejected.stale_peering_on_remote', { name });
    default: return i18n.t('federation:peerRejected.fallback', { name, reason: event.reason });
  }
}
