import type { MemberWithUser } from '@backspace/shared';
import { useSpaceStore } from './spaceStore';

/** HTTP replies and socket broadcasts share the same space/instance boundary. */
export function applySpaceMemberUpdate(origin: string, member: MemberWithUser): void {
  const state = useSpaceStore.getState();
  const space = state.spaces.find(s => s.id === member.spaceId && s._instanceOrigin === origin);
  if (!space || state.currentSpaceId !== member.spaceId) return;
  useSpaceStore.setState({
    members: state.members.map(existing => existing.userId === member.userId
      // Profile/presence have their own live events; a database snapshot must not overwrite them.
      ? { ...existing, nickname: member.nickname, roles: member.roles }
      : existing),
  });
}
