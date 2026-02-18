import React, { useRef, useEffect } from 'react';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

interface VoiceUserProps {
  participant: ParticipantInfo;
}

export function VoiceUser({ participant }: VoiceUserProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const isDeafened = useVoiceStore((s) => s.isDeafened);

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

  // Mute remote audio when deafened
  useEffect(() => {
    const audioEl = audioRef.current;
    if (audioEl) {
      audioEl.muted = isDeafened;
    }
  }, [isDeafened]);

  const hasVideo = participant.isCameraOn || participant.isScreenSharing;
  const isLocal = participant.isLocal;

  return (
    <div
      className={`relative bg-discord-bg-secondary rounded-xl overflow-hidden flex items-center justify-center ${
        participant.isSpeaking ? 'ring-2 ring-discord-green' : ''
      }`}
      style={{ aspectRatio: '16/9', minHeight: '200px' }}
    >
      {/* Audio element for remote participants */}
      {!isLocal && <audio ref={audioRef} autoPlay />}

      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className="w-full h-full object-cover"
        />
      ) : (
        <Avatar
          src={null}
          name={participant.username}
          size={80}
        />
      )}

      {/* Bottom overlay */}
      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white">{participant.username}</span>
          <div className="flex items-center gap-1">
            {participant.isMuted && (
              <div className="w-5 h-5 bg-discord-red/80 rounded-full flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <path d="M12 2C10.9 2 10 2.9 10 4V12C10 13.1 10.9 14 12 14C13.1 14 14 13.1 14 12V4C14 2.9 13.1 2 12 2Z" />
                  <line x1="3" y1="3" x2="21" y2="21" stroke="white" strokeWidth="2" />
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Speaking indicator */}
      {participant.isSpeaking && (
        <div className="absolute inset-0 rounded-xl ring-2 ring-discord-green animate-pulse pointer-events-none" />
      )}
    </div>
  );
}
