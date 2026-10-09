import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Avatar } from '../ui/Avatar';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { userDisplayName } from '../../utils/identity';
import { useUIStore } from '../../stores/uiStore';
import type { ChannelUser } from '../../utils/channelUser';

function MentionMemberRow({
  candidate,
  isSelected,
  selectedRef,
  onSelect,
  mobile,
}: {
  candidate: ChannelUser;
  isSelected: boolean;
  selectedRef: React.RefObject<HTMLDivElement>;
  onSelect: (candidate: ChannelUser) => void;
  mobile: boolean;
}) {
  const canonical = useCanonicalUserView(candidate.user, candidate.origin);
  const roleColor = candidate.nameColor;
  const displayName = userDisplayName(canonical);
  // The username is the second label whenever it says more than the name:
  // a display name is set, or the name is the base of a federated username.
  const showUsername = canonical.username !== displayName;
  // Mobile: ≥44 px tap target per Apple HIG; desktop: compact list.
  const rowSizing = mobile
    ? 'gap-3 px-3 py-2.5 min-h-[44px]'
    : 'gap-2.5 px-2 py-1.5';
  return (
    <div
      ref={isSelected ? selectedRef : undefined}
      onClick={() => onSelect(candidate)}
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
      {/* The name keeps its width while the username has any to give: the
          username truncates first, and the name only once it alone is wider
          than the row. The spacing is padding inside the username's clipping
          box, so a username squeezed to nothing takes its gap with it. */}
      <div className="flex items-center min-w-0 flex-1">
        <span
          className={`${mobile ? 'text-[15px]' : 'text-[14px]'} font-medium shrink-0 max-w-full truncate`}
          style={roleColor ? { color: roleColor } : undefined}
        >
          {displayName}
        </span>
        {showUsername && (
          <span className="flex min-w-0 overflow-hidden">
            <span className={`text-[12px] text-txt-tertiary min-w-0 truncate ${mobile ? 'pl-3' : 'pl-2.5'}`}>
              @{canonical.username}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

interface MentionPopoverProps {
  /**
   * The channel's matching candidates, already filtered and capped
   * (`filterMentionCandidates`). The composer owns the list so its keyboard
   * navigation and this popover index the same rows.
   */
  candidates: ChannelUser[];
  selectedIndex: number;
  onSelect: (candidate: ChannelUser) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

interface ResolvedListProps {
  candidates: ChannelUser[];
  selectedIndex: number;
  selectedRef: React.RefObject<HTMLDivElement>;
  onSelect: (candidate: ChannelUser) => void;
  mobile: boolean;
}

function MemberList({
  candidates,
  selectedIndex,
  selectedRef,
  onSelect,
  mobile,
}: ResolvedListProps) {
  const { t } = useTranslation(['chat', 'common']);
  return (
    <>
      <div className="px-2 py-1.5 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
        {t('common:labels.members')}
      </div>
      {candidates.map((candidate, i) => (
        <MentionMemberRow
          key={candidate.userId}
          candidate={candidate}
          isSelected={i === selectedIndex}
          selectedRef={selectedRef}
          onSelect={onSelect}
          mobile={mobile}
        />
      ))}
    </>
  );
}

function DesktopMention({
  candidates,
  selectedIndex,
  onSelect,
  anchorRef,
}: MentionPopoverProps) {
  const selectedRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);

  const { style } = useFloatingPosition(anchorRef, floatingRef, {
    placement: 'top',
    align: 'start',
    offset: 4,
    enabled: candidates.length > 0,
  });

  // Scroll selected item into view
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return createPortal(
    <div ref={floatingRef} style={style} className="w-[280px]">
      <div className="glass rounded-lg overflow-hidden max-h-[320px] overflow-y-auto scrollbar-thin">
        <MemberList
          candidates={candidates}
          selectedIndex={selectedIndex}
          selectedRef={selectedRef}
          onSelect={onSelect}
          mobile={false}
        />
      </div>
    </div>,
    document.body,
  );
}

function MobileMention({
  candidates,
  selectedIndex,
  onSelect,
}: MentionPopoverProps) {
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
          bottom: 'var(--keyboard-inset)',
          paddingBottom: 'var(--safe-bottom)',
          maxHeight: 'min(calc(50*var(--app-dvh)), calc(50*var(--app-vh)))',
        }}
      >
        {/* Drag handle */}
        <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1 shrink-0" />

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          <MemberList
            candidates={candidates}
            selectedIndex={selectedIndex}
            selectedRef={selectedRef}
            onSelect={onSelect}
            mobile={true}
          />
        </div>
      </div>
    </>,
    document.body,
  );
}

export function MentionPopover({ candidates, selectedIndex, onSelect, anchorRef }: MentionPopoverProps) {
  const isMobile = useUIStore((s) => s.isMobile);

  if (candidates.length === 0) return null;

  if (isMobile) {
    return (
      <MobileMention
        candidates={candidates}
        selectedIndex={selectedIndex}
        onSelect={onSelect}
        anchorRef={anchorRef}
      />
    );
  }

  return (
    <DesktopMention
      candidates={candidates}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
      anchorRef={anchorRef}
    />
  );
}
