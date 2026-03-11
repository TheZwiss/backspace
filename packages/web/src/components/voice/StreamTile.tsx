import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import { getActiveRoom, setStreamSubscription } from '../../hooks/useLiveKit';
import { StreamContextMenu } from './StreamContextMenu';
import { useVoiceParticipantMeta } from '../../hooks/useVoiceParticipantMeta';
import type { StreamTile as StreamTileType } from '../../hooks/useLiveKit';

interface StreamTileProps {
  tile: StreamTileType;
  large?: boolean;
}

export function StreamTile({ tile, large }: StreamTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const watchingStreams = useVoiceStore((s) => s.watchingStreams);

  const { participant } = tile;
  const isLocal = participant.isLocal;
  const userId = participant.userId;
  const avatarUserId = participant.homeUserId ?? userId;
  const { displayName, avatar, user } = useVoiceParticipantMeta(participant);

  const isWatching = watchingStreams.has(userId);

  const liveScreenTrack = tile.screenTrack?.readyState === 'live' ? tile.screenTrack : null;
  const liveLkScreenTrack = liveScreenTrack ? tile.lkScreenTrack : null;

  // Quality badge state
  const [qualityBadge, setQualityBadge] = useState<string>('');

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // --- VIDEO --- use LiveKit's track.attach() to register the element
  // with the adaptive stream observer (enables SFU layer switching by viewport size)
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (liveLkScreenTrack) {
      liveLkScreenTrack.attach(videoEl);
      return () => { liveLkScreenTrack.detach(videoEl); };
    } else {
      videoEl.srcObject = null;
    }
  }, [liveLkScreenTrack]);

  // Quality badge (poll every 3s)
  useEffect(() => {
    if (!liveScreenTrack) {
      setQualityBadge('');
      return;
    }
    const update = () => {
      const settings = liveScreenTrack.getSettings();
      const h = settings.height ?? 0;
      const fps = Math.round(settings.frameRate ?? 0);
      if (h > 0 && fps > 0) {
        setQualityBadge(`${h}P ${fps}FPS`);
      } else if (h > 0) {
        setQualityBadge(`${h}P`);
      }
    };
    update();
    const interval = setInterval(update, 3000);
    return () => clearInterval(interval);
  }, [liveScreenTrack]);

  // Force re-render on track end
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!tile.screenTrack) return;
    const onEnded = () => forceUpdate((n) => n + 1);
    tile.screenTrack.addEventListener('ended', onEnded);
    return () => tile.screenTrack?.removeEventListener('ended', onEnded);
  }, [tile.screenTrack]);

  // --- CONTEXT MENU ---
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    [],
  );

  const handleWatch = useCallback(() => {
    useVoiceStore.getState().watchStream(userId);
    setStreamSubscription(getActiveRoom(), participant.identity, true);
  }, [userId, participant.identity]);

  const hasVideo = liveScreenTrack !== null;

  return (
    <div
      className={`relative bg-surface-base rounded-xl overflow-hidden flex items-center justify-center group transition-all duration-200 ring-1 ring-white/[0.06] hover:ring-white/10 ${
        'h-full w-full'
      }`}
      onContextMenu={handleContextMenu}
    >
      {hasVideo && isWatching ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain bg-black"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-surface-channel">
          <div className="relative">
            <Avatar src={avatar} name={displayName} size={large ? 80 : 48} userId={avatarUserId} user={user ?? undefined} />
          </div>
          <div className="text-center px-4">
            <p className="text-txt-primary text-sm font-semibold">
              {displayName} is streaming
            </p>
            {!isLocal && (
              <button
                onClick={handleWatch}
                className="mt-2 px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/80 rounded text-white text-xs font-semibold transition-colors"
              >
                Watch Stream
              </button>
            )}
          </div>
        </div>
      )}

      {/* LIVE badge — top left */}
      <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-accent-rose rounded text-[11px] font-bold text-white uppercase tracking-wide">
        LIVE
      </div>

      {/* Quality badge — top right */}
      {qualityBadge && hasVideo && (
        <div className="absolute top-2 right-2 px-1.5 py-0.5 bg-black/60 rounded text-[10px] font-bold text-white/70 uppercase tracking-wide">
          {qualityBadge}
        </div>
      )}

      {/* Bottom overlay */}
      <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/70 via-black/30 to-transparent">
        <div className="flex items-center gap-1.5 min-w-0">
          {/* Screen icon */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="text-white/70 flex-shrink-0"
          >
            <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" />
          </svg>
          <span
            className={`font-semibold text-white truncate ${large ? 'text-base' : 'text-[13px]'}`}
          >
            {displayName}
          </span>
          {isLocal && (
            <span className="text-[10px] text-white/40 font-medium">(you)</span>
          )}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <StreamContextMenu
          userId={userId}
          identity={participant.identity}
          isLocal={isLocal}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
