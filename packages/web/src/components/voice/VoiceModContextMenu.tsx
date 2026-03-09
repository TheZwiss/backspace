import React, { useEffect, useLayoutEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';

interface VoiceModMenuItemsProps {
  targetUserId: string;
  channelId: string;
  onAction: () => void;
}

/**
 * Headless moderation menu items (mute/deafen/move buttons).
 * Renders nothing if the current user has no moderation permissions.
 * Use inside any container — no portal or positioning logic.
 */
export function VoiceModMenuItems({ targetUserId, channelId, onAction }: VoiceModMenuItemsProps) {
  const serverMutedUserIds = useVoiceStore((s) => s.serverMutedUserIds);
  const serverDeafenedUserIds = useVoiceStore((s) => s.serverDeafenedUserIds);

  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const channels = useSpaceStore((s) => s.channels);

  const myPerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;
  const canMuteMembers = hasPermissionBit(myPerms, PermissionBits.MUTE_MEMBERS);
  const canDeafenMembers = hasPermissionBit(myPerms, PermissionBits.DEAFEN_MEMBERS);
  const canMoveMembers = hasPermissionBit(myPerms, PermissionBits.MOVE_MEMBERS);

  const otherVoiceChannels = channels.filter(
    (c) => (c.type === 'voice' || c.type === 'video') && c.id !== channelId,
  );

  const voiceOrigin = getChannelOrigin(channelId);
  const spaceId = useSpaceStore((s) => s.channelToSpaceMap.get(channelId));

  const isServerMuted = serverMutedUserIds.has(`${spaceId}:${targetUserId}`);
  const isServerDeafened = serverDeafenedUserIds.has(`${spaceId}:${targetUserId}`);

  if (!canMuteMembers && !canDeafenMembers && !canMoveMembers) return null;

  const handleServerMute = () => {
    wsSend({ type: 'voice_server_mute', userId: targetUserId, muted: !isServerMuted }, voiceOrigin);
    onAction();
  };

  const handleServerDeafen = () => {
    wsSend({ type: 'voice_server_deafen', userId: targetUserId, deafened: !isServerDeafened }, voiceOrigin);
    onAction();
  };

  const handleMove = (targetChannelId: string) => {
    wsSend({ type: 'voice_move', userId: targetUserId, targetChannelId }, voiceOrigin);
    onAction();
  };

  const btnClass = 'w-full text-left px-2 py-1.5 mx-1.5 text-sm rounded-sm flex items-center gap-2 text-txt-secondary hover:bg-accent-primary hover:text-white';
  const btnStyle = { width: 'calc(100% - 12px)' };

  return (
    <>
      {canMuteMembers && (
        <button onClick={handleServerMute} className={btnClass} style={btnStyle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            {isServerMuted && (
              <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            )}
          </svg>
          {isServerMuted ? 'Server Unmute' : 'Server Mute'}
        </button>
      )}
      {canDeafenMembers && (
        <button onClick={handleServerDeafen} className={btnClass} style={btnStyle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
            <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
            {isServerDeafened && (
              <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            )}
          </svg>
          {isServerDeafened ? 'Server Undeafen' : 'Server Deafen'}
        </button>
      )}
      {canMoveMembers && otherVoiceChannels.length > 0 && (
        <>
          <div className="h-px bg-white/[0.06] my-1 mx-1.5" />
          <div className="px-3 py-1 text-[10px] text-txt-tertiary uppercase tracking-wider font-semibold">
            Move to...
          </div>
          {otherVoiceChannels.map((ch) => (
            <button key={ch.id} onClick={() => handleMove(ch.id)} className={btnClass} style={btnStyle}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 text-txt-tertiary">
                <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" />
              </svg>
              <span className="truncate">{ch.name}</span>
            </button>
          ))}
        </>
      )}
    </>
  );
}

// ─── Standalone portalled context menu ─────────────────────────────────────────

interface VoiceModContextMenuProps {
  targetUserId: string;
  channelId: string;
  position: { x: number; y: number };
  onClose: () => void;
}

/**
 * Full standalone moderation context menu rendered via createPortal to document.body.
 * Escapes any CSS containing-block / overflow clipping from parent transforms.
 * Includes viewport-aware positioning and click-outside dismissal.
 */
export function VoiceModContextMenu({ targetUserId, channelId, position, onClose }: VoiceModContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const myPerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;
  const canMuteMembers = hasPermissionBit(myPerms, PermissionBits.MUTE_MEMBERS);
  const canDeafenMembers = hasPermissionBit(myPerms, PermissionBits.DEAFEN_MEMBERS);
  const canMoveMembers = hasPermissionBit(myPerms, PermissionBits.MOVE_MEMBERS);
  const hasModPerms = canMuteMembers || canDeafenMembers || canMoveMembers;

  // Click-outside dismissal — always called (hooks must be unconditional)
  useEffect(() => {
    if (!hasModPerms) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [hasModPerms, onClose]);

  // Viewport-aware positioning — direct DOM mutation, no extra state/render
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!hasModPerms || !el) return;
    const rect = el.getBoundingClientRect();
    let x = position.x;
    let y = position.y;
    if (rect.right > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (rect.bottom > window.innerHeight) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [position, hasModPerms]);

  if (!hasModPerms) return null;

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className="fixed z-[200] bg-surface-elevated rounded-md shadow-elevation-high py-1.5 min-w-[180px] max-h-[calc(100vh-16px)] overflow-y-auto scrollbar-thin animate-fade-in"
      style={{ left: position.x, top: position.y }}
    >
      <VoiceModMenuItems
        targetUserId={targetUserId}
        channelId={channelId}
        onAction={onClose}
      />
    </div>,
    document.body,
  );
}
