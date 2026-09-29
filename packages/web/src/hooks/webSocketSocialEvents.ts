import type { User } from '@backspace/shared';
import { useSocialStore } from '../stores/socialStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { normalizeUserAssets } from '../utils/assetUrls';
import type { WebSocketEventHandlers } from './webSocketEvents';

export const socialEvents = {
  friend_request_received: (origin, event) => {
    const isHome = origin === '';
    const { upsertUserView } = useSpaceStore.getState();
    if (!isHome && event.request.user) normalizeUserAssets(event.request.user, origin);
    if (event.request.user) upsertUserView(event.request.user, origin);
    const { addIncomingRequest } = useSocialStore.getState();
    addIncomingRequest(event.request, origin);
  },
  friend_request_sent: (origin, event) => {
    const isHome = origin === '';
    const { upsertUserView } = useSpaceStore.getState();
    // Multi-tab sync: another tab/device of the same user just created an outbound request.
    if (!isHome && event.request.user) normalizeUserAssets(event.request.user, origin);
    if (event.request.user) upsertUserView(event.request.user, origin);
    const { addOutboundRequest } = useSocialStore.getState();
    addOutboundRequest(event.request, origin);
  },
  friend_request_relay_failed: (origin, event) => {
    // Async rollback notification: the federated friend_request_create was permanently rejected.
    // Drop the optimistic row and surface a warning toast.
    const { removeRequestById } = useSocialStore.getState();
    removeRequestById(event.requestId, origin);
    const { addToast } = useUIStore.getState();
    addToast(
      `Friend request to ${event.targetHandle} could not be delivered: ${event.message}`,
      'warning',
    );
  },
  friend_request_accepted: (origin, event) => {
    const isHome = origin === '';
    const { upsertUserView } = useSpaceStore.getState();
    if (!isHome) normalizeUserAssets(event.friend, origin);
    // Friend carries the identity fields the cache needs; cast to User for upsert.
    upsertUserView(event.friend as unknown as User, origin);
    const { addFriendFromAccepted } = useSocialStore.getState();
    addFriendFromAccepted(event.friend, event.requestId, origin);
    import('../stores/discoverStore').then(({ useDiscoverStore }) => {
      useDiscoverStore.getState().updateRelationship(event.friend.id, origin, 'friends');
    });
  },
  friend_removed: (origin, event) => {
    const { removeFriendLocally } = useSocialStore.getState();
    removeFriendLocally(event.userId, origin);
    import('../stores/discoverStore').then(({ useDiscoverStore }) => {
      useDiscoverStore.getState().updateRelationship(event.userId, origin, 'none');
    });
  },
  friend_request_cancelled: (origin, event) => {
    const { removeRequestById } = useSocialStore.getState();
    removeRequestById(event.requestId, origin, event.userId);
    import('../stores/discoverStore').then(({ useDiscoverStore }) => {
      useDiscoverStore.getState().updateRelationship(event.userId, origin, 'none');
    });
  },
  friend_request_declined: (origin, event) => {
    const { removeRequestById } = useSocialStore.getState();
    removeRequestById(event.requestId, origin, event.userId);
    import('../stores/discoverStore').then(({ useDiscoverStore }) => {
      useDiscoverStore.getState().updateRelationship(event.userId, origin, 'none');
    });
  },
} satisfies WebSocketEventHandlers;
