import React, { useState, useCallback } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { Avatar } from '../ui/Avatar';
import { VoiceUserContextMenu } from './VoiceUserContextMenu';
import { wsSend } from '../../hooks/useWebSocket';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';

const EMPTY_VOICE_USERS: string[] = [];

interface VoiceChannelDragState {
  userId: string;
  fromChannelId: string;
}

interface VoiceChannelProps {
  channelId: string;
  channelName: string;
  onClick: () => void;
  locked?: boolean;
  dragState?: VoiceChannelDragState | null;
  onDragStart?: (userId: string) => void;
  onDragEnd?: () => void;
}

export function VoiceChannel({ channelId, channelName, onClick, locked, dragState, onDragStart, onDragEnd }: VoiceChannelProps) {
  const voiceUsers = useVoiceStore((s) => s.voiceUsers.get(channelId)) ?? EMPTY_VOICE_USERS;
  const currentVoiceChannel = useVoiceStore((s) => s.currentVoiceChannelId);
  const participants = useVoiceStore((s) => s.participants);
  const localIsDeafened = useVoiceStore((s) => s.isDeafened);
  const localIsMuted = useVoiceStore((s) => s.isMuted);
  const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const permissionMutedUserIds = useVoiceStore((s) => s.permissionMutedUserIds);
  const participantMutes = useVoiceStore((s) => s.participantMutes);
  const unwatchedCameras = useVoiceStore((s) => s.unwatchedCameras);
  const currentUserId = useVoiceStore((s) => {
    const local = s.participants.find(p => p.isLocal);
    return local?.userId ?? null;
  });
  const members = useSpaceStore((s) => s.members);
  const channelToSpaceMap = useSpaceStore((s) => s.channelToSpaceMap);
  const myUser = useAuthStore((s) => s.user);
  const isActive = currentVoiceChannel === channelId;

  // Drag-and-drop permission check
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const myPerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;
  const canMoveMembers = hasPermissionBit(myPerms, PermissionBits.MOVE_MEMBERS);

  // Drop target highlight state
  const [isDragOver, setIsDragOver] = useState(false);
  const isValidDropTarget = dragState !== null && dragState !== undefined && dragState.fromChannelId !== channelId;

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; userId: string } | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, userId: string) => {
      if (userId === myUser?.id) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, userId });
    },
    [myUser?.id],
  );

  return (
    <div
      onDragOver={(e) => {
        if (isValidDropTarget) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setIsDragOver(true);
        }
      }}
      onDragEnter={(e) => {
        if (isValidDropTarget) {
          e.preventDefault();
          setIsDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the container (not entering a child)
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        if (dragState && dragState.fromChannelId !== channelId) {
          const voiceOrigin = getChannelOrigin(dragState.fromChannelId);
          wsSend({ type: 'voice_move', userId: dragState.userId, targetChannelId: channelId }, voiceOrigin);
          onDragEnd?.();
        }
      }}
      className={isDragOver && isValidDropTarget ? 'rounded-[8px] ring-1 ring-accent-mint/40' : ''}
    >
      <button
        onClick={onClick}
        className={`relative w-full flex items-center gap-1.5 px-[10px] h-8 rounded-[6px] group transition-colors ${
          locked
            ? 'text-txt-tertiary/50 cursor-not-allowed'
            : isActive
              ? 'bg-surface-elevated text-txt-primary'
              : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
        }`}
        title={locked ? "You don't have permission to connect to this channel" : undefined}
      >
        {isActive && !locked && (
          <div
            className="absolute -left-[2px] top-1/2 -translate-y-1/2 w-[3px] bg-white rounded-r-full"
            style={{ height: '55%', opacity: 0.7 }}
          />
        )}
        {locked ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 text-[#6e6e7a]/50">
            <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 text-[#6e6e7a]">
            <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46ZM19.07 4.93C20.91 6.77 22 9.28 22 12C22 14.72 20.91 17.23 19.07 19.07L17.66 17.66C19.11 16.21 20 14.21 20 12C20 9.79 19.11 7.79 17.66 6.34L19.07 4.93Z" />
          </svg>
        )}
        <span className="truncate text-[15px] font-medium">{channelName}</span>
      </button>

      {/* Connected users */}
      {voiceUsers.length > 0 && (
        <div className="ml-9 mt-0.5 space-y-0.5">
          {voiceUsers.map((userId) => {
            const member = members.find(m => m.userId === userId);
            const participant = participants.find(p => p.userId === userId);
            const displayName = member?.user.displayName ?? member?.user.username ?? participant?.username ?? userId;
            const avatar = member?.user.avatar ?? null;
            const status = member?.user.status;
            const wsStatus = voiceUserStates.get(userId);
            const isParticipantDeafened = userId === currentUserId
              ? localIsDeafened
              : (participant?.isDeafened ?? wsStatus?.isDeafened ?? false);
            const isMuted = userId === currentUserId
              ? localIsMuted
              : (participant?.isMuted ?? wsStatus?.isMuted ?? false);
            const hasCamera = participant?.isCameraOn ?? wsStatus?.isCameraOn ?? false;
            const isScreenSharing = participant?.isScreenSharing ?? wsStatus?.isScreenSharing ?? false;
            const spaceId = channelToSpaceMap.get(channelId);
            const isSpaceMuted = spaceMutedUserIds.has(`${spaceId}:${userId}`);
            const isSpaceDeafened = spaceDeafenedUserIds.has(`${spaceId}:${userId}`);
            const isPermissionMuted = permissionMutedUserIds.has(`${spaceId}:${userId}`);

            const isDraggable = canMoveMembers && userId !== myUser?.id;
            const isBeingDragged = dragState?.userId === userId && dragState?.fromChannelId === channelId;

            return (
              <div
                key={userId}
                className={`flex items-center gap-2 px-[10px] py-1 rounded-[6px] hover:bg-interactive-hover transition-colors ${
                  isDraggable ? 'cursor-grab active:cursor-grabbing' : ''
                } ${isBeingDragged ? 'opacity-50' : ''}`}
                draggable={isDraggable}
                onDragStart={(e) => {
                  if (!isDraggable) return;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', userId);
                  onDragStart?.(userId);
                }}
                onDragEnd={() => onDragEnd?.()}
                onContextMenu={(e) => handleContextMenu(e, userId)}
              >
                <Avatar
                  src={avatar}
                  name={displayName}
                  size={24}
                  status={status}
                  userId={member?.user.homeUserId ?? userId}
                  user={member?.user}
                />
                <span className="text-[13px] text-txt-secondary truncate flex-1 min-w-0">{displayName}</span>
                {/* Status badges */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {(isSpaceMuted || isSpaceDeafened || isPermissionMuted) && (
                    <span title={isPermissionMuted ? "Muted (No Speak Permission)" : isSpaceMuted ? "Space Muted" : "Muted (Space Deafened)"}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-accent-amber">
                        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                        <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                      </svg>
                    </span>
                  )}
                  {isSpaceDeafened && (
                    <span title="Space Deafened">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-accent-amber">
                        <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
                        <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                      </svg>
                    </span>
                  )}
                  {!isSpaceMuted && !isSpaceDeafened && !isPermissionMuted && isMuted && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-danger">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                      <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  )}
                  {!isSpaceDeafened && isParticipantDeafened && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-danger">
                      <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
                      <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  )}
                  {hasCamera && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
                      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                      {userId !== myUser?.id && unwatchedCameras.has(userId) && (
                        <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                      )}
                    </svg>
                  )}
                  {isScreenSharing && (
                    <span className="bg-accent-rose text-white text-[9px] font-bold px-1 rounded leading-[14px]">LIVE</span>
                  )}
                  {userId !== myUser?.id && participantMutes.get(userId) && (
                    <span title="Locally Muted">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
                        <path d="M3 9v6h4l5 5V4L7 9H3z" />
                        <line x1="17" y1="7" x2="23" y2="13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                        <line x1="23" y1="7" x2="17" y2="13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                      </svg>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Voice moderation context menu (portalled to body) */}
      {contextMenu && (
        <VoiceUserContextMenu
          targetUserId={contextMenu.userId}
          channelId={channelId}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          isLocal={false}
        />
      )}
    </div>
  );
}
