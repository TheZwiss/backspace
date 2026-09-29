import { useActivityStore } from '../stores/activityStore';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { useDiscoverStore } from '../stores/discoverStore';
import { useSocialStore } from '../stores/socialStore';
import { applySpaceMemberUpdate } from '../stores/spaceMemberUpdates';
import { getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';
import { normalizeUserAssets } from '../utils/assetUrls';
import { presenceSubjectOf } from '../utils/presenceSubject';
import { ownStatusReport } from '../utils/selfStatus';
import type { WebSocketEventHandlers } from './webSocketEvents';

function isLoadedRosterSpace(spaceId: string, origin: string): boolean {
  const { currentSpaceId, spaces } = useSpaceStore.getState();
  if (spaceId !== currentSpaceId) return false;
  return (spaces.find(s => s.id === spaceId)?._instanceOrigin ?? '') === origin;
}

export const memberEvents = {
  presence_update: (origin, event) => {
    const isHome = origin === '';
    const { updateMemberPresence } = useSpaceStore.getState();
    // The owner's report of the user's own status, e.g. a change made on
    // another device (utils/selfStatus.ts); feeds the alert gate.
    const report = ownStatusReport(useAuthStore.getState().user, { origin, isHome }, event);
    if (report) useAuthStore.getState().applyOwnStatus(report);
    // Members, friends and activities are keyed by the subject's home
    // identity, so a replicated row's delivery and the home's native
    // delivery agree (#340), and a same-id row of another instance is not
    // mistaken for them.
    const subject = presenceSubjectOf(event, origin);
    updateMemberPresence(subject, origin, event.status);
    useSocialStore.getState().updateFriendPresence(subject, origin, event.status);
    if (event.activities) {
      useActivityStore.getState().setUserActivities(subject, origin, event.activities);
    }
  },
  user_updated: (origin, event) => {
    const isHome = origin === '';
    const { setUser } = useAuthStore.getState();
    const { upsertUserView } = useSpaceStore.getState();
    if (!isHome) normalizeUserAssets(event.user, origin);
    upsertUserView(event.user, origin);
    useSpaceStore.getState().updateUserEverywhere(event.user);
    useSocialStore.getState().updateFriendProfile(event.user);
    useChatStore.getState().updateUserInMessages(event.user);
    // If this is the current user (other tab changed profile), update authStore
    const myId = isHome
      ? useAuthStore.getState().user?.id
      : getMyUserIdForOrigin(origin);
    if (event.user.id === myId && isHome) {
      // Self-deletion detected on another tab — log out
      if (event.user.isDeleted) {
        useAuthStore.getState().logout();
        return;
      }
      setUser(event.user);
    }
    {
      // The true home's row of a replicated session carries the choice too.
      const report = ownStatusReport(useAuthStore.getState().user, { origin, isHome }, { userId: event.user.id, status: event.user.status });
      if (report) useAuthStore.getState().applyOwnStatus(report);
    }

    // Deleted user cleanup: remove from caches the existing pipeline doesn't cover
    if (event.user.isDeleted) {
      useSocialStore.getState().removeFriendLocally(event.user.id, origin);
      useSocialStore.getState().removeRequestsForUser(event.user.id);
      useActivityStore.getState().clearUserActivities(event.user, origin);
      useDiscoverStore.getState().removeUser(event.user.id);
      useChatStore.getState().clearTypingForUser(event.user.id);
    }
  },
  member_joined: (origin, event) => {
    const isHome = origin === '';
    const { addMember, upsertUserView } = useSpaceStore.getState();
    if (!isHome) normalizeUserAssets(event.member.user, origin);
    upsertUserView(event.member.user, origin);
    if (isLoadedRosterSpace(event.spaceId, origin)) addMember(event.spaceId, event.member);
  },
  member_left: (origin, event) => {
    const { removeMember } = useSpaceStore.getState();
    if (isLoadedRosterSpace(event.spaceId, origin)) removeMember(event.spaceId, event.userId);
  },
  member_banned: (origin, event) => {
    // The current user has been banned from a space — remove it from the sidebar
    const { removeSpace: rmSpace } = useSpaceStore.getState();
    rmSpace(event.spaceId);
  },
  member_updated: (origin, event) => {
    if (event.spaceId === event.member.spaceId) applySpaceMemberUpdate(origin, event.member);
  },
} satisfies WebSocketEventHandlers;
