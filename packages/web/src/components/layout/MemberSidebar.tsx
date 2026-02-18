import React from 'react';
import type { MemberWithUser } from '@opencord/shared';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';

export function MemberSidebar() {
  const members = useServerStore((s) => s.members);
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const openUserProfile = useUIStore((s) => s.openUserProfile);

  if (!memberListOpen) return null;

  const onlineMembers = members.filter(m => m.user.status !== 'offline');
  const offlineMembers = members.filter(m => m.user.status === 'offline');

  const roleColors: Record<string, string> = {
    owner: 'text-discord-red',
    admin: 'text-discord-blurple',
    member: 'text-discord-text-primary',
  };

  const getMemberColor = (member: MemberWithUser) => {
    if (member.roles && member.roles.length > 0) {
      // Return the color of the first role (already sorted by position)
      return { color: member.roles[0]!.color };
    }
    return undefined;
  };

  const handleMemberClick = (e: React.MouseEvent, user: any) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openUserProfile(user, {
      top: Math.min(rect.top, window.innerHeight - 450),
      left: rect.left - 316, // Open to the left of member sidebar
    });
  };

  return (
    <div className="w-60 bg-discord-bg-members flex-shrink-0 overflow-y-auto select-none no-scrollbar">
      <div className="p-3">
        {/* Online */}
        {onlineMembers.length > 0 && (
          <div className="mb-4">
            <h3 className="text-xs font-semibold text-discord-text-muted uppercase tracking-wide px-2 mb-1">
              Online — {onlineMembers.length}
            </h3>
            {onlineMembers.map((member) => {
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
                    status={member.user.status}
                  />
                  <div className="flex-1 min-w-0">
                    <div 
                      className={`text-[15px] font-medium truncate ${!getMemberColor(member) ? (roleColors[member.role] ?? 'text-discord-text-primary') : ''}`}
                      style={getMemberColor(member)}
                    >
                      {displayName}
                    </div>
                    {member.user.customStatus && (
                      <div className="text-[12px] text-discord-text-muted truncate">{member.user.customStatus}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Offline */}
        {offlineMembers.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-discord-text-muted uppercase tracking-wide px-2 mb-1">
              Offline — {offlineMembers.length}
            </h3>
            {offlineMembers.map((member) => {
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
                    status="offline"
                    className="opacity-60"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-medium truncate text-discord-text-muted">
                      {displayName}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
