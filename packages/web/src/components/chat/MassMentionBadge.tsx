import { useSpaceStore } from '../../stores/spaceStore';

/** Mass mentions are labels, not user-profile links. */
export function MassMentionBadge({ token, channelId }: { token: string; channelId: string | null }) {
  const roles = useSpaceStore(s => s.roles);
  const spaceId = useSpaceStore(s => channelId ? s.channelToSpaceMap.get(channelId) : undefined);
  const role = token.startsWith('&') ? roles.find(r => r.id === token.slice(1) && r.spaceId === spaceId) : undefined;
  return <span className="inline-flex rounded-[3px] px-[2px] font-medium bg-accent-primary/10 text-accent-primary" style={role ? { color: role.color } : undefined}>
    @{role?.name ?? token}
  </span>;
}
