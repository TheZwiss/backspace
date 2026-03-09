import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import { VoiceModMenuItems } from './VoiceModContextMenu';
import { useSpaceStore } from '../../stores/spaceStore';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import type { UserTile } from '../../hooks/useLiveKit';
import { getChannelOrigin } from '../../stores/spaceStore';

interface VoiceUserProps {
  tile: UserTile;
  large?: boolean;
}

export function VoiceUser({ tile, large }: VoiceUserProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const { participant } = tile;
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const participantVolumes = useVoiceStore((s) => s.participantVolumes);
  const isSpeaking = useVoiceStore((s) => s.speakingParticipantIds.has(participant.identity));
  const serverMutedUserIds = useVoiceStore((s) => s.serverMutedUserIds);
  const serverDeafenedUserIds = useVoiceStore((s) => s.serverDeafenedUserIds);
  const spaceId = useSpaceStore((s) => currentVoiceChannelId ? s.channelToSpaceMap.get(currentVoiceChannelId) : null);

  const [, forceUpdate] = useState(0);

  const perUserVolume = participantVolumes.get(participant.userId) ?? 100;
  const isLocal = participant.isLocal;
  const avatarUserId = participant.homeUserId ?? participant.userId;

  // --- VIDEO & UI ---

  const activeVideoTrack = tile.videoTrack;
  const hasVideo = activeVideoTrack !== null;

  // Force re-render when tracks end/mute
  useEffect(() => {
    if (!tile.videoTrack) return;
    const onEnded = () => forceUpdate((n) => n + 1);
    tile.videoTrack.addEventListener('ended', onEnded);
    return () => tile.videoTrack?.removeEventListener('ended', onEnded);
  }, [tile.videoTrack]);

  // Attach Video — use LiveKit's track.attach() to register the element
  // with the adaptive stream observer (enables SFU layer switching by viewport size)
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const lkTrack = tile.lkVideoTrack;
    if (lkTrack) {
      lkTrack.attach(videoEl);
      return () => { lkTrack.detach(videoEl); };
    } else {
      videoEl.srcObject = null;
    }
  }, [tile.lkVideoTrack]);

  // Context Menu
  const menuRef = useRef<HTMLDivElement>(null);
  const [volumeMenu, setVolumeMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocal) return;
      e.preventDefault();
      setVolumeMenu({ x: e.clientX, y: e.clientY });
    },
    [isLocal],
  );

  // Click-outside dismissal — mousedown + contains check
  useEffect(() => {
    if (!volumeMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setVolumeMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [volumeMenu]);

  // Viewport-aware positioning — direct DOM mutation, no state churn
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!volumeMenu || !el) return;
    const rect = el.getBoundingClientRect();
    let x = volumeMenu.x;
    let y = volumeMenu.y;
    if (rect.right > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (rect.bottom > window.innerHeight) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [volumeMenu]);

  return (
    <div
      className={`relative bg-surface-base rounded-xl overflow-hidden flex items-center justify-center group transition-all duration-200 ${
        isSpeaking
          ? 'ring-[3px] ring-status-online shadow-[0_0_12px_rgba(134,239,172,0.25)]'
          : 'ring-1 ring-white/[0.06] hover:ring-white/10'
      } ${large ? 'h-full w-full' : 'h-full aspect-video'}`}
      onContextMenu={handleContextMenu}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className={`w-full h-full ${large ? 'object-contain bg-black' : 'object-cover'}`}
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-surface-channel">
          <div className="relative">
            <Avatar
              src={null}
              name={participant.username}
              size={large ? 100 : 64}
              userId={avatarUserId}
            />
            {isSpeaking && (
              <div className="absolute -inset-1.5 rounded-full ring-[3px] ring-status-online animate-pulse" />
            )}
          </div>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/70 via-black/30 to-transparent">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`font-semibold text-white truncate ${large ? 'text-base' : 'text-[13px]'}`}
            >
              {participant.username}
            </span>
            {isLocal && (
              <span className="text-[10px] text-white/40 font-medium">
                (you)
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {(() => {
              const isServerMutedUser = spaceId ? serverMutedUserIds.has(`${spaceId}:${participant.userId}`) : false;
              const isServerDeafenedUser = spaceId ? serverDeafenedUserIds.has(`${spaceId}:${participant.userId}`) : false;
              const effectivelyMuted = participant.isMuted || isServerMutedUser || isServerDeafenedUser;
              const effectivelyDeafened = (isLocal ? isDeafened : participant.isDeafened) || isServerDeafenedUser;
              return (
                <>
                  {effectivelyMuted && (
                    <div className={`w-5 h-5 ${(isServerMutedUser || isServerDeafenedUser) ? 'bg-accent-amber/90' : 'bg-accent-rose/90'} rounded-full flex items-center justify-center`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                        <path d="M12 2C10.9 2 10 2.9 10 4V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V4C14 2.9 13.1 2 12 2Z" />
                        <line
                          x1="3"
                          y1="3"
                          x2="21"
                          y2="21"
                          stroke="white"
                          strokeWidth="2"
                        />
                      </svg>
                    </div>
                  )}
                  {effectivelyDeafened && (
                    <div className={`w-5 h-5 ${isServerDeafenedUser ? 'bg-accent-amber/90' : 'bg-accent-rose/90'} rounded-full flex items-center justify-center`}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                        <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
                        <line
                          x1="3"
                          y1="3"
                          x2="21"
                          y2="21"
                          stroke="white"
                          strokeWidth="2"
                        />
                      </svg>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </div>

      {volumeMenu && !isLocal && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className="fixed z-[200] bg-surface-elevated rounded-md shadow-elevation-high min-w-[200px] animate-fade-in"
          style={{ left: volumeMenu.x, top: volumeMenu.y }}
        >
          {/* Moderation options (renders nothing if no perms) */}
          {currentVoiceChannelId && (
            <VoiceModSection
              targetUserId={participant.userId}
              channelId={currentVoiceChannelId}
              onAction={() => setVolumeMenu(null)}
            />
          )}
          {/* Volume slider */}
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
                onChange={(e) =>
                  setParticipantVolume(
                    participant.userId,
                    parseInt(e.target.value),
                  )
                }
                className="flex-1 accent-accent-primary h-1"
              />
              <span className="text-xs text-txt-secondary min-w-[32px] text-right">
                {perUserVolume}%
              </span>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Renders moderation items + divider only when the user has mod perms. */
function VoiceModSection({ targetUserId, channelId, onAction }: {
  targetUserId: string;
  channelId: string;
  onAction: () => void;
}) {
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const myPerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;

  const hasMod =
    hasPermissionBit(myPerms, PermissionBits.MUTE_MEMBERS) ||
    hasPermissionBit(myPerms, PermissionBits.DEAFEN_MEMBERS) ||
    hasPermissionBit(myPerms, PermissionBits.MOVE_MEMBERS);

  if (!hasMod) return null;

  return (
    <>
      <div className="py-1.5">
        <VoiceModMenuItems
          targetUserId={targetUserId}
          channelId={channelId}
          onAction={onAction}
        />
      </div>
      <div className="h-px bg-white/[0.06] mx-1.5" />
    </>
  );
}
