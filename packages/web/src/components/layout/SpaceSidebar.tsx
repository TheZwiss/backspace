import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSpaceStore, getMyUserIdForOrigin } from '../../stores/spaceStore';
import type { TaggedSpace } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { useContextMenuStore, type ContextMenuItem } from '../../stores/contextMenuStore';
import { Tooltip } from '../ui/Tooltip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { TransferOwnershipModal } from '../modals/TransferOwnershipModal';
import type { SpaceLayoutItem, SpaceFolder } from '@backspace/shared';

import { getSpaceGradient } from '../../utils/gradients';
import { isElectron } from '../../platform/platform';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';

// ─── Resolved layout types ─────────────────────────────────────────────────

type ResolvedItem =
  | { type: 'space'; space: TaggedSpace }
  | { type: 'folder'; folder: SpaceFolder; spaces: TaggedSpace[] };

// ─── Folder color presets ─────────────────────────────────────────────────

const FOLDER_COLORS = [
  { name: 'mint', value: '#86efac' },
  { name: 'peach', value: '#fbbf93' },
  { name: 'lavender', value: '#c4b5fd' },
  { name: 'sky', value: '#7dd3fc' },
  { name: 'amber', value: '#fcd34d' },
  { name: 'rose', value: '#fda4af' },
  { name: 'coral', value: '#fb7185' },
];

// ─── SidebarItem ─────────────────────────────────────────────────────────

interface SidebarItemProps {
  id: string;
  name: string;
  icon?: string | null;
  avatarColor?: string | null;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  type?: 'space' | 'dm' | 'action';
  actionType?: 'add' | 'join' | 'explore';
  hasUnread?: boolean;
  dimmed?: boolean;
  federationBadge?: boolean;
  federationDisconnected?: boolean;
  tooltipText?: string;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDrop?: (e: React.DragEvent) => void;
  isDragging?: boolean;
  dropIndicator?: 'before' | 'after' | 'merge' | null;
}

function SidebarItem({ id, name, icon, avatarColor, active, onClick, onContextMenu, type = 'space', actionType, hasUnread, dimmed, federationBadge, federationDisconnected, tooltipText, draggable, onDragStart, onDragOver, onDragEnd, onDrop, isDragging, dropIndicator }: SidebarItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const firstLetter = name.charAt(0).toUpperCase();

  const getPillHeight = () => {
    if (active) return 'h-8';
    if (isHovered) return 'h-4';
    if (hasUnread && !active) return 'h-2';
    return 'h-2 scale-0';
  };

  const backgroundStyle = useMemo((): React.CSSProperties | undefined => {
    if (type === 'action') {
      return {
        background: isHovered ? 'rgba(134, 239, 172, 0.12)' : 'rgba(255, 255, 255, 0.04)',
      };
    }

    if (type === 'dm') {
      // Home tile uses brand-tinted lavender (the endpoint of the mark's
      // gradient — see assets/brand/mark.svg) so the bg is on-brand and
      // visibly NOT grey against the cool-dark sidebar (any neutral tint
      // reads as muddy grey-on-dark; only saturation breaks the grey).
      // Discord's home button uses brand blurple the same way; ours uses
      // accent-lavender. The bare mark in logo.png sits at 75% scale on
      // transparent so the lavender tile is the visible frame, escalating
      // at rest → hover → active for clear interaction feedback.
      return {
        background: active
          ? 'rgba(196, 181, 253, 0.28)'
          : isHovered
            ? 'rgba(196, 181, 253, 0.16)'
            : 'rgba(196, 181, 253, 0.08)',
      };
    }

    // Space type — if it has a custom icon image, no gradient needed
    if (icon) return undefined;

    const spaceGrad = getSpaceGradient(id, name, avatarColor);
    return { background: spaceGrad.gradient };
  }, [type, id, name, icon, avatarColor, isHovered, active]);

  const getButtonClasses = () => {
    const base = 'w-10 h-10 flex items-center justify-center duration-200 overflow-hidden [transition:border-radius_0.2s,background_0.2s,color_0.2s]';

    if (type === 'dm') {
      return `${base} text-white ${active ? 'rounded-[13px]' : 'rounded-[20px] hover:rounded-[13px]'}`;
    }

    if (type === 'action') {
      return `${base} rounded-[20px] hover:rounded-[13px] text-accent-mint`;
    }

    if (icon) {
      return `${base} ${active ? 'rounded-[13px]' : 'rounded-[20px] hover:rounded-[13px]'}`;
    }

    return `${base} text-white ${active ? 'rounded-[13px]' : 'rounded-[20px] hover:rounded-[13px]'}`;
  };

  const buttonContent = (
    <button onClick={onClick} className={`${getButtonClasses()} ${dimmed ? 'opacity-40 saturate-50' : ''}`} style={backgroundStyle} title={tooltipText ? undefined : name}>
      {type === 'dm' ? (
        <img src="/icons/logo.png" alt="Backspace" className="w-full h-full object-cover" />
      ) : type === 'action' ? (
        actionType === 'add' ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
          </svg>
        ) : actionType === 'explore' ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z" />
          </svg>
        )
      ) : icon ? (
        <img
          src={icon.startsWith('http') || icon.startsWith('/') ? icon : `/api/uploads/${icon}`}
          alt={name}
          className="w-full h-full object-cover"
        />
      ) : (
        <span className="text-[15px] font-bold">{firstLetter}</span>
      )}
    </button>
  );

  const innerContent = (
    <div className={`relative ${dropIndicator === 'merge' ? 'scale-110 ring-2 ring-accent-mint/60 rounded-full' : ''} transition-transform duration-150`}>
      {buttonContent}
      {federationBadge && (
        <div className="absolute -bottom-0.5 -right-0.5 w-[14px] h-[14px] rounded-full bg-surface-base flex items-center justify-center">
          {federationDisconnected ? (
            <div className="w-[8px] h-[8px] rounded-full bg-accent-amber" />
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary/80">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
            </svg>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div
      className={`relative flex items-center mb-1.5 w-full justify-center ${isDragging ? 'opacity-50' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
    >
      {/* Drop indicator lines — offset into the mb-1.5 gap so adjacent items share one line */}
      {dropIndicator === 'before' && (
        <div className="absolute -top-[3px] left-3 right-3 h-[2px] bg-accent-mint rounded-full z-10" />
      )}
      {dropIndicator === 'after' && (
        <div className="absolute -bottom-[3px] left-3 right-3 h-[2px] bg-accent-mint rounded-full z-10" />
      )}

      {/* Pill Indicator */}
      {(type === 'space' || type === 'dm') && (
        <div className="absolute -left-0 w-2 h-10 flex items-center">
          <div
            className={`bg-white rounded-r-full transition-all duration-200 origin-left ${getPillHeight()} w-1`}
          />
        </div>
      )}

      {tooltipText ? (
        <Tooltip content={tooltipText} position="right" delay={300}>
          {innerContent}
        </Tooltip>
      ) : (
        innerContent
      )}
    </div>
  );
}

// ─── Mini space icon for collapsed folder ──────────────────────────────────

function MiniSpaceIcon({ space }: { space: TaggedSpace }) {
  const icon = space.icon;
  if (icon) {
    return (
      <img
        src={icon.startsWith('http') || icon.startsWith('/') ? icon : `/api/uploads/${icon}`}
        alt=""
        className="w-full h-full object-cover rounded-[3px]"
      />
    );
  }
  const grad = getSpaceGradient(space.id, space.name, space.avatarColor);
  return (
    <div
      className="w-full h-full rounded-[3px] flex items-center justify-center text-white"
      style={{ background: grad.gradient }}
    >
      <span className="text-[7px] font-bold leading-none">{space.name.charAt(0).toUpperCase()}</span>
    </div>
  );
}

// ─── Folder icon (2×2 grid with glass-pill) ───────────────────────────────

function FolderIcon({ spaces, color, isActive, isHovered }: { spaces: TaggedSpace[]; color: string | null; isActive: boolean; isHovered: boolean }) {
  const display = spaces.slice(0, 4);
  const remaining = spaces.length - 4;
  const borderColor = color ? `rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)}, 0.3)` : undefined;
  return (
    <div
      className={`relative w-10 h-10 flex items-center justify-center overflow-hidden glass-pill [transition:border-radius_0.2s] ${
        isActive || isHovered ? 'rounded-[13px]' : 'rounded-[16px]'
      }`}
      style={borderColor ? { borderColor } : undefined}
    >
      <div className="grid grid-cols-2 gap-[2px] w-[28px] h-[28px] relative z-[1]">
        {display.map((s) => (
          <div key={s.id} className="w-[13px] h-[13px]">
            <MiniSpaceIcon space={s} />
          </div>
        ))}
        {display.length < 4 && Array.from({ length: 4 - display.length }).map((_, i) => (
          <div key={`empty-${i}`} className="w-[13px] h-[13px] rounded-[3px] bg-white/[0.04]" />
        ))}
      </div>
      {remaining > 0 && (
        <div className="absolute bottom-0 right-0 text-[7px] font-bold text-txt-tertiary bg-surface-base rounded-tl-sm px-0.5">
          +{remaining}
        </div>
      )}
    </div>
  );
}

// ─── FolderFlyout ─────────────────────────────────────────────────────────

function FolderFlyout({
  folder,
  spaces,
  anchorEl,
  currentSpaceId,
  unreadSpaceIds,
  disconnectedOrigins,
  renamingFolderId,
  onClose,
  onSpaceClick,
  onSpaceContextMenu,
  onRename,
  onDragStart,
  onReorder,
  onParentDragEnd,
}: {
  folder: SpaceFolder;
  spaces: TaggedSpace[];
  anchorEl: HTMLDivElement;
  currentSpaceId: string | null;
  unreadSpaceIds: Set<string>;
  disconnectedOrigins: Set<string>;
  renamingFolderId: string | null;
  onClose: () => void;
  onSpaceClick: (spaceId: string) => void;
  onSpaceContextMenu: (spaceId: string, e: React.MouseEvent) => void;
  onRename: (name: string) => void;
  onDragStart: (e: React.DragEvent, spaceId: string) => void;
  onReorder: (reorderedSpaceIds: string[]) => void;
  onParentDragEnd: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(anchorEl);
  anchorRef.current = anchorEl;
  const floatingRef = useRef<HTMLDivElement>(null);

  const { style } = useFloatingPosition(anchorRef, floatingRef, {
    placement: 'right',
    offset: 12,
  });

  // Intra-folder DnD state
  const [flyoutDrop, setFlyoutDrop] = useState<{
    targetSpaceId: string;
    position: 'before' | 'after';
  } | null>(null);
  const flyoutDropRef = useRef(flyoutDrop);
  flyoutDropRef.current = flyoutDrop;

  const handleFlyoutDragOver = useCallback((e: React.DragEvent, targetSpaceId: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    const rect = e.currentTarget.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const position: 'before' | 'after' = relY < rect.height * 0.5 ? 'before' : 'after';

    // Normalize 'before' to previous item's 'after' so a single indicator renders
    if (position === 'before') {
      const idx = spaces.findIndex(s => s.id === targetSpaceId);
      if (idx > 0) {
        const prevId = spaces[idx - 1]!.id;
        setFlyoutDrop({ targetSpaceId: prevId, position: 'after' });
        return;
      }
    }

    setFlyoutDrop({ targetSpaceId, position });
  }, [spaces]);

  const handleFlyoutDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const indicator = flyoutDropRef.current;
    const dragId = e.dataTransfer.getData('text/plain');
    if (!indicator || !dragId) {
      setFlyoutDrop(null);
      onParentDragEnd();
      return;
    }

    // Don't reorder if dropping on self in same position
    const currentIds = spaces.map(s => s.id);
    const dragIdx = currentIds.indexOf(dragId);
    if (dragIdx === -1) {
      // Dragged space is not in this folder — let parent handle it
      setFlyoutDrop(null);
      onParentDragEnd();
      return;
    }

    // Remove dragged space and re-insert at target position
    const without = currentIds.filter(id => id !== dragId);
    const targetIdx = without.indexOf(indicator.targetSpaceId);
    if (targetIdx === -1) {
      setFlyoutDrop(null);
      onParentDragEnd();
      return;
    }

    const insertIdx = indicator.position === 'before' ? targetIdx : targetIdx + 1;
    without.splice(insertIdx, 0, dragId);

    onReorder(without);
    setFlyoutDrop(null);
    onParentDragEnd();
  }, [spaces, onReorder, onParentDragEnd]);

  const handleFlyoutDragEnd = useCallback(() => {
    setFlyoutDrop(null);
    onParentDragEnd();
  }, [onParentDragEnd]);

  // Close on click-outside and Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        floatingRef.current && !floatingRef.current.contains(e.target as Node) &&
        !anchorEl.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest?.('[data-flyout-safe]')
      ) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, anchorEl]);

  const isRenaming = renamingFolderId === folder.id;

  return ReactDOM.createPortal(
    <div
      ref={floatingRef}
      className="w-[220px] max-h-[360px] overflow-y-auto glass rounded-lg py-1.5 animate-in fade-in zoom-in-95 duration-100"
      style={style}
    >
      {/* Folder header */}
      {(folder.name || isRenaming) && (
        <div className="px-3 pb-1.5 pt-0.5">
          {isRenaming ? (
            <input
              autoFocus
              className="input-search w-full px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-txt-tertiary"
              defaultValue={folder.name || ''}
              onBlur={(e) => onRename(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRename(e.currentTarget.value);
                if (e.key === 'Escape') onClose();
              }}
            />
          ) : (
            <span className="text-[11px] font-semibold uppercase tracking-wider text-txt-tertiary">
              {folder.name}
            </span>
          )}
        </div>
      )}

      {/* Space rows */}
      {spaces.map((space, idx) => {
        const isActive = currentSpaceId === space.id;
        const hasUnread = unreadSpaceIds.has(space.id) && !isActive;
        const origin = space._instanceOrigin;
        const isFederated = !!origin;
        const isDimmed = isFederated && disconnectedOrigins.has(origin);
        const icon = space.icon;
        const grad = !icon ? getSpaceGradient(space.id, space.name, space.avatarColor) : null;

        return (
          <React.Fragment key={space.id}>
            {/* Drop indicator: before first item */}
            {idx === 0 && flyoutDrop?.targetSpaceId === space.id && flyoutDrop.position === 'before' && (
              <div className="h-0.5 bg-accent-mint rounded-full mx-2.5 my-0.5" />
            )}

            <button
              className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 mx-1 rounded-md transition-colors ${
                isDimmed ? 'opacity-40 saturate-50' : ''
              } ${isActive ? 'bg-white/[0.10]' : 'hover:bg-white/[0.06]'}`}
              style={{ width: 'calc(100% - 8px)' }}
              draggable
              onDragStart={(e) => onDragStart(e, space.id)}
              onDragOver={(e) => handleFlyoutDragOver(e, space.id)}
              onDrop={handleFlyoutDrop}
              onDragEnd={handleFlyoutDragEnd}
              onClick={() => {
                onSpaceClick(space.id);
                onClose();
              }}
              onContextMenu={(e) => {
                onSpaceContextMenu(space.id, e);
              }}
            >
              {/* Space icon */}
              <div className="w-8 h-8 rounded-[10px] flex-shrink-0 overflow-hidden flex items-center justify-center" style={grad ? { background: grad.gradient } : undefined}>
                {icon ? (
                  <img
                    src={icon.startsWith('http') || icon.startsWith('/') ? icon : `/api/uploads/${icon}`}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-[13px] font-bold text-white">{space.name.charAt(0).toUpperCase()}</span>
                )}
              </div>

              {/* Name */}
              <span className="text-sm text-txt-primary truncate flex-1 text-left">{space.name}</span>

              {/* Federation badge */}
              {isFederated && !isDimmed && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary/80 flex-shrink-0">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                </svg>
              )}

              {/* Unread dot */}
              {hasUnread && (
                <div className="w-2 h-2 rounded-full bg-white flex-shrink-0" />
              )}
            </button>

            {/* Drop indicator: after item */}
            {flyoutDrop?.targetSpaceId === space.id && flyoutDrop.position === 'after' && (
              <div className="h-0.5 bg-accent-mint rounded-full mx-2.5 my-0.5" />
            )}
          </React.Fragment>
        );
      })}
    </div>,
    document.body,
  );
}

// ─── FolderSlot (single icon slot for a folder) ──────────────────────────

function FolderSlot({
  folder,
  folderSpaces,
  isActive,
  hasUnread,
  isFlyoutOpen,
  isDragging,
  dropIndicator,
  onToggleFlyout,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  anchorRef,
}: {
  folder: SpaceFolder;
  folderSpaces: TaggedSpace[];
  isActive: boolean;
  hasUnread: boolean;
  isFlyoutOpen: boolean;
  isDragging: boolean;
  dropIndicator: 'before' | 'after' | 'merge' | null;
  onToggleFlyout: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent) => void;
  anchorRef: (el: HTMLDivElement | null) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);

  const getPillHeight = () => {
    if (isActive) return 'h-8';
    if (isHovered) return 'h-4';
    if (hasUnread) return 'h-2';
    return 'h-2 scale-0';
  };

  const iconContent = (
    <button onClick={onToggleFlyout}>
      <FolderIcon spaces={folderSpaces} color={folder.color} isActive={isActive || isFlyoutOpen} isHovered={isHovered} />
    </button>
  );

  return (
    <div
      ref={anchorRef}
      className={`relative flex items-center mb-1.5 w-full justify-center ${isDragging ? 'opacity-50' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
    >
      {/* Drop indicators — offset into the mb-1.5 gap so adjacent items share one line */}
      {dropIndicator === 'before' && (
        <div className="absolute -top-[3px] left-3 right-3 h-[2px] bg-accent-mint rounded-full z-10" />
      )}
      {dropIndicator === 'after' && (
        <div className="absolute -bottom-[3px] left-3 right-3 h-[2px] bg-accent-mint rounded-full z-10" />
      )}
      {dropIndicator === 'merge' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="w-12 h-12 rounded-[16px] ring-2 ring-accent-mint/60" />
        </div>
      )}

      {/* Pill indicator */}
      <div className="absolute -left-0 w-2 h-10 flex items-center">
        <div className={`bg-white rounded-r-full transition-all duration-200 origin-left ${getPillHeight()} w-1`} />
      </div>

      {isFlyoutOpen ? (
        iconContent
      ) : (
        <Tooltip content={folder.name || `Folder (${folderSpaces.length})`} position="right" delay={300}>
          {iconContent}
        </Tooltip>
      )}
    </div>
  );
}

// ─── SpaceSidebar (main component) ────────────────────────────────────────

export function SpaceSidebar() {
  const spaces = useSpaceStore((s) => s.spaces);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);
  const channelToSpaceMap = useSpaceStore((s) => s.channelToSpaceMap);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const folders = useSpaceStore((s) => s.folders);
  const spaceLayout = useSpaceStore((s) => s.spaceLayout);
  const updateSpaceLayout = useSpaceStore((s) => s.updateSpaceLayout);
  const generateInvite = useSpaceStore((s) => s.generateInvite);
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);
  const showDms = useUIStore((s) => s.showDms);
  const setShowDms = useUIStore((s) => s.setShowDms);
  const openModal = useUIStore((s) => s.openModal);
  const addToast = useUIStore((s) => s.addToast);
  const floatingPanelHeight = useUIStore((s) => s.floatingPanelHeight);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
  const unreadChannels = useChatStore((s) => s.unreadChannels);
  const instances = useInstanceStore((s) => s.instances);
  const navigate = useNavigate();
  const location = useLocation();

  // Flyout state
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const folderAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Modal state for context menu actions that spawn modals
  const [transferModalSpaceId, setTransferModalSpaceId] = useState<string | null>(null);
  const [leaveConfirmSpaceId, setLeaveConfirmSpaceId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);

  // DnD state
  const [dragState, setDragState] = useState<{ dragId: string; dragType: 'space' | 'folder'; sourceFolderId?: string } | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ targetId: string; position: 'before' | 'after' | 'merge' } | null>(null);
  const dropIndicatorRef = useRef(dropIndicator);

  const openContextMenu = useContextMenuStore((s) => s.open);

  const handleSpaceContextMenu = useCallback((spaceId: string, e: React.MouseEvent) => {
    e.preventDefault();
    const space = useSpaceStore.getState().spaces.find(sp => sp.id === spaceId);
    if (!space) return;
    const isOwner = space.ownerId === getMyUserIdForOrigin((space as TaggedSpace)._instanceOrigin ?? '');

    const items: ContextMenuItem[] = [
      {
        key: 'invite',
        type: 'action',
        label: 'Invite People',
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
          </svg>
        ),
        onClick: async () => {
          try {
            const code = await useSpaceStore.getState().generateInvite(spaceId);
            const origin = (space as TaggedSpace)._instanceOrigin || window.location.origin;
            const url = `${origin}/invite/${code}`;
            await navigator.clipboard.writeText(url);
            useUIStore.getState().addToast('Invite link copied to clipboard', 'success', 3000);
          } catch {
            useUIStore.getState().addToast('Failed to generate invite', 'warning', 3000);
          }
        },
      },
      {
        key: 'transfer',
        type: 'action',
        label: 'Transfer Ownership',
        hidden: !isOwner,
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z" />
          </svg>
        ),
        onClick: () => setTransferModalSpaceId(spaceId),
      },
      {
        key: 'leave',
        type: 'action',
        label: 'Leave Space',
        hidden: isOwner,
        danger: true,
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
          </svg>
        ),
        onClick: () => setLeaveConfirmSpaceId(spaceId),
      },
    ];

    openContextMenu({ x: e.clientX, y: e.clientY }, items);
  }, [openContextMenu]);

  // Set of disconnected origins
  const disconnectedOrigins = useMemo(() => {
    const set = new Set<string>();
    for (const inst of instances) {
      if (inst.status === 'disconnected' || inst.status === 'error') {
        set.add(inst.origin);
      }
    }
    return set;
  }, [instances]);

  // Build space lookup map
  const spaceMap = useMemo(() => {
    const map = new Map<string, TaggedSpace>();
    for (const s of spaces) map.set(s.id, s);
    return map;
  }, [spaces]);

  // Build folder lookup map
  const folderMap = useMemo(() => {
    const map = new Map<string, SpaceFolder>();
    for (const f of folders) map.set(f.id, f);
    return map;
  }, [folders]);

  // Reconciled layout: merge spaceLayout with actual spaces and folders
  const resolvedLayout = useMemo((): ResolvedItem[] => {
    const memberSpaceIds = new Set(spaces.map(s => s.id));
    const result: ResolvedItem[] = [];
    const accountedSpaceIds = new Set<string>();

    if (spaceLayout && spaceLayout.length > 0) {
      for (const item of spaceLayout) {
        if (item.t === 's') {
          const space = spaceMap.get(item.id);
          if (space) {
            result.push({ type: 'space', space });
            accountedSpaceIds.add(item.id);
          }
        } else if (item.t === 'f') {
          const folder = folderMap.get(item.id);
          if (folder) {
            const folderSpaces = folder.spaceIds
              .map(sid => spaceMap.get(sid))
              .filter((s): s is TaggedSpace => !!s);
            if (folderSpaces.length > 0) {
              result.push({
                type: 'folder',
                folder,
                spaces: folderSpaces,
              });
              for (const s of folderSpaces) accountedSpaceIds.add(s.id);
            }
          }
        }
      }
    }

    // Append any spaces not in the layout (newly joined, etc.)
    for (const space of spaces) {
      if (!accountedSpaceIds.has(space.id)) {
        result.push({ type: 'space', space });
        accountedSpaceIds.add(space.id);
      }
    }

    return result;
  }, [spaceLayout, spaces, spaceMap, folderMap]);

  // Compute which spaces have unread channels
  const unreadSpaceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const channelId of unreadChannels) {
      const spaceId = channelToSpaceMap.get(channelId);
      if (spaceId) ids.add(spaceId);
    }
    return ids;
  }, [unreadChannels, channelToSpaceMap]);

  // Check if any DM channels are unread
  const hasDmUnread = useMemo(() => {
    for (const dm of dmChannels) {
      if (unreadChannels.has(dm.id)) return true;
    }
    return false;
  }, [unreadChannels, dmChannels]);

  const handleSpaceClick = useCallback((spaceId: string) => {
    const space = spaceMap.get(spaceId);
    const origin = space?._instanceOrigin;
    if (origin && disconnectedOrigins.has(origin)) {
      const inst = instances.find(i => i.origin === origin);
      addToast(`Reconnecting to ${inst?.label || 'remote instance'}...`, 'warning', 4000);
      return;
    }
    setCurrentSpace(spaceId);
    setShowDms(false);
    navigate(`/channels/${spaceId}`);
  }, [spaceMap, disconnectedOrigins, instances, addToast, setCurrentSpace, setShowDms, navigate]);

  const handleDmClick = () => {
    setShowDms(true);
    setCurrentSpace(null);
    setCurrentChannel(null);
    navigate('/channels/@me');
  };

  const handleExploreClick = () => {
    setCurrentSpace(null);
    setCurrentChannel(null);
    navigate('/explore');
  };

  // ─── DnD handlers ──────────────────────────────────────────────────────

  const handleDragStart = useCallback((e: React.DragEvent, id: string, type: 'space' | 'folder', sourceFolderId?: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    setDragState({ dragId: id, dragType: type, sourceFolderId });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, targetId: string, targetType: 'space' | 'folder') => {
    if (!dragState) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const rect = e.currentTarget.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const height = rect.height;

    let position: 'before' | 'after' | 'merge';
    if (targetType === 'folder' || dragState.dragType === 'space') {
      // Space items: top 25% = before, middle 50% = merge, bottom 25% = after
      if (relY < height * 0.25) {
        position = 'before';
      } else if (relY > height * 0.75) {
        position = 'after';
      } else {
        // Merge zone: only if dragging a space onto another space or folder
        if (dragState.dragType === 'space' && dragState.dragId !== targetId) {
          position = 'merge';
        } else {
          position = relY < height * 0.5 ? 'before' : 'after';
        }
      }
    } else {
      // Folder dragging: only before/after, no merge
      position = relY < height * 0.5 ? 'before' : 'after';
    }

    // Normalize 'before' to previous item's 'after' so the drop indicator
    // always renders from a single DOM element, eliminating sub-pixel jump
    if (position === 'before') {
      const targetIdx = resolvedLayout.findIndex(item =>
        (item.type === 'space' && item.space.id === targetId) ||
        (item.type === 'folder' && item.folder.id === targetId)
      );
      if (targetIdx > 0) {
        const prevItem = resolvedLayout[targetIdx - 1]!;
        const prevId = prevItem.type === 'space' ? prevItem.space.id : prevItem.folder.id;
        dropIndicatorRef.current = { targetId: prevId, position: 'after' };
        setDropIndicator({ targetId: prevId, position: 'after' });
        return;
      }
    }

    dropIndicatorRef.current = { targetId, position };
    setDropIndicator({ targetId, position });
  }, [dragState, resolvedLayout]);

  const handleDragEnd = useCallback(() => {
    setDragState(null);
    dropIndicatorRef.current = null;
    setDropIndicator(null);
  }, []);

  // Build layout items and folder payload from resolvedLayout for persistence
  const buildLayoutPayload = useCallback((resolved: ResolvedItem[]) => {
    const items: SpaceLayoutItem[] = [];
    const folderPayload: Record<string, { name: string | null; color: string | null; spaceIds: string[] }> = {};

    for (const item of resolved) {
      if (item.type === 'space') {
        items.push({ t: 's', id: item.space.id });
      } else {
        items.push({ t: 'f', id: item.folder.id });
        folderPayload[item.folder.id] = {
          name: item.folder.name,
          color: item.folder.color,
          spaceIds: item.spaces.map(s => s.id),
        };
      }
    }

    return { items, folderPayload };
  }, []);

  const persistLayout = useCallback((resolved: ResolvedItem[]) => {
    const { items, folderPayload } = buildLayoutPayload(resolved);
    updateSpaceLayout(items, folderPayload);
  }, [buildLayoutPayload, updateSpaceLayout]);

  const handleReorderInFolder = useCallback((folderId: string, reorderedSpaceIds: string[]) => {
    const newLayout = resolvedLayout.map(item => {
      if (item.type === 'folder' && item.folder.id === folderId) {
        const reorderedSpaces = reorderedSpaceIds
          .map(id => item.spaces.find(s => s.id === id))
          .filter((s): s is TaggedSpace => !!s);
        return {
          ...item,
          spaces: reorderedSpaces,
          folder: { ...item.folder, spaceIds: reorderedSpaceIds },
        };
      }
      return item;
    }) as ResolvedItem[];
    persistLayout(newLayout);
  }, [resolvedLayout, persistLayout]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const indicator = dropIndicatorRef.current;
    if (!dragState || !indicator) {
      handleDragEnd();
      return;
    }

    const { dragId, dragType, sourceFolderId } = dragState;
    const { targetId, position } = indicator;

    // Don't drop on self
    if (dragId === targetId && position !== 'merge') {
      handleDragEnd();
      return;
    }

    // Work with a mutable copy of the resolved layout
    let newLayout = resolvedLayout.map(item => {
      if (item.type === 'folder') {
        return { ...item, spaces: [...item.spaces], folder: { ...item.folder } };
      }
      return { ...item };
    }) as ResolvedItem[];

    if (dragType === 'space') {
      const dragSpace = spaceMap.get(dragId);
      if (!dragSpace) { handleDragEnd(); return; }

      // Remove from source
      if (sourceFolderId) {
        // Remove from folder
        const folderItem = newLayout.find(i => i.type === 'folder' && i.folder.id === sourceFolderId) as (ResolvedItem & { type: 'folder' }) | undefined;
        if (folderItem) {
          folderItem.spaces = folderItem.spaces.filter(s => s.id !== dragId);
          folderItem.folder = { ...folderItem.folder, spaceIds: folderItem.spaces.map(s => s.id) };
        }
      } else {
        // Remove standalone
        newLayout = newLayout.filter(item => !(item.type === 'space' && item.space.id === dragId));
      }

      if (position === 'merge') {
        // Find the target
        const targetIdx = newLayout.findIndex(item =>
          (item.type === 'space' && item.space.id === targetId) ||
          (item.type === 'folder' && item.folder.id === targetId)
        );
        if (targetIdx === -1) { handleDragEnd(); return; }

        const targetItem = newLayout[targetIdx];
        if (!targetItem) { handleDragEnd(); return; }

        if (targetItem.type === 'space') {
          // Create new folder with both spaces
          const tempId = `new:${Date.now()}`;
          const newFolder: ResolvedItem = {
            type: 'folder',
            folder: {
              id: tempId,
              userId: '',
              name: null,
              color: null,
              position: 0,
              spaceIds: [targetItem.space.id, dragSpace.id],
            },
            spaces: [targetItem.space, dragSpace],
          };
          newLayout[targetIdx] = newFolder;
        } else if (targetItem.type === 'folder') {
          // Add to existing folder
          targetItem.spaces.push(dragSpace);
          targetItem.folder = { ...targetItem.folder, spaceIds: targetItem.spaces.map(s => s.id) };
        }
      } else {
        // Reorder: insert before or after target
        const targetIdx = newLayout.findIndex(item =>
          (item.type === 'space' && item.space.id === targetId) ||
          (item.type === 'folder' && item.folder.id === targetId)
        );
        if (targetIdx === -1) { handleDragEnd(); return; }

        const insertIdx = position === 'before' ? targetIdx : targetIdx + 1;
        const newItem: ResolvedItem = { type: 'space', space: dragSpace };
        newLayout.splice(insertIdx, 0, newItem);
      }

      // Dissolve folders with < 2 members
      newLayout = newLayout.flatMap(item => {
        if (item.type === 'folder' && item.spaces.length < 2) {
          if (item.spaces.length === 1 && item.spaces[0]) {
            return [{ type: 'space' as const, space: item.spaces[0] }];
          }
          return []; // 0 members, remove entirely
        }
        return [item];
      });

    } else if (dragType === 'folder') {
      // Remove the folder from its current position
      const dragIdx = newLayout.findIndex(i => i.type === 'folder' && i.folder.id === dragId);
      if (dragIdx === -1) { handleDragEnd(); return; }
      const dragItem = newLayout.splice(dragIdx, 1)[0];
      if (!dragItem) { handleDragEnd(); return; }

      // Insert at target position
      const targetIdx = newLayout.findIndex(item =>
        (item.type === 'space' && item.space.id === targetId) ||
        (item.type === 'folder' && item.folder.id === targetId)
      );
      if (targetIdx === -1) {
        newLayout.push(dragItem);
      } else {
        const insertIdx = position === 'before' ? targetIdx : targetIdx + 1;
        newLayout.splice(insertIdx, 0, dragItem);
      }
    }

    persistLayout(newLayout);
    handleDragEnd();
  }, [dragState, resolvedLayout, spaceMap, handleDragEnd, persistLayout]);

  // ─── Folder actions ──────────────────────────────────────────────────

  const handleFolderRename = useCallback((folderId: string, name: string) => {
    const newLayout = resolvedLayout.map(item => {
      if (item.type === 'folder' && item.folder.id === folderId) {
        return { ...item, folder: { ...item.folder, name: name.trim() || null } };
      }
      return item;
    });
    persistLayout(newLayout);
    setRenamingFolderId(null);
  }, [resolvedLayout, persistLayout]);

  const handleFolderColorChange = useCallback((folderId: string, color: string | null) => {
    const newLayout = resolvedLayout.map(item => {
      if (item.type === 'folder' && item.folder.id === folderId) {
        return { ...item, folder: { ...item.folder, color } };
      }
      return item;
    });
    persistLayout(newLayout);
  }, [resolvedLayout, persistLayout]);

  const handleUngroup = useCallback((folderId: string) => {
    setOpenFolderId(null);
    const newLayout = resolvedLayout.flatMap(item => {
      if (item.type === 'folder' && item.folder.id === folderId) {
        return item.spaces.map(s => ({ type: 'space' as const, space: s }));
      }
      return [item];
    });
    persistLayout(newLayout);
  }, [resolvedLayout, persistLayout]);

  // ─── Helpers for rendering ──────────────────────────────────────────

  const getFederationInfo = useCallback((space: TaggedSpace) => {
    const origin = space._instanceOrigin;
    const isFederated = !!origin;
    const isDimmed = isFederated && disconnectedOrigins.has(origin);
    let tooltipText = space.name;
    if (isFederated) {
      try {
        const hostLabel = new URL(origin).host;
        tooltipText = `${space.name} \u00b7 ${hostLabel}`;
      } catch { /* ignore */ }
    }
    return { isFederated, isDimmed, tooltipText };
  }, [disconnectedOrigins]);

  // Check if a folder has any unread spaces
  const folderHasUnread = useCallback((folderSpaces: TaggedSpace[]) => {
    return folderSpaces.some(s => unreadSpaceIds.has(s.id));
  }, [unreadSpaceIds]);

  // Check if folder has any active space
  const folderHasActive = useCallback((folderSpaces: TaggedSpace[]) => {
    return currentSpaceId ? folderSpaces.some(s => s.id === currentSpaceId) : false;
  }, [currentSpaceId]);

  // Auto-close flyout when its folder dissolves
  useEffect(() => {
    if (openFolderId && !resolvedLayout.some(i => i.type === 'folder' && i.folder.id === openFolderId)) {
      setOpenFolderId(null);
    }
  }, [openFolderId, resolvedLayout]);

  return (
    <nav data-pip-obstacle="left" className="w-[72px] bg-surface-base flex flex-col items-center py-3 overflow-y-auto flex-shrink-0 no-scrollbar select-none md:fixed md:inset-y-0 md:left-0 md:z-[100] md:glass-strip" style={{ paddingBottom: floatingPanelHeight + 24, ...(isElectron() ? { top: '33px' } : {}) }} onDragOver={(e) => { if (dragState) e.preventDefault(); }} onDrop={handleDrop}>
      <SidebarItem
        id="@me"
        name="Direct Messages"
        active={showDms}
        onClick={handleDmClick}
        type="dm"
        hasUnread={hasDmUnread}
      />

      <div className="w-8 h-[2px] bg-white/[0.06] rounded-full mb-1.5 shrink-0" />

      {/* Unified space list (ordered by user layout) */}
      {resolvedLayout.map((item) => {
        if (item.type === 'space') {
          const { isFederated, isDimmed, tooltipText } = getFederationInfo(item.space);
          return (
            <SidebarItem
              key={item.space.id}
              id={item.space.id}
              name={item.space.name}
              icon={item.space.icon}
              avatarColor={item.space.avatarColor}
              active={currentSpaceId === item.space.id}
              onClick={() => handleSpaceClick(item.space.id)}
              onContextMenu={(e) => handleSpaceContextMenu(item.space.id, e)}
              hasUnread={unreadSpaceIds.has(item.space.id)}
              dimmed={isDimmed}
              federationBadge={isFederated}
              federationDisconnected={isDimmed}
              tooltipText={tooltipText}
              draggable
              onDragStart={(e) => handleDragStart(e, item.space.id, 'space')}
              onDragOver={(e) => handleDragOver(e, item.space.id, 'space')}
              onDragEnd={handleDragEnd}
              onDrop={handleDrop}
              isDragging={dragState?.dragType === 'space' && dragState.dragId === item.space.id}
              dropIndicator={dropIndicator?.targetId === item.space.id ? dropIndicator.position : null}
            />
          );
        }

        // Folder — always a single icon slot
        const { folder, spaces: folderSpaces } = item;
        const isActive = folderHasActive(folderSpaces);
        const hasUnread = folderHasUnread(folderSpaces);
        const isFlyoutOpen = openFolderId === folder.id;

        return (
          <FolderSlot
            key={`folder-${folder.id}`}
            folder={folder}
            folderSpaces={folderSpaces}
            isActive={isActive}
            hasUnread={hasUnread}
            isFlyoutOpen={isFlyoutOpen}
            isDragging={dragState?.dragType === 'folder' && dragState.dragId === folder.id}
            dropIndicator={dropIndicator?.targetId === folder.id ? dropIndicator.position : null}
            onToggleFlyout={() => setOpenFolderId(isFlyoutOpen ? null : folder.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              const folderRef = folder;
              const items: ContextMenuItem[] = [
                {
                  key: 'rename',
                  type: 'action',
                  label: 'Rename Folder',
                  icon: (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                    </svg>
                  ),
                  onClick: () => {
                    setRenamingFolderId(folderRef.id);
                    setOpenFolderId(folderRef.id);
                  },
                },
                {
                  key: 'color',
                  type: 'custom',
                  render: () => (
                    <div className="px-3 py-1.5">
                      <p className="text-[11px] text-txt-tertiary mb-1.5">Folder Color</p>
                      <div className="flex gap-1.5">
                        <button
                          className={`w-5 h-5 rounded-full border-2 ${!folderRef.color ? 'border-white/40' : 'border-transparent'} bg-white/10`}
                          onClick={() => { handleFolderColorChange(folderRef.id, null); useContextMenuStore.getState().close(); }}
                          title="Default"
                        />
                        {FOLDER_COLORS.map((c) => (
                          <button
                            key={c.name}
                            className={`w-5 h-5 rounded-full border-2 ${folderRef.color === c.value ? 'border-white/40' : 'border-transparent'}`}
                            style={{ background: c.value }}
                            onClick={() => { handleFolderColorChange(folderRef.id, c.value); useContextMenuStore.getState().close(); }}
                            title={c.name}
                          />
                        ))}
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'sep',
                  type: 'separator',
                },
                {
                  key: 'ungroup',
                  type: 'action',
                  label: 'Ungroup',
                  danger: true,
                  icon: (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm12 6V8h-2v4H10v2h4v4h2v-4h4v-2h-4z" />
                    </svg>
                  ),
                  onClick: () => handleUngroup(folderRef.id),
                },
              ];
              openContextMenu({ x: e.clientX, y: e.clientY }, items);
            }}
            onDragStart={(e) => handleDragStart(e, folder.id, 'folder')}
            onDragOver={(e) => handleDragOver(e, folder.id, 'folder')}
            onDragEnd={handleDragEnd}
            onDrop={handleDrop}
            anchorRef={(el) => {
              if (el) folderAnchorRefs.current.set(folder.id, el);
              else folderAnchorRefs.current.delete(folder.id);
            }}
          />
        );
      })}

      <div className="w-8 h-[2px] bg-white/[0.06] rounded-full mb-1.5 shrink-0" />

      <SidebarItem
        id="add-space"
        name="Add a Space"
        active={false}
        onClick={() => openModal('createSpace')}
        type="action"
        actionType="add"
      />

      <SidebarItem
        id="join-space"
        name="Join a Space"
        active={false}
        onClick={() => openModal('joinSpace')}
        type="action"
        actionType="join"
      />

      <SidebarItem
        id="explore"
        name="Explore Spaces"
        active={location.pathname === '/explore'}
        onClick={handleExploreClick}
        type="action"
        actionType="explore"
      />

      {transferModalSpaceId && (
        <TransferOwnershipModal
          spaceId={transferModalSpaceId}
          onClose={() => setTransferModalSpaceId(null)}
        />
      )}
      {leaveConfirmSpaceId && (() => {
        const space = spaces.find(s => s.id === leaveConfirmSpaceId);
        return (
          <ConfirmDialog
            isOpen={true}
            onClose={() => setLeaveConfirmSpaceId(null)}
            onConfirm={() => {
              if (currentSpaceId === leaveConfirmSpaceId) {
                navigate('/channels/@me');
                setCurrentSpace(null);
                setShowDms(true);
              }
              leaveSpace(leaveConfirmSpaceId);
              setLeaveConfirmSpaceId(null);
            }}
            title={`Leave ${space?.name ?? 'Space'}`}
            description="Are you sure you want to leave this space? You'll need a new invite to rejoin."
            variant="danger"
            confirmLabel="Leave"
          />
        );
      })()}

      {openFolderId && (() => {
        const folderItem = resolvedLayout.find(
          (i): i is ResolvedItem & { type: 'folder' } =>
            i.type === 'folder' && i.folder.id === openFolderId
        );
        const anchor = folderAnchorRefs.current.get(openFolderId);
        if (!folderItem || !anchor) return null;
        return (
          <FolderFlyout
            folder={folderItem.folder}
            spaces={folderItem.spaces}
            anchorEl={anchor}
            currentSpaceId={currentSpaceId}
            unreadSpaceIds={unreadSpaceIds}
            disconnectedOrigins={disconnectedOrigins}
            renamingFolderId={renamingFolderId}
            onClose={() => setOpenFolderId(null)}
            onSpaceClick={handleSpaceClick}
            onSpaceContextMenu={handleSpaceContextMenu}
            onRename={(name) => handleFolderRename(openFolderId, name)}
            onDragStart={(e, spaceId) => handleDragStart(e, spaceId, 'space', openFolderId)}
            onReorder={(ids) => handleReorderInFolder(openFolderId!, ids)}
            onParentDragEnd={handleDragEnd}
          />
        );
      })()}
    </nav>
  );
}
