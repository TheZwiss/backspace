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

  const perUserVolume = participantVolumes.get(participant.userId) ?? 100;

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    const track = participant.videoTrack ?? participant.screenTrack;
    if (track) {
      const stream = new MediaStream([track]);
      videoEl.srcObject = stream;
    } else {
      videoEl.srcObject = null;
    }
  }, [participant.videoTrack, participant.screenTrack]);

  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl || !participant.audioTrack) return;

    const stream = new MediaStream([participant.audioTrack]);
    audioEl.srcObject = stream;
  }, [participant.audioTrack]);

  // Apply volume: combine outputVolume and per-participant volume, or mute if deafened
  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl) return;
    if (isDeafened) {
      audioEl.volume = 0;
    } else {
      // Both are 0-200 scale with 100 = default. Combine as fractions.
      const combined = (outputVolume / 100) * (perUserVolume / 100);
      audioEl.volume = Math.min(Math.max(combined, 0), 1);
    }
    audioEl.muted = isDeafened;
  }, [isDeafened, outputVolume, perUserVolume]);

  const hasVideo = !!(participant.videoTrack || participant.screenTrack);
  const isLocal = participant.isLocal;

  // Volume context menu
  const [volumeMenu, setVolumeMenu] = useState<{ x: number; y: number } | null>(null);
  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isLocal) return; // No volume control for self
    e.preventDefault();
    setVolumeMenu({ x: e.clientX, y: e.clientY });
  }, [isLocal]);

  // Close volume menu on click outside
  useEffect(() => {
    if (!volumeMenu) return;
    const close = () => setVolumeMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [volumeMenu]);

  return (
    <div
      className={`relative bg-discord-bg-secondary rounded-xl overflow-hidden flex items-center justify-center transition-all ${
        participant.isSpeaking ? 'ring-[3px] ring-discord-green' : 'ring-1 ring-transparent'
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
          className={`w-full h-full ${large ? 'object-contain' : 'object-cover'}`}
          style={{ 
            imageRendering: 'crisp-edges',
            WebkitFontSmoothing: 'antialiased'
          } as any}
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-2">
          <Avatar
            src={null}
            name={participant.username}
            size={large ? 100 : 80}
          />
        </div>
      )}

      {/* Bottom overlay */}
      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className={`font-medium text-white ${large ? 'text-base' : 'text-sm'}`}>{participant.username}</span>
            {isLocal && (
              <span className="text-[10px] text-white/50 font-medium">(you)</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {participant.isMuted && (
              <div className="w-5 h-5 bg-discord-red/80 rounded-full flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <path d="M12 2C10.9 2 10 2.9 10 4V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V4C14 2.9 13.1 2 12 2Z" />
                  <line x1="3" y1="3" x2="21" y2="21" stroke="white" strokeWidth="2" />
                </svg>
              </div>
            )}
            {participant.isScreenSharing && (
              <div className="w-5 h-5 bg-discord-blurple/80 rounded-full flex items-center justify-center">
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
          className="fixed z-[60] bg-[#111214] rounded-lg shadow-2xl p-3 min-w-[200px]"
          style={{ left: volumeMenu.x, top: volumeMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs text-discord-text-muted mb-2 font-medium uppercase tracking-wider">
            User Volume
          </div>
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-discord-text-muted flex-shrink-0">
              <path d="M3 9v6h4l5 5V4L7 9H3z" />
            </svg>
            <input
              type="range"
              min="0"
              max="200"
              value={perUserVolume}
              onChange={(e) => setParticipantVolume(participant.userId, parseInt(e.target.value))}
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
