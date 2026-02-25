import React from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';

interface MentionBadgeProps {
  userId: string;
}

export const MentionBadge = React.memo(function MentionBadge({ userId }: MentionBadgeProps) {
  const members = useServerStore((s) => s.members);
  const servers = useServerStore((s) => s.servers);
  const currentServerId = useServerStore((s) => s.currentServerId);
  const openUserProfile = useUIStore((s) => s.openUserProfile);

  const member = members.find((m) => m.userId === userId);
  const server = servers.find((s) => s.id === currentServerId);
  const ownerId = server?.ownerId;

  let displayName: string;
  let color: string;

  if (member) {
    displayName = member.user.displayName ?? member.user.username;
    if (member.roles && member.roles.length > 0) {
      const sorted = [...member.roles].sort((a, b) => b.position - a.position);
      color = sorted[0]!.color;
    } else if (ownerId && userId === ownerId) {
      color = '#f23f43';
    } else {
      color = '#5865f2'; // blurple default
    }
  } else {
    displayName = 'Unknown User';
    color = '#a3a6aa'; // muted fallback
  }

  const handleClick = (e: React.MouseEvent) => {
    if (!member) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openUserProfile(member.user, {
      top: Math.min(rect.top, window.innerHeight - 450),
      left: rect.right + 8,
    });
  };

  // Build inline styles: role-colored text with tinted background
  const bgColor = color + '1a'; // ~10% opacity hex

  return (
    <span
      onClick={handleClick}
      className="inline-flex items-center rounded-[3px] px-[2px] font-medium cursor-pointer transition-colors hover:brightness-125"
      style={{ color, backgroundColor: bgColor }}
    >
      @{displayName}
    </span>
  );
});
