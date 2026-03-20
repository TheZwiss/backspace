import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import { useContextMenuStore, type ContextMenuItem } from '../../stores/contextMenuStore';
import { buildVoiceModMenuItems, VolumeSliderItem } from './voiceMenuItems';
import { useSpaceStore } from '../../stores/spaceStore';
import { useVoiceParticipantMeta } from '../../hooks/useVoiceParticipantMeta';
import { getActiveRoom, setCameraSubscription } from '../../hooks/useLiveKit';
import type { UserTile } from '../../hooks/useLiveKit';

interface VoiceUserProps {
  tile: UserTile;
  large?: boolean;
}

export function VoiceUser({ tile, large }: VoiceUserProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const { participant } = tile;
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isSpeaking = useVoiceStore((s) => s.speakingParticipantIds.has(participant.identity));
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const permissionMutedUserIds = useVoiceStore((s) => s.permissionMutedUserIds);
  const unwatchedCameras = useVoiceStore((s) => s.unwatchedCameras);
  const participantMutes = useVoiceStore((s) => s.participantMutes);
  const spaceId = useSpaceStore((s) => currentVoiceChannelId ? s.channelToSpaceMap.get(currentVoiceChannelId) : null);

  const openContextMenu = useContextMenuStore((s) => s.open);

  const [, forceUpdate] = useState(0);

  const isLocal = participant.isLocal;
  const avatarUserId = participant.homeUserId ?? participant.userId;
  const { displayName, avatar, user } = useVoiceParticipantMeta(participant);

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
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocal || !currentVoiceChannelId) return;
      e.preventDefault();
      e.stopPropagation();

      const targetUserId = participant.userId;
      const channelId = currentVoiceChannelId;

      // Build moderation items
      const modItems = buildVoiceModMenuItems(targetUserId, channelId);

      const items: ContextMenuItem[] = [...modItems];

      // Separator after mod items
      if (modItems.length > 0) {
        items.push({ key: 'mod-end-sep', type: 'separator' });
      }

      // Camera watch/unwatch
      const targetParticipant = useVoiceStore.getState().participants.find((p) => p.userId === targetUserId);
      const targetHasCamera = targetParticipant?.isCameraOn ?? false;
      const isCameraUnwatched = useVoiceStore.getState().unwatchedCameras.has(targetUserId);

      if (targetHasCamera) {
        items.push({
          key: 'camera-toggle',
          type: 'action',
          label: isCameraUnwatched ? 'Watch Camera' : 'Stop Watching Camera',
          icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
            ...(isCameraUnwatched
              ? [React.createElement('path', { key: 'cam', d: 'M17 10.5V7c0-.55-.45-1-1-1H2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z' })]
              : [
                  React.createElement('path', { key: 'cam', d: 'M17 10.5V7c0-.55-.45-1-1-1H2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z' }),
                  React.createElement('line', { key: 'slash', x1: 1, y1: 1, x2: 23, y2: 23, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
                ]),
          ),
          onClick: () => {
            const room = getActiveRoom();
            const identity = targetParticipant?.identity;
            if (isCameraUnwatched) {
              useVoiceStore.getState().rewatchCamera(targetUserId);
              if (identity) setCameraSubscription(room, identity, true);
            } else {
              useVoiceStore.getState().unwatchCamera(targetUserId);
              if (identity) setCameraSubscription(room, identity, false);
            }
          },
        });
        items.push({ key: 'camera-sep', type: 'separator' });
      }

      // Mute User checkbox
      const isUserMuted = useVoiceStore.getState().participantMutes.get(targetUserId) ?? false;
      items.push({
        key: 'mute-user',
        type: 'checkbox',
        label: 'Mute User',
        checked: isUserMuted,
        onChange: (checked) => useVoiceStore.getState().setParticipantMute(targetUserId, checked),
      });

      items.push({ key: 'vol-sep', type: 'separator' });

      // Volume slider (custom, needs store subscription via wrapper component)
      items.push({
        key: 'volume',
        type: 'custom',
        render: () => React.createElement(VolumeSliderItem, { userId: targetUserId }),
      });

      openContextMenu({ x: e.clientX, y: e.clientY }, items);
    },
    [isLocal, currentVoiceChannelId, participant.userId, openContextMenu],
  );

  return (
    <div
      className={`relative bg-surface-base rounded-xl overflow-hidden flex items-center justify-center group transition-all duration-200 ${
        isSpeaking
          ? 'ring-[3px] ring-status-online shadow-[0_0_12px_rgba(134,239,172,0.25)]'
          : 'ring-1 ring-white/[0.06] hover:ring-white/10'
      } h-full w-full`}
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
          <div className="relative flex">
            <Avatar
              src={avatar}
              name={displayName}
              size={large ? 100 : 64}
              userId={avatarUserId}
              user={user ?? undefined}
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
              {displayName}
            </span>
            {isLocal && (
              <span className="text-[10px] text-white/40 font-medium">
                (you)
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {(() => {
              const isSpaceMutedUser = spaceId ? spaceMutedUserIds.has(`${spaceId}:${participant.userId}`) : false;
              const isSpaceDeafenedUser = spaceId ? spaceDeafenedUserIds.has(`${spaceId}:${participant.userId}`) : false;
              const isPermissionMutedUser = spaceId ? permissionMutedUserIds.has(`${spaceId}:${participant.userId}`) : false;
              const effectivelyMuted = participant.isMuted || isSpaceMutedUser || isSpaceDeafenedUser || isPermissionMutedUser;
              const effectivelyDeafened = (isLocal ? isDeafened : participant.isDeafened) || isSpaceDeafenedUser;
              return (
                <>
                  {effectivelyMuted && (
                    <div className={`w-5 h-5 ${(isSpaceMutedUser || isSpaceDeafenedUser || isPermissionMutedUser) ? 'bg-accent-amber/90' : 'bg-accent-rose/90'} rounded-full flex items-center justify-center`}>
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
                    <div className={`w-5 h-5 ${isSpaceDeafenedUser ? 'bg-accent-amber/90' : 'bg-accent-rose/90'} rounded-full flex items-center justify-center`}>
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
                  {!isLocal && participant.isCameraOn && (
                    <div className="w-5 h-5 bg-white/20 rounded-full flex items-center justify-center">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                        <path d="M17 10.5V7c0-.55-.45-1-1-1H2c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                        {unwatchedCameras.has(participant.userId) && (
                          <line x1="1" y1="1" x2="23" y2="23" stroke="white" strokeWidth="2" strokeLinecap="round" />
                        )}
                      </svg>
                    </div>
                  )}
                  {!isLocal && participantMutes.get(participant.userId) && (
                    <div className="w-5 h-5 bg-white/20 rounded-full flex items-center justify-center" title="Locally Muted">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                        <path d="M3 9v6h4l5 5V4L7 9H3z" />
                        <line x1="17" y1="7" x2="23" y2="13" stroke="white" strokeWidth="2" strokeLinecap="round" />
                        <line x1="23" y1="7" x2="17" y2="13" stroke="white" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
