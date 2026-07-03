import { useMemo } from 'react';
import { useSpaceStore } from '../stores/spaceStore';
import { parseFederatedUsername } from '../utils/identity';
import { getCanonicalUserView } from '../utils/userViewLookup';
import type { ParticipantInfo } from './useLiveKit';
import type { User } from '@backspace/shared';

/**
 * Resolves display metadata (displayName, avatar, user) for a voice participant
 * by looking up member data from the space/DM stores.
 *
 * Reactive — re-renders when member data changes (e.g. user updates avatar mid-call).
 */
export function useVoiceParticipantMeta(participant: ParticipantInfo) {
  const members = useSpaceStore((s) => s.members);
  const dmChannels = useSpaceStore((s) => s.dmChannels);

  return useMemo(() => {
    // 1. Try space members (primary — covers space voice channels)
    const member = members.find(m => m.userId === participant.userId);
    if (member?.user) {
      const canonical = getCanonicalUserView(member.user as User);
      const { baseName } = parseFederatedUsername(canonical.username);
      return {
        displayName: canonical.displayName ?? baseName,
        avatar: canonical.avatar ?? null,
        user: canonical,
      };
    }

    // 2. Fallback to DM channel members (covers DM calls)
    for (const dm of dmChannels) {
      const dmMember = dm.members?.find(m => m.id === participant.userId);
      if (dmMember) {
        const canonical = getCanonicalUserView(dmMember as User);
        const { baseName } = parseFederatedUsername(canonical.username);
        return {
          displayName: canonical.displayName ?? baseName,
          avatar: canonical.avatar ?? null,
          user: canonical,
        };
      }
    }

    // 3. Fallback to cached user from ParticipantInfo (federation carry-forward).
    // Route through the userViews cache: a User captured from federation handoff
    // can be a stale stub view, and the cache may hold a fresher home view.
    if (participant.cachedUser) {
      const canonical = getCanonicalUserView(participant.cachedUser);
      const { baseName } = parseFederatedUsername(canonical.username);
      return {
        displayName: canonical.displayName ?? baseName,
        avatar: canonical.avatar ?? null,
        user: canonical,
      };
    }

    // 4. Final fallback — parse username from LiveKit identity
    const { baseName } = parseFederatedUsername(participant.username);
    return { displayName: baseName, avatar: null, user: null as User | null };
  }, [members, dmChannels, participant.userId, participant.username, participant.cachedUser]);
}
