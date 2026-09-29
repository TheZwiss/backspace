import { useFederationStore } from '../stores/federationStore';
import { useUIStore } from '../stores/uiStore';
import type { WebSocketEventHandlers } from './webSocketEvents';

export const rejectedPeerOrigins = new Set<string>();

export function getRejectedPeerOrigins(): Set<string> {
  return rejectedPeerOrigins;
}

export const awaitingApprovalPeerOrigins = new Set<string>();

export function getAwaitingApprovalPeerOrigins(): Set<string> {
  return awaitingApprovalPeerOrigins;
}

// Active peer origins — allowlist for processing DM events from remote instances.
// Only DMs from peered origins (or the home instance) are processed.
export const activePeerOrigins = new Set<string>();

export function getActivePeerOrigins(): Set<string> {
  return activePeerOrigins;
}

// ─── Federation change listeners (for real-time panel updates) ───────────────
const federationChangeListeners = new Set<() => void>();

export function onFederationPeersChanged(cb: () => void): () => void {
  federationChangeListeners.add(cb);
  return () => { federationChangeListeners.delete(cb); };
}

export function notifyFederationChangeListeners(): void {
  for (const cb of federationChangeListeners) cb();
}

export const federationPeerResetDetectedListeners = new Set<(origin: string) => void>();

export function onFederationPeerResetDetected(cb: (origin: string) => void): () => void {
  federationPeerResetDetectedListeners.add(cb);
  return () => { federationPeerResetDetectedListeners.delete(cb); };
}

export const federationEvents = {
  federation_file_rejected: (origin, event) => {
    const { addToast } = useUIStore.getState();
    const users = event.affectedUsers;
    if (users && users.length > 0) {
      const parts = users.map(u => {
        const limitMb = Math.round(u.limit / (1024 * 1024));
        return `${u.username}'s instance (limit: ${limitMb} MB)`;
      });
      const msg = `File couldn't be cached on ${parts.join(' and ')}. They can still view it from yours.`;
      addToast(msg, 'warning', 7000);
    }
  },
  federation_peer_rejected: (origin, event) => {
    const { addToast } = useUIStore.getState();
    rejectedPeerOrigins.add(event.peerOrigin);
    awaitingApprovalPeerOrigins.delete(event.peerOrigin);
    activePeerOrigins.delete(event.peerOrigin);
    const label = event.peerLabel || event.peerOrigin;
    addToast(
      `Cannot relay messages to ${label} — ${event.reason}`,
      'warning',
      10000,
    );
    notifyFederationChangeListeners();
  },
  federation_peer_active: (origin, event) => {
    rejectedPeerOrigins.delete(event.peerOrigin);
    awaitingApprovalPeerOrigins.delete(event.peerOrigin);
    activePeerOrigins.add(event.peerOrigin);
    notifyFederationChangeListeners();
  },
  federation_peers_changed: (origin, event) => {
    notifyFederationChangeListeners();
  },
  federation_peer_reset_detected: (origin, event) => {
    for (const cb of federationPeerResetDetectedListeners) cb(event.origin);
  },
  federation_approval_request_received: (origin, event) => {
    notifyFederationChangeListeners();
  },
  peering_subscription_changed: (origin, event) => {
    // The user's pending peering-subscription set changed (admin approved/
    // denied/expired the parent request, or the user cancelled a row from
    // another tab). Refetch — the server is the source of truth.
    void useFederationStore.getState().refetchPeeringSubscriptions();
  },
  peering_notification_received: (origin, event) => {
    // Terminal-state outcome arrived for one of the user's outbound peering
    // requests. Refetch the notifications list and surface a transient
    // toast — the inline list in the Connections panel is the persistent
    // surface; the toast is opportunistic for online users.
    void useFederationStore.getState().refetchPeeringNotifications();
    const message =
      event.kind === 'approved'
        ? 'Your peering request was approved'
        : event.kind === 'denied'
          ? 'Your peering request was denied'
          : 'Your peering request expired';
    // uiStore exposes 'info' | 'warning' | 'success' — use 'success' for
    // approved, 'warning' for denied/expired (no error severity exists).
    const severity: 'success' | 'warning' = event.kind === 'approved' ? 'success' : 'warning';
    useUIStore.getState().addToast(message, severity, 4500);
  },
} satisfies WebSocketEventHandlers;
