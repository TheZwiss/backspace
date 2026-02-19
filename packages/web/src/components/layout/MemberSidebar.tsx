import React, { useMemo } from 'react';
import type { MemberWithUser } from '@opencord/shared';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';

const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, member: 2 };
const ROLE_LABELS: Record<string, string> = { owner: 'OWNER', admin: 'ADMIN', member: 'MEMBER' };

export function MemberSidebar() {
  const members = useServerStore((s) => s.members);
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const openUserProfile = useUIStore((s) => s.openUserProfile);

  const { roleGroups, offlineMembers } = useMemo(() => {
    const online = members.filter(m => m.user.status !== 'offline');
    const offline = members.filter(m => m.user.status === 'offline');

    // Group online members by role
    const groups = new Map<string, MemberWithUser[]>();
    for (const m of online) {
      const role = m.role || 'member';
      if (!groups.has(role)) groups.set(role, []);
      groups.get(role)!.push(m);
    }

    // Sort groups by role hierarchy
    const sorted = [...groups.entries()].sort(
      (a, b) => (ROLE_ORDER[a[0]] ?? 99) - (ROLE_ORDER[b[0]] ?? 99)
    );

    return { roleGroups: sorted, offlineMembers: offline };
  }, [members]);

  if (!memberListOpen) return null;

  const roleColors: Record<string, string> = {
    owner: 'text-discord-red',
    admin: 'text-discord-blurple',
    member: 'text-discord-text-primary',
  };

  const getMemberColor = (member: MemberWithUser) => {
    if (member.roles && member.roles.length > 0) {
      return { color: member.roles[0]!.color };
    }
    return undefined;
  };

  const handleMemberClick = (e: React.MouseEvent, user: any) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openUserProfile(user, {
      top: Math.min(rect.top, window.innerHeight - 450),
      left: rect.left - 316,
    });
  };

  const renderMember = (member: MemberWithUser, isOffline = false) => {
    const displayName = member.user.displayName ?? member.user.username;
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
            className={`text-[15px] font-medium truncate ${isOffline ? 'text-discord-text-muted' : (!getMemberColor(member) ? (roleColors[member.role] ?? 'text-discord-text-primary') : '')}`}
            style={isOffline ? undefined : getMemberColor(member)}
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
        {roleGroups.map(([role, groupMembers]) => (
          <div key={role} className="mb-4">
            <h3 className="text-[12px] font-bold text-discord-text-muted uppercase tracking-wider px-2 mb-1">
              {ROLE_LABELS[role] ?? role.toUpperCase()} — {groupMembers.length}
            </h3>
            {groupMembers.map((m) => renderMember(m))}
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
