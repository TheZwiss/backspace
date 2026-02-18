import React from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';

export function MemberSidebar() {
  const members = useServerStore((s) => s.members);
  const memberListOpen = useUIStore((s) => s.memberListOpen);

  if (!memberListOpen) return null;

  const onlineMembers = members.filter(m => m.user.status !== 'offline');
  const offlineMembers = members.filter(m => m.user.status === 'offline');

  const roleColors: Record<string, string> = {
    owner: 'text-discord-red',
    admin: 'text-discord-blurple',
    member: 'text-discord-text-primary',
  };

  return (
    <div className="w-60 bg-discord-bg-members flex-shrink-0 overflow-y-auto">
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
                  className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-discord-bg-hover cursor-pointer group"
                >
                  <Avatar
                    src={member.user.avatar}
                    name={displayName}
                    size={32}
                    status={member.user.status}
                  />
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium truncate ${roleColors[member.role] ?? 'text-discord-text-primary'}`}>
                      {displayName}
                    </div>
                    {member.user.customStatus && (
                      <div className="text-xs text-discord-text-muted truncate">{member.user.customStatus}</div>
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
                  className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-discord-bg-hover cursor-pointer group opacity-50"
                >
                  <Avatar
                    src={member.user.avatar}
                    name={displayName}
                    size={32}
                    status="offline"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate text-discord-text-muted">
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
