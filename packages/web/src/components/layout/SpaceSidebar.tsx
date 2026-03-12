import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSpaceStore, getMyUserIdForOrigin } from '../../stores/spaceStore';
import type { TaggedSpace } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';
import { Tooltip } from '../ui/Tooltip';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import type { SpaceLayoutItem, SpaceFolder } from '@backspace/shared';

import { getSpaceGradient, HOME_GRADIENT } from '../../utils/gradients';
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
      return { background: HOME_GRADIENT.gradient };
    }

    // Space type — if it has a custom icon image, no gradient needed
    if (icon) return undefined;

    const spaceGrad = getSpaceGradient(id, name, avatarColor);
    return { background: spaceGrad.gradient };
  }, [type, id, name, icon, avatarColor, isHovered]);

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
        <span className="text-[17px] font-bold">B</span>
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
          src={icon.startsWith('http') ? icon : `/api/uploads/${icon}`}
          alt={name}
          className="w-full h-full object-cover"
        />
      ) : (
        <span className="text-[15px] font-bold">{firstLetter}</span>
      )}
    </button>
  );

  const innerContent = (
    <div className={`relative ${dropIndicator === 'merge' ? 'scale-110 ring-2 ring-accent-mint/60 rounded-[16px]' : ''} transition-transform duration-150`}>
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
      {/* Drop indicator lines */}
      {dropIndicator === 'before' && (
        <div className="absolute top-0 left-3 right-3 h-[2px] bg-accent-mint rounded-full z-10" />
      )}
      {dropIndicator === 'after' && (
        <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-accent-mint rounded-full z-10" />
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
        src={icon.startsWith('http') ? icon : `/api/uploads/${icon}`}
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

// ─── Folder context menu ──────────────────────────────────────────────────

function FolderContextMenu({ folder, x, y, onClose, onRename, onColorChange, onUngroup }: {
  folder: SpaceFolder;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onColorChange: (color: string | null) => void;
  onUngroup: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
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
  }, [onClose]);

  const menuWidth = 200;
  const menuHeight = 140;
  const clampedX = Math.min(x, window.innerWidth - menuWidth - 8);
  const clampedY = Math.min(y, window.innerHeight - menuHeight - 8);

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[160px] glass rounded-lg py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: clampedX, top: clampedY }}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-txt-primary hover:bg-white/[0.06] transition-colors"
        onClick={() => { onRename(); onClose(); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
        </svg>
        Rename Folder
      </button>
      <div className="px-3 py-1.5">
        <p className="text-[11px] text-txt-tertiary mb-1.5">Folder Color</p>
        <div className="flex gap-1.5">
          <button
            className={`w-5 h-5 rounded-full border-2 ${!folder.color ? 'border-white/40' : 'border-transparent'} bg-white/10`}
            onClick={() => { onColorChange(null); onClose(); }}
            title="Default"
          />
          {FOLDER_COLORS.map((c) => (
            <button
              key={c.name}
              className={`w-5 h-5 rounded-full border-2 ${folder.color === c.value ? 'border-white/40' : 'border-transparent'}`}
              style={{ background: c.value }}
              onClick={() => { onColorChange(c.value); onClose(); }}
              title={c.name}
            />
          ))}
        </div>
      </div>
      <div className="h-[1px] bg-white/[0.06] mx-2 my-1" />
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-accent-rose hover:bg-accent-rose/10 transition-colors"
        onClick={() => { onUngroup(); onClose(); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm12 6V8h-2v4H10v2h4v4h2v-4h4v-2h-4z" />
        </svg>
        Ungroup
      </button>
    </div>,
    document.body,
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
}) {
  const anchorRef = useRef<HTMLDivElement>(anchorEl);
  anchorRef.current = anchorEl;
  const floatingRef = useRef<HTMLDivElement>(null);

  const { style } = useFloatingPosition(anchorRef, floatingRef, {
    placement: 'right',
    offset: 12,
  });

  // Close on click-outside and Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        floatingRef.current && !floatingRef.current.contains(e.target as Node) &&
        !anchorEl.contains(e.target as Node)
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
              className="w-full bg-surface-input text-[11px] font-semibold uppercase tracking-wider text-txt-tertiary rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-accent-mint/40"
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
      {spaces.map((space) => {
        const isActive = currentSpaceId === space.id;
        const hasUnread = unreadSpaceIds.has(space.id) && !isActive;
        const origin = space._instanceOrigin;
        const isFederated = !!origin;
        const isDimmed = isFederated && disconnectedOrigins.has(origin);
        const icon = space.icon;
        const grad = !icon ? getSpaceGradient(space.id, space.name, space.avatarColor) : null;

        return (
          <button
            key={space.id}
            className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 mx-1 rounded-md transition-colors ${
              isDimmed ? 'opacity-40 saturate-50' : ''
            } ${isActive ? 'bg-white/[0.10]' : 'hover:bg-white/[0.06]'}`}
            style={{ width: 'calc(100% - 8px)' }}
            draggable
            onDragStart={(e) => onDragStart(e, space.id)}
            onClick={() => {
              onSpaceClick(space.id);
              onClose();
            }}
            onContextMenu={(e) => {
              onSpaceContextMenu(space.id, e);
              onClose();
            }}
          >
            {/* Space icon */}
            <div className="w-8 h-8 rounded-[10px] flex-shrink-0 overflow-hidden flex items-center justify-center" style={grad ? { background: grad.gradient } : undefined}>
              {icon ? (
                <img
                  src={icon.startsWith('http') ? icon : `/api/uploads/${icon}`}
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
        );
      })}
    </div>,
    document.body,
  );
}

// ─── SpaceContextMenu ─────────────────────────────────────────────────────

function SpaceContextMenu({ spaceId, x, y, onClose }: { spaceId: string; x: number; y: number; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const space = useSpaceStore((s) => s.spaces.find(sp => sp.id === spaceId));
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);
  const generateInvite = useSpaceStore((s) => s.generateInvite);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);
  const setShowDms = useUIStore((s) => s.setShowDms);
  const addToast = useUIStore((s) => s.addToast);
  const navigate = useNavigate();
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  const isOwner = space?.ownerId === getMyUserIdForOrigin((space as any)?._instanceOrigin ?? '');

  // Close on click-outside and scroll
  useEffect(() => {
    if (showTransferModal || showLeaveConfirm) return; // Don't close when sub-dialog is open
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleScroll = () => onClose();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, showTransferModal, showLeaveConfirm]);

  if (!space) return null;

  const handleInvite = async () => {
    try {
      const code = await generateInvite(spaceId);
      const origin = (space as any)._instanceOrigin || window.location.origin;
      const url = `${origin}/invite/${code}`;
      await navigator.clipboard.writeText(url);
      addToast('Invite link copied to clipboard', 'success', 3000);
    } catch {
      addToast('Failed to generate invite', 'warning', 3000);
    }
    onClose();
  };

  if (showTransferModal) {
    return (
      <TransferOwnershipModal
        spaceId={spaceId}
        onClose={onClose}
      />
    );
  }

  // Viewport-aware clamping — always 2 items (Invite + Transfer or Invite + Leave)
  const menuWidth = 200;
  const menuHeight = 2 * 32 + 8;
  const clampedX = Math.min(x, window.innerWidth - menuWidth - 8);
  const clampedY = Math.min(y, window.innerHeight - menuHeight - 8);

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[160px] glass rounded-lg py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: clampedX, top: clampedY }}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-txt-primary hover:bg-white/[0.06] transition-colors"
        onClick={handleInvite}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
        </svg>
        Invite People
      </button>
      {isOwner ? (
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-accent-amber hover:bg-accent-amber/10 transition-colors"
          onClick={() => setShowTransferModal(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z" />
          </svg>
          Transfer Ownership
        </button>
      ) : (
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-accent-rose hover:bg-accent-rose/10 transition-colors"
          onClick={() => setShowLeaveConfirm(true)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 00-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 002 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
          </svg>
          Leave Space
        </button>
      )}
      <ConfirmDialog
        isOpen={showLeaveConfirm}
        onClose={() => setShowLeaveConfirm(false)}
        onConfirm={() => {
          if (currentSpaceId === spaceId) {
            navigate('/channels/@me');
            setCurrentSpace(null);
            setShowDms(true);
          }
          leaveSpace(spaceId);
          setShowLeaveConfirm(false);
          onClose();
        }}
        title={`Leave ${space.name}`}
        description="Are you sure you want to leave this space? You'll need a new invite to rejoin."
        variant="danger"
        confirmLabel="Leave"
      />
    </div>,
    document.body,
  );
}

// ─── TransferOwnershipModal ───────────────────────────────────────────────

function TransferOwnershipModal({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const space = useSpaceStore((s) => s.spaces.find(sp => sp.id === spaceId));
  const members = useSpaceStore((s) => s.members);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const transferOwnership = useSpaceStore((s) => s.transferOwnership);
  const addToast = useUIStore((s) => s.addToast);

  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);

  // Filter members: exclude self, filter by search
  const filteredMembers = useMemo(() => {
    const spaceMembers = members.filter(m => m.userId !== currentUserId);
    if (!search.trim()) return spaceMembers;
    const q = search.toLowerCase();
    return spaceMembers.filter(m =>
      m.user.displayName?.toLowerCase().includes(q) ||
      m.user.username.toLowerCase().includes(q)
    );
  }, [members, currentUserId, search]);

  const selectedMember = selectedUserId ? members.find(m => m.userId === selectedUserId) : null;

  // Close on click-outside and escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedUserId) {
          setSelectedUserId(null);
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, selectedUserId]);

  if (!space) return null;

  const handleTransfer = async () => {
    if (!selectedUserId) return;
    setTransferring(true);
    try {
      await transferOwnership(spaceId, selectedUserId);
      addToast(`Ownership transferred to ${selectedMember?.user.displayName || selectedMember?.user.username}`, 'success', 3000);
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to transfer ownership', 'warning', 3000);
    } finally {
      setTransferring(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50">
      <div
        ref={modalRef}
        className="w-[380px] max-h-[480px] glass-modal rounded-xl flex flex-col animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-white/[0.06]">
          <h3 className="text-base font-semibold text-txt-primary">Transfer Ownership</h3>
          <p className="text-xs text-txt-tertiary mt-0.5">
            Choose a member to become the new owner of <span className="font-medium text-txt-secondary">{space.name}</span>
          </p>
        </div>

        {selectedUserId && selectedMember ? (
          /* Confirm step */
          <div className="p-4 flex flex-col gap-4">
            <div className="p-3 rounded-lg bg-accent-amber/10 border border-accent-amber/20">
              <p className="text-sm text-txt-secondary">
                Transfer ownership of <span className="font-semibold text-txt-primary">{space.name}</span> to{' '}
                <span className="font-semibold text-txt-primary">{selectedMember.user.displayName || selectedMember.user.username}</span>?
              </p>
              <p className="text-xs text-txt-tertiary mt-1.5">You will become a regular member.</p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setSelectedUserId(null)}
                className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary transition-colors"
                disabled={transferring}
              >
                Cancel
              </button>
              <button
                onClick={handleTransfer}
                disabled={transferring}
                className="px-3 py-1.5 bg-accent-amber hover:bg-accent-amber/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
              >
                {transferring ? 'Transferring...' : 'Transfer'}
              </button>
            </div>
          </div>
        ) : (
          /* Member list */
          <>
            <div className="px-3 pt-3">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search members..."
                className="w-full px-3 py-1.5 bg-surface-input rounded text-sm text-txt-primary placeholder-txt-tertiary outline-none focus:ring-1 focus:ring-accent-primary/50"
                autoFocus
              />
            </div>
            <div className="flex-1 overflow-y-auto p-2 min-h-0">
              {filteredMembers.length === 0 ? (
                <p className="text-xs text-txt-tertiary text-center py-4">No members found</p>
              ) : (
                filteredMembers.map((member) => {
                  const avatarUrl = member.user.avatar
                    ? (member.user.avatar.startsWith('http') ? member.user.avatar : `/api/uploads/${member.user.avatar}`)
                    : null;
                  return (
                    <button
                      key={member.userId}
                      onClick={() => setSelectedUserId(member.userId)}
                      className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-white/[0.06] transition-colors"
                    >
                      <div className="w-8 h-8 rounded-full bg-surface-input flex-shrink-0 overflow-hidden flex items-center justify-center">
                        {avatarUrl ? (
                          <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-xs font-bold text-txt-secondary">
                            {(member.user.displayName || member.user.username).charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-col items-start min-w-0">
                        <span className="text-sm text-txt-primary truncate max-w-full">
                          {member.user.displayName || member.user.username}
                        </span>
                        {member.user.displayName && (
                          <span className="text-[11px] text-txt-tertiary truncate max-w-full">
                            {member.user.username}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
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
      {/* Drop indicators */}
      {dropIndicator === 'before' && (
        <div className="absolute top-0 left-3 right-3 h-[2px] bg-accent-mint rounded-full z-10" />
      )}
      {dropIndicator === 'after' && (
        <div className="absolute bottom-0 left-3 right-3 h-[2px] bg-accent-mint rounded-full z-10" />
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

  // Context menus
  const [contextMenu, setContextMenu] = useState<{ spaceId: string; x: number; y: number } | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{ folder: SpaceFolder; x: number; y: number } | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);

  // DnD state
  const [dragState, setDragState] = useState<{ dragId: string; dragType: 'space' | 'folder'; sourceFolderId?: string } | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ targetId: string; position: 'before' | 'after' | 'merge' } | null>(null);

  const handleSpaceContextMenu = useCallback((spaceId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ spaceId, x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

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

    setDropIndicator({ targetId, position });
  }, [dragState]);

  const handleDragEnd = useCallback(() => {
    setDragState(null);
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!dragState || !dropIndicator) {
      handleDragEnd();
      return;
    }

    const { dragId, dragType, sourceFolderId } = dragState;
    const { targetId, position } = dropIndicator;

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
  }, [dragState, dropIndicator, resolvedLayout, spaceMap, handleDragEnd, persistLayout]);

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
    <nav data-pip-obstacle="left" className="w-[72px] bg-surface-base flex flex-col items-center py-3 overflow-y-auto flex-shrink-0 no-scrollbar select-none md:fixed md:inset-y-0 md:left-0 md:z-[100] md:glass-strip" style={{ paddingBottom: floatingPanelHeight + 24 }}>
      <SidebarItem
        id="@me"
        name="Direct Messages"
        active={showDms}
        onClick={handleDmClick}
        type="dm"
        hasUnread={hasDmUnread}
      />

      <div className="w-8 h-[2px] bg-interactive-muted rounded-full mb-1.5" />

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
              setFolderContextMenu({ folder, x: e.clientX, y: e.clientY });
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

      <div className="w-8 h-[2px] bg-interactive-muted rounded-full mb-1.5" />

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

      {contextMenu && (
        <SpaceContextMenu
          spaceId={contextMenu.spaceId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}

      {folderContextMenu && (
        <FolderContextMenu
          folder={folderContextMenu.folder}
          x={folderContextMenu.x}
          y={folderContextMenu.y}
          onClose={() => setFolderContextMenu(null)}
          onRename={() => {
            setRenamingFolderId(folderContextMenu.folder.id);
            setOpenFolderId(folderContextMenu.folder.id);
          }}
          onColorChange={(color) => handleFolderColorChange(folderContextMenu.folder.id, color)}
          onUngroup={() => handleUngroup(folderContextMenu.folder.id)}
        />
      )}

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
          />
        );
      })()}
    </nav>
  );
}
