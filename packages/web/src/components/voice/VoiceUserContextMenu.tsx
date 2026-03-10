import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { getActiveRoom, setCameraSubscription } from '../../hooks/useLiveKit';

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
  const canDisconnectMembers = hasPermissionBit(myPerms, PermissionBits.DISCONNECT_MEMBERS);

  const otherVoiceChannels = channels.filter(
    (c) => (c.type === 'voice' || c.type === 'video') && c.id !== channelId,
  );

  const voiceOrigin = getChannelOrigin(channelId);
  const spaceId = useSpaceStore((s) => s.channelToSpaceMap.get(channelId));

  const isServerMuted = serverMutedUserIds.has(`${spaceId}:${targetUserId}`);
  const isServerDeafened = serverDeafenedUserIds.has(`${spaceId}:${targetUserId}`);

  if (!canMuteMembers && !canDeafenMembers && !canMoveMembers && !canDisconnectMembers) return null;

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

  const handleDisconnect = () => {
    wsSend({ type: 'voice_disconnect', userId: targetUserId }, voiceOrigin);
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
      {canDisconnectMembers && (
        <>
          <div className="h-px bg-white/[0.06] my-1 mx-1.5" />
          <button onClick={handleDisconnect} className={`${btnClass} text-red-400 hover:text-white`} style={btnStyle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 010-1.36C3.36 8.68 7.42 7 12 7s8.64 1.68 11.71 4.72c.18.18.29.44.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
            </svg>
            Disconnect
          </button>
        </>
      )}
      {canMoveMembers && otherVoiceChannels.length > 0 && (
        <MoveToSubmenu channels={otherVoiceChannels} onMove={handleMove} btnClass={btnClass} btnStyle={btnStyle} />
      )}
    </>
  );
}

// ─── "Move to" hover flyout submenu ──────────────────────────────────────────

interface MoveToSubmenuProps {
  channels: { id: string; name: string }[];
  onMove: (channelId: string) => void;
  btnClass: string;
  btnStyle: React.CSSProperties;
}

function MoveToSubmenu({ channels, onMove, btnClass, btnStyle }: MoveToSubmenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startCloseTimer = useCallback(() => {
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }, []);

  const cancelCloseTimer = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  // Position the flyout relative to the trigger
  useLayoutEffect(() => {
    const flyout = flyoutRef.current;
    const trigger = triggerRef.current;
    if (!open || !flyout || !trigger) return;

    const tRect = trigger.getBoundingClientRect();
    const fRect = flyout.getBoundingClientRect();
    const gap = 4;

    // Horizontal: prefer right, flip left if overflowing
    let left = tRect.right + gap;
    if (left + fRect.width > window.innerWidth) {
      left = tRect.left - fRect.width - gap;
    }
    if (left < 8) left = 8;

    // Vertical: align top with trigger, clamp to viewport
    let top = tRect.top;
    if (top + fRect.height > window.innerHeight - 8) {
      top = window.innerHeight - fRect.height - 8;
    }
    if (top < 8) top = 8;

    flyout.style.left = `${left}px`;
    flyout.style.top = `${top}px`;

    const availableHeight = window.innerHeight - top - 8;
    const maxHeight = Math.max(availableHeight, 120);
    flyout.style.maxHeight = `${maxHeight}px`;
  }, [open]);

  return (
    <>
      <div className="h-px bg-white/[0.06] my-1 mx-1.5" />
      <button
        ref={triggerRef}
        className={btnClass}
        style={btnStyle}
        onMouseEnter={() => { cancelCloseTimer(); setOpen(true); }}
        onMouseLeave={startCloseTimer}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
          <path d="M14 4l2.29 2.29-2.88 2.88 1.42 1.42 2.88-2.88L20 10V4h-6zM10 4H4v6l2.29-2.29 4.71 4.7V20h2v-8.41l-5.29-5.3L10 4z" />
        </svg>
        <span className="flex-1">Move to</span>
        <span className="text-txt-tertiary text-xs ml-auto">›</span>
      </button>
      {open && ReactDOM.createPortal(
        <div
          ref={flyoutRef}
          className="fixed z-[210] bg-surface-elevated rounded-md shadow-elevation-high py-1.5 min-w-[160px] overflow-y-auto scrollbar-thin animate-fade-in"
          style={{ left: -9999, top: -9999 }}
          onMouseEnter={cancelCloseTimer}
          onMouseLeave={startCloseTimer}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => onMove(ch.id)}
              className={btnClass}
              style={btnStyle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 text-txt-tertiary">
                <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" />
              </svg>
              <span className="truncate">{ch.name}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

// ─── Standalone portalled context menu ─────────────────────────────────────────

interface VoiceUserContextMenuProps {
  targetUserId: string;
  channelId: string;
  position: { x: number; y: number };
  onClose: () => void;
  isLocal: boolean;
}

/**
 * Unified voice user context menu rendered via createPortal to document.body.
 * Shows moderation items (if perms) + volume slider (always, for remote users).
 * Includes viewport-aware positioning and click-outside dismissal.
 */
export function VoiceUserContextMenu({ targetUserId, channelId, position, onClose, isLocal }: VoiceUserContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const myPerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;
  const canMuteMembers = hasPermissionBit(myPerms, PermissionBits.MUTE_MEMBERS);
  const canDeafenMembers = hasPermissionBit(myPerms, PermissionBits.DEAFEN_MEMBERS);
  const canMoveMembers = hasPermissionBit(myPerms, PermissionBits.MOVE_MEMBERS);
  const canDisconnectMembers = hasPermissionBit(myPerms, PermissionBits.DISCONNECT_MEMBERS);
  const hasModPerms = canMuteMembers || canDeafenMembers || canMoveMembers || canDisconnectMembers;

  const participantVolumes = useVoiceStore((s) => s.participantVolumes);
  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);
  const perUserVolume = participantVolumes.get(targetUserId) ?? 100;

  const unwatchedCameras = useVoiceStore((s) => s.unwatchedCameras);
  const participants = useVoiceStore((s) => s.participants);
  const targetParticipant = participants.find((p) => p.userId === targetUserId);
  const targetHasCamera = targetParticipant?.isCameraOn ?? false;
  const isCameraUnwatched = unwatchedCameras.has(targetUserId);

  // Click-outside dismissal
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Viewport-aware positioning — direct DOM mutation, no extra state/render
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = position.x;
    let y = position.y;
    if (rect.right > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (rect.bottom > window.innerHeight) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [position]);

  if (isLocal) return null;

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className="fixed z-[200] bg-surface-elevated rounded-md shadow-elevation-high min-w-[200px] max-h-[calc(100vh-16px)] overflow-y-auto scrollbar-thin animate-fade-in"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {hasModPerms && (
        <>
          <div className="py-1.5">
            <VoiceModMenuItems
              targetUserId={targetUserId}
              channelId={channelId}
              onAction={onClose}
            />
          </div>
          <div className="h-px bg-white/[0.06] mx-1.5" />
        </>
      )}
      {targetHasCamera && (
        <>
          <div className="py-1.5">
            <button
              onClick={() => {
                const room = getActiveRoom();
                const identity = targetParticipant?.identity;
                if (isCameraUnwatched) {
                  useVoiceStore.getState().rewatchCamera(targetUserId);
                  if (identity) setCameraSubscription(room, identity, true);
                } else {
                  useVoiceStore.getState().unwatchCamera(targetUserId);
                  if (identity) setCameraSubscription(room, identity, false);
                }
                onClose();
              }}
              className="w-full text-left px-2 py-1.5 mx-1.5 text-sm rounded-sm flex items-center gap-2 text-txt-secondary hover:bg-accent-primary hover:text-white"
              style={{ width: 'calc(100% - 12px)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
                {isCameraUnwatched ? (
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                ) : (
                  <>
                    <path d="M17 10.5V7c0-.55-.45-1-1-1H2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                    <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </>
                )}
              </svg>
              {isCameraUnwatched ? 'Watch Camera' : 'Stop Watching Camera'}
            </button>
          </div>
          <div className="h-px bg-white/[0.06] mx-1.5" />
        </>
      )}
      <div className="p-3">
        <div className="text-xs text-txt-tertiary mb-2 font-medium uppercase tracking-wider">
          User Volume
        </div>
        <div className="flex items-center gap-2">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="text-txt-tertiary flex-shrink-0"
          >
            <path d="M3 9v6h4l5 5V4L7 9H3z" />
          </svg>
          <input
            type="range"
            min="0"
            max="200"
            value={perUserVolume}
            onChange={(e) => setParticipantVolume(targetUserId, parseInt(e.target.value))}
            className="flex-1 accent-accent-primary h-1"
          />
          <span className="text-xs text-txt-secondary min-w-[32px] text-right">
            {perUserVolume}%
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
