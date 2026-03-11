import { useMemo } from 'react';
import { useSpaceStore } from '../stores/spaceStore';
import { parseFederatedUsername } from '../utils/identity';
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
      const { baseName } = parseFederatedUsername(member.user.username);
      return {
        displayName: member.user.displayName ?? baseName,
        avatar: member.user.avatar ?? null,
        user: member.user as User,
      };
    }

    // 2. Fallback to DM channel members (covers DM calls)
    for (const dm of dmChannels) {
      const dmMember = dm.members?.find(m => m.id === participant.userId);
      if (dmMember) {
        const { baseName } = parseFederatedUsername(dmMember.username);
        return {
          displayName: dmMember.displayName ?? baseName,
          avatar: dmMember.avatar ?? null,
          user: dmMember as User,
        };
      }
    }

    // 3. Final fallback — parse username from LiveKit identity
    const { baseName } = parseFederatedUsername(participant.username);
    return { displayName: baseName, avatar: null, user: null as User | null };
  }, [members, dmChannels, participant.userId, participant.username]);
}
