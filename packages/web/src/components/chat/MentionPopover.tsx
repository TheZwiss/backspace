import React, { useMemo, useRef, useEffect } from 'react';
import type { MemberWithUser } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { useServerStore } from '../../stores/serverStore';

const MAX_RESULTS = 8;

interface MentionPopoverProps {
  query: string;
  selectedIndex: number;
  onSelect: (member: MemberWithUser) => void;
}

export function MentionPopover({ query, selectedIndex, onSelect }: MentionPopoverProps) {
  const members = useServerStore((s) => s.members);
  const servers = useServerStore((s) => s.servers);
  const currentServerId = useServerStore((s) => s.currentServerId);
  const selectedRef = useRef<HTMLDivElement>(null);

  const ownerId = servers.find((s) => s.id === currentServerId)?.ownerId;

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return members
      .filter((m) => {
        const name = (m.user.displayName ?? m.user.username).toLowerCase();
        const username = m.user.username.toLowerCase();
        return name.includes(q) || username.includes(q);
      })
      .slice(0, MAX_RESULTS);
  }, [members, query]);

  // Scroll selected item into view
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  const getMemberColor = (member: MemberWithUser): string | undefined => {
    if (member.roles && member.roles.length > 0) {
      const sorted = [...member.roles].sort((a, b) => b.position - a.position);
      return sorted[0]!.color;
    }
    if (ownerId && member.userId === ownerId) return '#fda4af';
    return undefined;
  };

  return (
    <div className="absolute bottom-full left-0 w-[280px] mb-1 z-50">
      <div className="bg-surface-elevated rounded-lg shadow-[0_0_0_1px_rgba(0,0,0,0.15),0_8px_16px_rgba(0,0,0,0.24)] overflow-hidden max-h-[320px] overflow-y-auto scrollbar-thin">
        <div className="px-2 py-1.5 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
          Members
        </div>
        {filtered.map((member, i) => {
          const displayName = member.user.displayName ?? member.user.username;
          const roleColor = getMemberColor(member);
          const isSelected = i === selectedIndex;

          return (
            <div
              key={member.userId}
              ref={isSelected ? selectedRef : undefined}
              onClick={() => onSelect(member)}
              className={`flex items-center gap-2.5 px-2 py-1.5 mx-1 rounded cursor-pointer transition-colors ${
                isSelected ? 'bg-interactive-selected' : 'hover:bg-interactive-hover'
              }`}
            >
              <Avatar
                src={member.user.avatar}
                name={displayName}
                size={24}
                status={member.user.status}
                userId={member.user.id}
              />
              <span
                className="text-[14px] font-medium truncate"
                style={roleColor ? { color: roleColor } : undefined}
              >
                {displayName}
              </span>
              {member.user.displayName && (
                <span className="text-[12px] text-txt-tertiary truncate">
                  @{member.user.username}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
