import React, { useRef } from 'react';
import type { User } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { Username } from '../ui/Username';
import { Tooltip } from '../ui/Tooltip';
import { parseFederatedUsername, isFederationGlobeApplicable } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import {
  useContextMenuStore,
  type ContextMenuItem,
} from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';

export type DmMemberRowAction = 'profile' | 'transfer' | 'kick' | 'remove-friend';

export interface DmMemberRowProps {
  member: User;
  /** True when this row represents the channel owner. */
  isOwner: boolean;
  /** True when this row is the viewer themselves. */
  isSelf: boolean;
  /** True when the viewer is the channel owner (controls transfer/kick visibility). */
  callerIsOwner: boolean;
  /** True when the viewer and this member are friends (controls Remove Friend visibility). */
  isFriend: boolean;
  /** Whether to render the kebab "⋮" trigger button (right side of the row). */
  showKebab?: boolean;
  /** Fired when the viewer activates a menu entry. The component closes the menu itself. */
  onMenuAction: (action: DmMemberRowAction, member: User) => void;
}

// ── Inline icons ─────────────────────────────────────────────────────────────

function GlobeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary/80 flex-shrink-0">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  );
}

function CrownIcon() {
  // Simple inline crown — matches the warm-amber accent used elsewhere for owner emphasis.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="text-accent-amber flex-shrink-0"
      aria-hidden="true"
    >
      <path d="M5 16l-2-9 5 4 4-7 4 7 5-4-2 9H5zm0 2h14v2H5v-2z" />
    </svg>
  );
}

function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function DmMemberRow({
  member,
  isOwner,
  isSelf,
  callerIsOwner,
  isFriend,
  showKebab = false,
  onMenuAction,
}: DmMemberRowProps) {
  const canonical = useCanonicalUserView(member);
  const openContextMenu = useContextMenuStore((s) => s.open);
  const rowRef = useRef<HTMLDivElement>(null);

  const { baseName, domain } = parseFederatedUsername(canonical.username);
  const displayName = canonical.displayName ?? baseName;
  const isOffline = canonical.status === 'offline';
  const showGlobe = isFederationGlobeApplicable(canonical);

  const buildMenuItems = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    items.push({
      key: 'profile',
      type: 'action',
      label: 'View Profile',
      onClick: () => {
        // Anchor the popout to this row's bounding rect — matches the
        // MemberSidebar pattern (see MemberSidebar.tsx:158-165). On mobile
        // the position arg is ignored by the store (full-screen push).
        const rect = rowRef.current?.getBoundingClientRect();
        if (rect) {
          useUIStore.getState().openUserProfile(canonical, {
            top: Math.min(rect.top, window.innerHeight - 450),
            left: rect.left - 316,
          });
        } else {
          // Fallback: defer to the consumer if we can't compute a rect
          // (shouldn't happen in practice, but keeps the contract intact).
          onMenuAction('profile', canonical);
        }
      },
    });

    const showTransfer = callerIsOwner && !isSelf;
    const showKick = callerIsOwner && !isSelf;
    const showRemoveFriend = isFriend && !isSelf;

    if (showTransfer) {
      items.push({
        key: 'transfer',
        type: 'action',
        label: 'Transfer Ownership',
        onClick: () => onMenuAction('transfer', canonical),
      });
    }

    if (showKick) {
      items.push({
        key: 'kick',
        type: 'action',
        label: 'Remove from Group',
        danger: true,
        onClick: () => onMenuAction('kick', canonical),
      });
    }

    if ((showTransfer || showKick) && showRemoveFriend) {
      items.push({ key: 'sep', type: 'separator' });
    }

    if (showRemoveFriend) {
      items.push({
        key: 'remove-friend',
        type: 'action',
        label: 'Remove Friend',
        danger: true,
        onClick: () => onMenuAction('remove-friend', canonical),
      });
    }

    return items;
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu({ x: e.clientX, y: e.clientY }, buildMenuItems());
  };

  const handleKebabClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openContextMenu({ x: rect.right, y: rect.bottom + 4 }, buildMenuItems());
  };

  return (
    <div
      ref={rowRef}
      data-context-menu
      data-dm-member-row
      data-user-id={canonical.id}
      onContextMenu={handleContextMenu}
      className="group flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] hover:bg-interactive-hover transition-colors select-none"
    >
      <div className="flex-shrink-0">
        <Avatar
          src={canonical.avatar}
          name={displayName}
          size={32}
          status={isOffline ? null : canonical.status}
          user={canonical}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Username
            username={displayName}
            className={`text-[13.5px] leading-[1.2] font-medium truncate ${
              isOffline ? 'text-txt-tertiary' : 'text-txt-primary'
            }`}
          />
          {showGlobe && (
            <Tooltip content={canonical.username} position="top">
              <span data-federation-globe className="inline-flex">
                <GlobeIcon />
              </span>
            </Tooltip>
          )}
          {isOwner && (
            <Tooltip content="Group Owner" position="top">
              <span data-owner-crown className="inline-flex">
                <CrownIcon />
              </span>
            </Tooltip>
          )}
        </div>

        {showGlobe && domain && (
          <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate opacity-60">
            @{domain}
          </div>
        )}

        {!isOffline && canonical.customStatus && (
          <div className="text-[11px] leading-[1.3] text-txt-tertiary truncate">
            {canonical.customStatus}
          </div>
        )}
      </div>

      {showKebab && (
        <button
          type="button"
          aria-label="Member actions"
          data-dm-member-kebab
          onClick={handleKebabClick}
          onContextMenu={(e) => {
            // Right-click on the kebab still opens the same menu at cursor.
            handleContextMenu(e);
          }}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-[4px] text-txt-tertiary hover:text-txt-primary hover:bg-interactive-active opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          <KebabIcon />
        </button>
      )}
    </div>
  );
}
