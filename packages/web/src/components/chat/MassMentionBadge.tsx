import { useSpaceStore } from '../../stores/spaceStore';

/** Mass mentions are labels, not user-profile links. */
export function MassMentionBadge({ token }: { token: string }) {
  const roles = useSpaceStore(s => s.roles);
  const role = token.startsWith('&') ? roles.find(r => r.id === token.slice(1)) : undefined;
  return <span className="inline-flex rounded-[3px] px-[2px] font-medium bg-accent-primary/10 text-accent-primary" style={role ? { color: role.color } : undefined}>
    @{role?.name ?? token}
  </span>;
}
