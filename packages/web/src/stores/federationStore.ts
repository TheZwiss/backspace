import { create } from 'zustand';
import type { PeeringSubscription, PeeringNotification } from '@backspace/shared';
import { api } from '../api/client';

/**
 * Outbound peering gate user-facing state.
 *
 * Holds the current user's pending peering subscriptions (rows they own in
 * `peer_approval_subscribers` joined to their parent peering request) and
 * their unread terminal-state notifications. Both lists are scoped to the
 * home instance API client — federation gating is a home-instance concern;
 * remote instances do not surface their own outbound queues to this user.
 *
 * The retry deep-link side-channel (`pendingFriendAddPrefill`) carries the
 * trigger target from a Retry click in the Connections panel into the
 * `AddFriendTab` on the Friends page. The consuming component reads and
 * clears the value on mount.
 */
interface FederationState {
  peeringSubscriptions: PeeringSubscription[];
  peeringNotifications: PeeringNotification[];

  /**
   * Side-channel for the friend-add Retry deep-link. The Connections panel
   * sets this to the original `triggerTarget` (e.g. `alice@orbit.tld`),
   * navigates to the Friends page, and the AddFriendTab consumes + clears
   * it on mount to prefill its query input.
   */
  pendingFriendAddPrefill: string | null;

  refetchPeeringSubscriptions: () => Promise<void>;
  refetchPeeringNotifications: () => Promise<void>;
  cancelPeeringSubscription: (id: string) => Promise<void>;
  markPeeringNotificationRead: (id: string) => Promise<void>;
  markAllPeeringNotificationsRead: () => Promise<void>;

  setPendingFriendAddPrefill: (value: string | null) => void;
  consumePendingFriendAddPrefill: () => string | null;
}

export const useFederationStore = create<FederationState>((set, get) => ({
  peeringSubscriptions: [],
  peeringNotifications: [],
  pendingFriendAddPrefill: null,

  refetchPeeringSubscriptions: async () => {
    try {
      const { subscriptions } = await api.federation.peeringSubscriptions();
      set({ peeringSubscriptions: subscriptions });
    } catch (err) {
      console.error('Failed to load peering subscriptions:', err);
    }
  },

  refetchPeeringNotifications: async () => {
    try {
      // unreadOnly=true — UI only ever shows unread terminal notifications.
      const { notifications } = await api.federation.peeringNotifications(true);
      set({ peeringNotifications: notifications });
    } catch (err) {
      console.error('Failed to load peering notifications:', err);
    }
  },

  cancelPeeringSubscription: async (id) => {
    await api.federation.cancelPeeringSubscription(id);
    // Optimistic local update — the WS `peering_subscription_changed` event
    // will arrive shortly and reconcile, but we drop the row immediately so
    // the UI feels responsive.
    set((state) => ({
      peeringSubscriptions: state.peeringSubscriptions.filter((s) => s.id !== id),
    }));
  },

  markPeeringNotificationRead: async (id) => {
    await api.federation.markPeeringNotificationRead(id);
    set((state) => ({
      peeringNotifications: state.peeringNotifications.filter((n) => n.id !== id),
    }));
  },

  markAllPeeringNotificationsRead: async () => {
    await api.federation.markAllPeeringNotificationsRead();
    set({ peeringNotifications: [] });
  },

  setPendingFriendAddPrefill: (value) => set({ pendingFriendAddPrefill: value }),

  consumePendingFriendAddPrefill: () => {
    const value = get().pendingFriendAddPrefill;
    if (value !== null) {
      set({ pendingFriendAddPrefill: null });
    }
    return value;
  },
}));
