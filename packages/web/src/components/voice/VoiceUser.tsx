import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

interface VoiceUserProps {
  participant: ParticipantInfo;
  large?: boolean;
}

export function VoiceUser({ participant, large }: VoiceUserProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const outputVolume = useVoiceStore((s) => s.outputVolume);
  const participantVolumes = useVoiceStore((s) => s.participantVolumes);
  const [, forceUpdate] = useState(0);

  const perUserVolume = participantVolumes.get(participant.userId) ?? 100;
  const isLocal = participant.isLocal;

  // Determine active video track — prioritize screen share, check readyState
  const liveScreen = participant.screenTrack?.readyState === 'live' ? participant.screenTrack : null;
  const liveCamera = participant.videoTrack?.readyState === 'live' ? participant.videoTrack : null;
  const activeVideoTrack = liveScreen ?? liveCamera;
  const hasVideo = activeVideoTrack !== null;
  const isScreenShare = liveScreen !== null;

  // Listen for track 'ended' events to force re-render when a stream stops
  useEffect(() => {
    const tracks = [participant.videoTrack, participant.screenTrack].filter(
      (t): t is MediaStreamTrack => t !== null,
    );
    if (tracks.length === 0) return;
    const onEnded = () => forceUpdate((n) => n + 1);
    tracks.forEach((t) => t.addEventListener('ended', onEnded));
    return () => tracks.forEach((t) => t.removeEventListener('ended', onEnded));
  }, [participant.videoTrack, participant.screenTrack]);

  // Attach video track
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (activeVideoTrack) {
      videoEl.srcObject = new MediaStream([activeVideoTrack]);
    } else {
      videoEl.srcObject = null;
    }
  }, [activeVideoTrack]);

  // Attach audio track
  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl || !participant.audioTrack) return;
    audioEl.srcObject = new MediaStream([participant.audioTrack]);
  }, [participant.audioTrack]);

  // Apply volume: combine outputVolume and per-participant volume, or mute if deafened
  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl) return;
    if (isDeafened) {
      audioEl.volume = 0;
      audioEl.muted = true;
    } else {
      const combined = (outputVolume / 100) * (perUserVolume / 100);
      audioEl.volume = Math.min(Math.max(combined, 0), 1);
      audioEl.muted = false;
    }
  }, [isDeafened, outputVolume, perUserVolume]);

  // Volume context menu
  const [volumeMenu, setVolumeMenu] = useState<{ x: number; y: number } | null>(null);
  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocal) return;
      e.preventDefault();
      setVolumeMenu({ x: e.clientX, y: e.clientY });
    },
    [isLocal],
  );

  useEffect(() => {
    if (!volumeMenu) return;
    const close = () => setVolumeMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [volumeMenu]);

  return (
    <div
      className={`relative bg-[#111214] rounded-xl overflow-hidden flex items-center justify-center group transition-all duration-200 ${
        participant.isSpeaking
          ? 'ring-[3px] ring-discord-green shadow-[0_0_12px_rgba(35,165,90,0.25)]'
          : 'ring-1 ring-white/[0.06] hover:ring-white/10'
      } ${large ? 'h-full' : ''}`}
      style={large ? undefined : { aspectRatio: '16/9', minHeight: '140px' }}
      onContextMenu={handleContextMenu}
    >
      {/* Audio element for remote participants */}
      {!isLocal && <audio ref={audioRef} autoPlay />}

      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className={`w-full h-full ${large || isScreenShare ? 'object-contain bg-black' : 'object-cover'}`}
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-[#1e1f22]">
          <div className="relative">
            <Avatar
              src={null}
              name={participant.username}
              size={large ? 100 : 64}
            />
            {participant.isSpeaking && (
              <div className="absolute -inset-1.5 rounded-full ring-[3px] ring-discord-green animate-pulse" />
            )}
          </div>
        </div>
      )}

      {/* LIVE badge for screen shares */}
      {isScreenShare && hasVideo && (
        <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-discord-red rounded text-[11px] font-bold text-white uppercase tracking-wide">
          LIVE
        </div>
      )}

      {/* Bottom overlay */}
      <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/70 via-black/30 to-transparent">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`font-semibold text-white truncate ${large ? 'text-base' : 'text-[13px]'}`}
            >
              {participant.username}
            </span>
            {isLocal && (
              <span className="text-[10px] text-white/40 font-medium">(you)</span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {participant.isMuted && (
              <div className="w-5 h-5 bg-discord-red/90 rounded-full flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <path d="M12 2C10.9 2 10 2.9 10 4V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V4C14 2.9 13.1 2 12 2Z" />
                  <line x1="3" y1="3" x2="21" y2="21" stroke="white" strokeWidth="2" />
                </svg>
              </div>
            )}
            {participant.isScreenSharing && !isScreenShare && (
              <div className="w-5 h-5 bg-discord-blurple/90 rounded-full flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <path d="M20 18C21.1 18 22 17.1 22 16V6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20Z" />
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Per-participant volume menu (right-click) */}
      {volumeMenu && !isLocal && (
        <div
          className="fixed z-[60] bg-[#111214] rounded-lg shadow-2xl p-3 min-w-[200px] border border-white/[0.06]"
          style={{ left: volumeMenu.x, top: volumeMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs text-discord-text-muted mb-2 font-medium uppercase tracking-wider">
            User Volume
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
              value={perUserVolume}
              onChange={(e) =>
                setParticipantVolume(participant.userId, parseInt(e.target.value))
              }
              className="flex-1 accent-discord-blurple h-1"
            />
            <span className="text-xs text-discord-text-secondary min-w-[32px] text-right">
              {perUserVolume}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
