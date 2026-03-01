import React, { useMemo } from 'react';
import type { MemberWithUser } from '@backspace/shared';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';

/**
 * Derives the display group for a member based on their highest-positioned role
 * or owner status. Returns { key, label, color, position }.
 */
function getMemberGroup(member: MemberWithUser, ownerId: string | undefined) {
  if (ownerId && member.userId === ownerId) {
    // Owner always sorts first — position Infinity so it's above all roles
    const ownerRole = member.roles?.find(r => r.position > 0);
    return {
      key: '__owner__',
      label: 'OWNER',
      color: ownerRole?.color ?? '#f23f43',
      position: Infinity,
    };
  }
  if (member.roles && member.roles.length > 0) {
    // Sort by position descending — highest position = most important role
    const sorted = [...member.roles].sort((a, b) => b.position - a.position);
    const top = sorted[0]!;
    return {
      key: top.id,
      label: top.name.toUpperCase(),
      color: top.color,
      position: top.position,
    };
  }
  // No explicit roles — just @everyone
  return {
    key: '__online__',
    label: 'ONLINE',
    color: undefined,
    position: -1,
  };
}

export function MemberSidebar() {
  const members = useServerStore((s) => s.members);
  const servers = useServerStore((s) => s.servers);
  const currentServerId = useServerStore((s) => s.currentServerId);
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const openUserProfile = useUIStore((s) => s.openUserProfile);

  const server = servers.find(s => s.id === currentServerId);
  const ownerId = server?.ownerId;

  const { roleGroups, offlineMembers } = useMemo(() => {
    const online = members.filter(m => m.user.status !== 'offline');
    const offline = members.filter(m => m.user.status === 'offline');

    // Group online members by their highest role
    const groups = new Map<string, { label: string; color: string | undefined; position: number; members: MemberWithUser[] }>();
    for (const m of online) {
      const group = getMemberGroup(m, ownerId);
      if (!groups.has(group.key)) {
        groups.set(group.key, { label: group.label, color: group.color, position: group.position, members: [] });
      }
      groups.get(group.key)!.members.push(m);
    }

    // Sort groups by position descending (highest role first), then ONLINE last
    const sorted = [...groups.entries()].sort(
      (a, b) => b[1].position - a[1].position
    );

    return { roleGroups: sorted, offlineMembers: offline };
  }, [members, ownerId]);

  if (!memberListOpen) return null;

  const getMemberColor = (member: MemberWithUser): React.CSSProperties | undefined => {
    if (member.roles && member.roles.length > 0) {
      const sorted = [...member.roles].sort((a, b) => b.position - a.position);
      return { color: sorted[0]!.color };
    }
    if (ownerId && member.userId === ownerId) {
      return { color: '#f23f43' };
    }
    return undefined;
  };

  const handleMemberClick = (e: React.MouseEvent, user: MemberWithUser['user']) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openUserProfile(user, {
      top: Math.min(rect.top, window.innerHeight - 450),
      left: rect.left - 316,
    });
  };

  const renderMember = (member: MemberWithUser, isOffline = false) => {
    const displayName = member.user.displayName ?? member.user.username;
    const colorStyle = isOffline ? undefined : getMemberColor(member);
    return (
      <div
        key={member.userId}
        onClick={(e) => handleMemberClick(e, member.user)}
        className="flex items-center gap-3 px-2 py-1.5 rounded-[4px] hover:bg-discord-modifier-hover cursor-pointer group transition-colors"
      >
        <Avatar
          src={member.user.avatar}
          name={displayName}
          size={32}
          status={isOffline ? 'offline' : member.user.status}
          className={isOffline ? 'opacity-60' : undefined}
        />
        <div className="flex-1 min-w-0">
          <div
            className={`text-[15px] font-medium truncate ${isOffline ? 'text-discord-text-muted' : (!colorStyle ? 'text-discord-text-primary' : '')}`}
            style={colorStyle}
          >
            {displayName}
          </div>
          {!isOffline && member.user.customStatus && (
            <div className="text-[12px] text-discord-text-muted truncate">{member.user.customStatus}</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-60 bg-discord-bg-members flex-shrink-0 overflow-y-auto select-none no-scrollbar">
      <div className="p-3">
        {/* Role-based groups */}
        {roleGroups.map(([key, group]) => (
          <div key={key} className="mb-4">
            <h3 className="text-[12px] font-bold text-discord-text-muted uppercase tracking-wider px-2 mb-1">
              {group.label} — {group.members.length}
            </h3>
            {group.members.map((m) => renderMember(m))}
          </div>
        ))}

        {/* Offline */}
        {offlineMembers.length > 0 && (
          <div>
            <h3 className="text-[12px] font-bold text-discord-text-muted uppercase tracking-wider px-2 mb-1">
              OFFLINE — {offlineMembers.length}
            </h3>
            {offlineMembers.map((m) => renderMember(m, true))}
          </div>
        )}
      </div>
    </div>
  );
}
