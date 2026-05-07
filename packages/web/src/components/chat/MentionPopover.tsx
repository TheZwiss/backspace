import React, { useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { MemberWithUser } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { useSpaceStore } from '../../stores/spaceStore';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { useUIStore } from '../../stores/uiStore';

const MAX_RESULTS = 8;

function MentionMemberRow({
  member,
  isSelected,
  selectedRef,
  onSelect,
  roleColor,
  mobile,
}: {
  member: MemberWithUser;
  isSelected: boolean;
  selectedRef: React.RefObject<HTMLDivElement>;
  onSelect: (member: MemberWithUser) => void;
  roleColor: string | undefined;
  mobile: boolean;
}) {
  const canonical = useCanonicalUserView(member.user);
  const displayName = canonical.displayName ?? canonical.username;
  // Mobile: ≥44 px tap target per Apple HIG; desktop: compact list.
  const rowSizing = mobile
    ? 'gap-3 px-3 py-2.5 min-h-[44px]'
    : 'gap-2.5 px-2 py-1.5';
  return (
    <div
      ref={isSelected ? selectedRef : undefined}
      onClick={() => onSelect(member)}
      className={`flex items-center mx-1 rounded cursor-pointer transition-colors ${rowSizing} ${
        isSelected ? 'bg-interactive-selected' : 'hover:bg-interactive-hover'
      }`}
    >
      <Avatar
        src={canonical.avatar}
        name={displayName}
        size={mobile ? 28 : 24}
        status={canonical.status}
        userId={canonical.homeUserId ?? canonical.id}
        user={canonical}
      />
      <span
        className={`${mobile ? 'text-[15px]' : 'text-[14px]'} font-medium truncate`}
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

interface ResolvedListProps {
  filtered: MemberWithUser[];
  selectedIndex: number;
  selectedRef: React.RefObject<HTMLDivElement>;
  onSelect: (member: MemberWithUser) => void;
  getMemberColor: (member: MemberWithUser) => string | undefined;
  mobile: boolean;
}

function MemberList({
  filtered,
  selectedIndex,
  selectedRef,
  onSelect,
  getMemberColor,
  mobile,
}: ResolvedListProps) {
  return (
    <>
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
          mobile={mobile}
        />
      ))}
    </>
  );
}

interface DesktopMentionProps extends MentionPopoverProps {
  filtered: MemberWithUser[];
  getMemberColor: (member: MemberWithUser) => string | undefined;
}

function DesktopMention({
  filtered,
  selectedIndex,
  onSelect,
  anchorRef,
  getMemberColor,
}: DesktopMentionProps) {
  const selectedRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);

  const { style } = useFloatingPosition(anchorRef, floatingRef, {
    placement: 'top',
    offset: 4,
    enabled: filtered.length > 0,
  });

  // Scroll selected item into view
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return createPortal(
    <div ref={floatingRef} style={style} className="w-[280px]">
      <div className="glass rounded-lg overflow-hidden max-h-[320px] overflow-y-auto scrollbar-thin">
        <MemberList
          filtered={filtered}
          selectedIndex={selectedIndex}
          selectedRef={selectedRef}
          onSelect={onSelect}
          getMemberColor={getMemberColor}
          mobile={false}
        />
      </div>
    </div>,
    document.body,
  );
}

interface MobileMentionProps extends MentionPopoverProps {
  filtered: MemberWithUser[];
  getMemberColor: (member: MemberWithUser) => string | undefined;
}

function MobileMention({
  filtered,
  selectedIndex,
  onSelect,
  getMemberColor,
}: MobileMentionProps) {
  const selectedRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view as the user types/arrows
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Mention is auto-driven by composer text. Tapping the backdrop should NOT
  // commit a selection; it should simply let the user keep typing. The mention
  // popover dismisses naturally when the @-token is deleted/closed by composer
  // logic. We render a transparent backdrop only to visually scrim, and rely
  // on the composer's own dismissal flow rather than a click-to-close handler.
  return createPortal(
    <>
      <div className="fixed inset-0 z-[300] bg-black/30 pointer-events-none" />
      <div
        className="fixed left-0 right-0 z-[301] rounded-t-2xl glass-modal animate-slide-up-sheet flex flex-col"
        style={{
          bottom: 'env(keyboard-inset-height, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          maxHeight: 'min(50dvh, 50vh)',
        }}
      >
        {/* Drag handle */}
        <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1 shrink-0" />

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          <MemberList
            filtered={filtered}
            selectedIndex={selectedIndex}
            selectedRef={selectedRef}
            onSelect={onSelect}
            getMemberColor={getMemberColor}
            mobile={true}
          />
        </div>
      </div>
    </>,
    document.body,
  );
}

export function MentionPopover({ query, selectedIndex, onSelect, anchorRef }: MentionPopoverProps) {
  const members = useSpaceStore((s) => s.members);
  const spaces = useSpaceStore((s) => s.spaces);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const isMobile = useUIStore((s) => s.isMobile);

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

  if (filtered.length === 0) return null;

  const getMemberColor = (member: MemberWithUser): string | undefined => {
    if (member.roles && member.roles.length > 0) {
      const sorted = [...member.roles].sort((a, b) => b.position - a.position);
      return sorted[0]!.color;
    }
    if (ownerId && member.userId === ownerId) return '#fda4af';
    return undefined;
  };

  if (isMobile) {
    return (
      <MobileMention
        query={query}
        selectedIndex={selectedIndex}
        onSelect={onSelect}
        anchorRef={anchorRef}
        filtered={filtered}
        getMemberColor={getMemberColor}
      />
    );
  }

  return (
    <DesktopMention
      query={query}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      anchorRef={anchorRef}
      filtered={filtered}
      getMemberColor={getMemberColor}
    />
  );
}
