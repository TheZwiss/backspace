import React, { useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { MemberWithUser } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { useSpaceStore } from '../../stores/spaceStore';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { useCanonicalUserView } from '../../utils/userViewLookup';

const MAX_RESULTS = 8;

function MentionMemberRow({
  member,
  isSelected,
  selectedRef,
  onSelect,
  roleColor,
}: {
  member: MemberWithUser;
  isSelected: boolean;
  selectedRef: React.RefObject<HTMLDivElement>;
  onSelect: (member: MemberWithUser) => void;
  roleColor: string | undefined;
}) {
  const canonical = useCanonicalUserView(member.user);
  const displayName = canonical.displayName ?? canonical.username;
  return (
    <div
      ref={isSelected ? selectedRef : undefined}
      onClick={() => onSelect(member)}
      className={`flex items-center gap-2.5 px-2 py-1.5 mx-1 rounded cursor-pointer transition-colors ${
        isSelected ? 'bg-interactive-selected' : 'hover:bg-interactive-hover'
      }`}
    >
      <Avatar
        src={canonical.avatar}
        name={displayName}
        size={24}
        status={canonical.status}
        userId={canonical.homeUserId ?? canonical.id}
        user={canonical}
      />
      <span
        className="text-[14px] font-medium truncate"
        style={roleColor ? { color: roleColor } : undefined}
      >
        {displayName}
      </span>
      {canonical.displayName && (
        <span className="text-[12px] text-txt-tertiary truncate">
          @{canonical.username}
        </span>
      )}
    </div>
  );
}

interface MentionPopoverProps {
  query: string;
  selectedIndex: number;
  onSelect: (member: MemberWithUser) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function MentionPopover({ query, selectedIndex, onSelect, anchorRef }: MentionPopoverProps) {
  const members = useSpaceStore((s) => s.members);
  const spaces = useSpaceStore((s) => s.spaces);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const selectedRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);

  const ownerId = spaces.find((s) => s.id === currentSpaceId)?.ownerId;

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

  const { style } = useFloatingPosition(anchorRef, floatingRef, {
    placement: 'top',
    offset: 4,
    enabled: filtered.length > 0,
  });

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

  return createPortal(
    <div ref={floatingRef} style={style} className="w-[280px]">
      <div className="glass rounded-lg overflow-hidden max-h-[320px] overflow-y-auto scrollbar-thin">
        <div className="px-2 py-1.5 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
          Members
        </div>
        {filtered.map((member, i) => (
          <MentionMemberRow
            key={member.userId}
            member={member}
            isSelected={i === selectedIndex}
            selectedRef={selectedRef}
            onSelect={onSelect}
            roleColor={getMemberColor(member)}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}
