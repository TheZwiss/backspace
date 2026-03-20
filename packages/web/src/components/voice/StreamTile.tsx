import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import { useContextMenuStore, type ContextMenuItem } from '../../stores/contextMenuStore';
import { getActiveRoom, setStreamSubscription } from '../../hooks/useLiveKit';
import { stopScreenShare, changeScreenShare } from '../../utils/screenShare';
import { ScreenShareSettingsPopover } from './ScreenShareSettingsPopover';
import { useVoiceParticipantMeta } from '../../hooks/useVoiceParticipantMeta';
import type { StreamTile as StreamTileType } from '../../hooks/useLiveKit';

interface StreamTileProps {
  tile: StreamTileType;
  large?: boolean;
}

/** Wrapper component for stream quality settings — needs its own state + close guard. */
function StreamQualityItem() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const setCloseGuard = useContextMenuStore((s) => s.setCloseGuard);
  const screenShareConfig = useVoiceStore((s) => s.screenShareConfig);

  return (
    <div className="p-3">
      <div className="text-xs text-txt-tertiary mb-2 font-medium uppercase tracking-wider">
        Stream Quality
      </div>
      <div className="relative">
        <button
          ref={btnRef}
          onClick={() => {
            const n = !open;
            setOpen(n);
            setCloseGuard(n);
          }}
          className="w-full flex items-center justify-between px-2 py-1.5 text-sm text-txt-secondary hover:bg-interactive-hover rounded transition-colors"
        >
          <span>{screenShareConfig.height}p {screenShareConfig.fps}fps</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
        {open && (
          <ScreenShareSettingsPopover
            open={open}
            onClose={() => {
              setOpen(false);
              setCloseGuard(false);
            }}
            anchorRef={btnRef}
          />
        )}
      </div>
    </div>
  );
}

/** Wrapper component for stream volume slider — needs store subscription. */
function StreamVolumeItem({ userId }: { userId: string }) {
  const streamVolume = useVoiceStore((s) => s.streamVolumes.get(userId) ?? 100);
  const setStreamVolume = useVoiceStore((s) => s.setStreamVolume);

  return (
    <div className="p-3">
      <div className="text-xs text-txt-tertiary mb-2 font-medium uppercase tracking-wider">
        Stream Volume
      </div>
      <div className="flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary flex-shrink-0">
          <path d="M3 9v6h4l5 5V4L7 9H3z" />
        </svg>
        <input
          type="range"
          min="0"
          max="200"
          value={streamVolume}
          onChange={(e) => setStreamVolume(userId, parseInt(e.target.value))}
          className="flex-1 accent-accent-primary h-1"
        />
        <span className="text-xs text-txt-secondary min-w-[32px] text-right">
          {streamVolume}%
        </span>
      </div>
    </div>
  );
}

/** Wrapper component for stream attenuation controls — needs store subscription. */
function StreamAttenuationItem() {
  const streamAttenuationEnabled = useVoiceStore((s) => s.streamAttenuationEnabled);
  const streamAttenuationStrength = useVoiceStore((s) => s.streamAttenuationStrength);
  const setAttenuationEnabled = useVoiceStore((s) => s.setStreamAttenuationEnabled);
  const setAttenuationStrength = useVoiceStore((s) => s.setStreamAttenuationStrength);

  return (
    <div>
      <div className="py-1.5">
        <button
          onClick={() => setAttenuationEnabled(!streamAttenuationEnabled)}
          className="w-full text-left px-2 py-1.5 mx-1.5 text-sm rounded-sm flex items-center gap-2 text-txt-secondary hover:bg-accent-primary hover:text-white"
          style={{ width: 'calc(100% - 12px)' }}
        >
          <span className="flex-1">Stream Attenuation</span>
          <div
            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              streamAttenuationEnabled
                ? 'bg-accent-primary border-accent-primary'
                : 'border-txt-tertiary'
            }`}
          >
            {streamAttenuationEnabled && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="white">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
            )}
          </div>
        </button>
      </div>
      {streamAttenuationEnabled && (
        <div className="p-3 pt-0">
          <div className="text-xs text-txt-tertiary mb-2 font-medium uppercase tracking-wider">
            Attenuation Strength
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="0"
              max="100"
              value={streamAttenuationStrength}
              onChange={(e) => setAttenuationStrength(parseInt(e.target.value))}
              className="flex-1 accent-accent-primary h-1"
            />
            <span className="text-xs text-txt-secondary min-w-[32px] text-right">
              {streamAttenuationStrength}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
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

  const openContextMenu = useContextMenuStore((s) => s.open);

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
      e.stopPropagation();

      const items: ContextMenuItem[] = [];

      if (isLocal) {
        // Local stream: stop, change, quality
        items.push({
          key: 'stop-streaming',
          type: 'action',
          label: 'Stop Streaming',
          danger: true,
          icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
            React.createElement('path', { d: 'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z' }),
            React.createElement('line', { x1: 4, y1: 4, x2: 20, y2: 20, stroke: 'currentColor', strokeWidth: 2 }),
          ),
          onClick: async () => {
            const room = getActiveRoom();
            if (room) {
              await stopScreenShare(room);
            }
          },
        });
        items.push({
          key: 'change-stream',
          type: 'action',
          label: 'Change Stream',
          icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
            React.createElement('path', { d: 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z' }),
          ),
          onClick: async () => {
            const room = getActiveRoom();
            if (room) {
              await changeScreenShare(room);
            }
          },
        });
        items.push({ key: 'quality-sep', type: 'separator' });
        items.push({
          key: 'stream-quality',
          type: 'custom',
          render: () => React.createElement(StreamQualityItem),
        });
      } else {
        // Remote stream: watch/unwatch, mute, volume, attenuation
        const currentIsWatching = useVoiceStore.getState().watchingStreams.has(userId);
        const identity = participant.identity;

        if (currentIsWatching) {
          items.push({
            key: 'stop-watching',
            type: 'action',
            label: 'Stop Watching',
            icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
              React.createElement('path', { d: 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z' }),
            ),
            onClick: () => {
              useVoiceStore.getState().unwatchStream(userId);
              setStreamSubscription(getActiveRoom(), identity, false);
            },
          });
        } else {
          items.push({
            key: 'watch-stream',
            type: 'action',
            label: 'Watch Stream',
            icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
              React.createElement('path', { d: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z' }),
            ),
            onClick: () => {
              useVoiceStore.getState().watchStream(userId);
              setStreamSubscription(getActiveRoom(), identity, true);
            },
          });
        }

        items.push({ key: 'watch-sep', type: 'separator' });

        // Mute Stream checkbox
        const isStreamMuted = useVoiceStore.getState().streamMutes.get(userId) ?? false;
        items.push({
          key: 'mute-stream',
          type: 'checkbox',
          label: 'Mute Stream',
          checked: isStreamMuted,
          onChange: (checked) => useVoiceStore.getState().setStreamMute(userId, checked),
        });

        items.push({ key: 'vol-sep', type: 'separator' });

        // Stream volume slider
        items.push({
          key: 'stream-volume',
          type: 'custom',
          render: () => React.createElement(StreamVolumeItem, { userId }),
        });

        items.push({ key: 'attenuation-sep', type: 'separator' });

        // Stream attenuation controls
        items.push({
          key: 'stream-attenuation',
          type: 'custom',
          render: () => React.createElement(StreamAttenuationItem),
        });
      }

      openContextMenu({ x: e.clientX, y: e.clientY }, items);
    },
    [isLocal, userId, participant.identity, openContextMenu],
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
    </div>
  );
}
