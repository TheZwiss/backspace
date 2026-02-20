import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import { getActiveRoom, setStreamSubscription } from '../../hooks/useLiveKit';
import { VideoQualityPopover } from './VideoQualityPopover';
import type { StreamTile as StreamTileType } from '../../hooks/useLiveKit';

interface StreamTileProps {
  tile: StreamTileType;
  large?: boolean;
}

export function StreamTile({ tile, large }: StreamTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const streamVolumes = useVoiceStore((s) => s.streamVolumes);
  const streamMutes = useVoiceStore((s) => s.streamMutes);
  const watchingStreams = useVoiceStore((s) => s.watchingStreams);
  const streamAttenuationEnabled = useVoiceStore((s) => s.streamAttenuationEnabled);
  const streamAttenuationStrength = useVoiceStore((s) => s.streamAttenuationStrength);

  const { participant } = tile;
  const isLocal = participant.isLocal;
  const userId = participant.userId;

  const isWatching = watchingStreams.has(userId);
  const streamVolume = streamVolumes.get(userId) ?? 100;
  const isStreamMuted = streamMutes.get(userId) ?? false;

  const liveScreenTrack = tile.screenTrack?.readyState === 'live' ? tile.screenTrack : null;

  // Quality badge state
  const [qualityBadge, setQualityBadge] = useState<string>('');

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [qualityPopoverOpen, setQualityPopoverOpen] = useState(false);

  // --- VIDEO ---
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (liveScreenTrack) {
      videoEl.srcObject = new MediaStream([liveScreenTrack]);
    } else {
      videoEl.srcObject = null;
    }
  }, [liveScreenTrack]);

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

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const handleWatch = useCallback(() => {
    useVoiceStore.getState().watchStream(userId);
    setStreamSubscription(getActiveRoom(), participant.identity, true);
  }, [userId, participant.identity]);

  const handleUnwatch = useCallback(() => {
    useVoiceStore.getState().unwatchStream(userId);
    setStreamSubscription(getActiveRoom(), participant.identity, false);
  }, [userId, participant.identity]);

  const handleStopStreaming = useCallback(async () => {
    const room = getActiveRoom();
    if (room) {
      await room.localParticipant.setScreenShareEnabled(false);
      useVoiceStore.getState().toggleScreenShare();
    }
  }, []);

  const handleChangeStream = useCallback(async () => {
    const room = getActiveRoom();
    if (room) {
      await room.localParticipant.setScreenShareEnabled(false);
      // Small delay then re-start to re-trigger the source picker
      setTimeout(async () => {
        await room.localParticipant.setScreenShareEnabled(true, {
          audio: true,
        });
      }, 200);
    }
  }, []);

  const setStreamVolumeAction = useVoiceStore((s) => s.setStreamVolume);
  const setStreamMuteAction = useVoiceStore((s) => s.setStreamMute);
  const setAttenuationEnabled = useVoiceStore((s) => s.setStreamAttenuationEnabled);
  const setAttenuationStrength = useVoiceStore((s) => s.setStreamAttenuationStrength);

  const hasVideo = liveScreenTrack !== null;

  return (
    <div
      className={`relative bg-[#111214] rounded-xl overflow-hidden flex items-center justify-center group transition-all duration-200 ring-1 ring-white/[0.06] hover:ring-white/10 ${
        large ? 'h-full w-full' : 'h-full aspect-video'
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
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-[#1e1f22]">
          <div className="relative">
            <Avatar src={null} name={participant.username} size={large ? 80 : 48} />
          </div>
          <div className="text-center px-4">
            <p className="text-discord-text-primary text-sm font-semibold">
              {participant.username} is streaming
            </p>
            {!isLocal && (
              <button
                onClick={handleWatch}
                className="mt-2 px-4 py-1.5 bg-discord-blurple hover:bg-discord-blurple/80 rounded text-white text-xs font-semibold transition-colors"
              >
                Watch Stream
              </button>
            )}
          </div>
        </div>
      )}

      {/* LIVE badge — top left */}
      <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-discord-red rounded text-[11px] font-bold text-white uppercase tracking-wide">
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
            {participant.username}
          </span>
          {isLocal && (
            <span className="text-[10px] text-white/40 font-medium">(you)</span>
          )}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed z-[60] bg-[#111214] rounded-lg shadow-2xl p-2 min-w-[220px] border border-white/[0.06]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {isLocal ? (
            /* Streamer context menu (own stream) */
            <>
              <button
                onClick={() => {
                  handleStopStreaming();
                  setContextMenu(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-discord-red hover:bg-discord-red/10 rounded text-sm transition-colors"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" />
                  <line
                    x1="4"
                    y1="4"
                    x2="20"
                    y2="20"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                </svg>
                Stop Streaming
              </button>
              <button
                onClick={() => {
                  handleChangeStream();
                  setContextMenu(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-discord-text-secondary hover:bg-discord-modifier-hover rounded text-sm transition-colors"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                </svg>
                Change Stream
              </button>
              <div className="border-t border-white/[0.06] my-1" />
              <div className="px-3 py-1">
                <div className="text-xs text-discord-text-muted mb-1 font-medium uppercase tracking-wider">
                  Stream Quality
                </div>
                <div className="relative">
                  <button
                    onClick={() => setQualityPopoverOpen(!qualityPopoverOpen)}
                    className="w-full flex items-center justify-between px-2 py-1.5 text-sm text-discord-text-secondary hover:bg-discord-modifier-hover rounded transition-colors"
                  >
                    <span>{useVoiceStore.getState().videoQuality}</span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M7 10l5 5 5-5z" />
                    </svg>
                  </button>
                  {qualityPopoverOpen && (
                    <VideoQualityPopover
                      open={qualityPopoverOpen}
                      onClose={() => setQualityPopoverOpen(false)}
                    />
                  )}
                </div>
              </div>
            </>
          ) : (
            /* Viewer context menu (remote stream) */
            <>
              {isWatching ? (
                <button
                  onClick={() => {
                    handleUnwatch();
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-discord-text-secondary hover:bg-discord-modifier-hover rounded text-sm transition-colors"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
                  </svg>
                  Stop Watching
                </button>
              ) : (
                <button
                  onClick={() => {
                    handleWatch();
                    setContextMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-discord-text-secondary hover:bg-discord-modifier-hover rounded text-sm transition-colors"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                  </svg>
                  Watch Stream
                </button>
              )}
              <div className="border-t border-white/[0.06] my-1" />
              {/* Mute toggle */}
              <button
                onClick={() => {
                  setStreamMuteAction(userId, !isStreamMuted);
                }}
                className="w-full flex items-center justify-between px-3 py-2 text-discord-text-secondary hover:bg-discord-modifier-hover rounded text-sm transition-colors"
              >
                <span>Mute Stream</span>
                <div
                  className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    isStreamMuted
                      ? 'bg-discord-blurple border-discord-blurple'
                      : 'border-discord-text-muted'
                  }`}
                >
                  {isStreamMuted && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="white"
                    >
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                  )}
                </div>
              </button>
              {/* Stream Volume slider */}
              <div className="px-3 py-2">
                <div className="text-xs text-discord-text-muted mb-2 font-medium uppercase tracking-wider">
                  Stream Volume
                </div>
                <div className="flex items-center gap-2">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="text-discord-text-muted flex-shrink-0"
                  >
                    <path d="M3 9v6h4l5 5V4L7 9H3z" />
                  </svg>
                  <input
                    type="range"
                    min="0"
                    max="200"
                    value={streamVolume}
                    onChange={(e) =>
                      setStreamVolumeAction(userId, parseInt(e.target.value))
                    }
                    className="flex-1 accent-discord-blurple h-1"
                  />
                  <span className="text-xs text-discord-text-secondary min-w-[32px] text-right">
                    {streamVolume}%
                  </span>
                </div>
              </div>
              <div className="border-t border-white/[0.06] my-1" />
              {/* Stream Attenuation toggle */}
              <button
                onClick={() =>
                  setAttenuationEnabled(!streamAttenuationEnabled)
                }
                className="w-full flex items-center justify-between px-3 py-2 text-discord-text-secondary hover:bg-discord-modifier-hover rounded text-sm transition-colors"
              >
                <span>Stream Attenuation</span>
                <div
                  className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                    streamAttenuationEnabled
                      ? 'bg-discord-blurple border-discord-blurple'
                      : 'border-discord-text-muted'
                  }`}
                >
                  {streamAttenuationEnabled && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="white"
                    >
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                  )}
                </div>
              </button>
              {/* Attenuation Strength slider */}
              {streamAttenuationEnabled && (
                <div className="px-3 py-2">
                  <div className="text-xs text-discord-text-muted mb-2 font-medium uppercase tracking-wider">
                    Attenuation Strength
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={streamAttenuationStrength}
                      onChange={(e) =>
                        setAttenuationStrength(parseInt(e.target.value))
                      }
                      className="flex-1 accent-discord-blurple h-1"
                    />
                    <span className="text-xs text-discord-text-secondary min-w-[32px] text-right">
                      {streamAttenuationStrength}%
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
