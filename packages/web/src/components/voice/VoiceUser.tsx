import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import { getSharedAudioCtx } from '../../hooks/useLiveKit';
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

  // Web Audio for volume boost (> 100%)
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Determine active video track
  const liveScreen = participant.isScreenSharing && participant.screenTrack?.readyState === 'live' ? participant.screenTrack : null;
  const liveCamera = participant.isCameraOn && participant.videoTrack?.readyState === 'live' ? participant.videoTrack : null;
  const activeVideoTrack = liveScreen ?? liveCamera;
  const hasVideo = activeVideoTrack !== null;
  const isScreenShare = liveScreen !== null;

  // 1. STANDARD AUDIO PLAYBACK (Reliability Layer)
  useEffect(() => {
    const audioEl = audioRef.current;
    if (isLocal || !audioEl || !participant.audioTrack) return;

    const stream = new MediaStream([participant.audioTrack]);
    if ((audioEl.srcObject as MediaStream)?.id !== stream.id) {
      audioEl.srcObject = stream;
      // Critical for Chrome: Explicitly call play()
      audioEl.play().catch((err) => console.warn('[Audio] Auto-play blocked:', err));
    }
  }, [participant.audioTrack, isLocal]);

  // 2. VOLUME & BOOST CONTROL
  useEffect(() => {
    const audioEl = audioRef.current;
    if (isLocal || !audioEl || !participant.audioTrack) return;

    // Calculate total requested volume (0.0 to 2.0+)
    const combined = (perUserVolume / 100) * (outputVolume / 100);

    if (isDeafened) {
      audioEl.muted = true;
      if (gainNodeRef.current) gainNodeRef.current.gain.value = 0;
      return;
    }

    // Logic:
    // 0% - 100%: Use standard <audio> volume. Disconnect Web Audio to prevent doubling.
    // > 100%: Set <audio> to 100%, connect Web Audio for the EXTRA boost.
    
    // Standard Path (Always Active unless >100% needs to take over completely, but doubling is risk.
    // SAFE APPROACH: Use <audio> for everything up to 100%.
    // If > 100%, keep <audio> at 100% and add Web Audio *parallel*? No, that causes phasing.
    // CORRECT APPROACH: 
    // If <= 100%: Element Volume = combined. Web Audio = Disconnected.
    // If > 100%: Element Volume = 0 (Muted). Web Audio = connected & combined.
    
    const ctx = getSharedAudioCtx();
    const useWebAudio = combined > 1.0 && ctx && ctx.state === 'running';

    if (useWebAudio) {
      // --- BOOST MODE (>100%) ---
      // Mute standard element to prevent double audio
      audioEl.muted = true;

      // Setup/Connect Web Audio
      if (!gainNodeRef.current) {
        gainNodeRef.current = ctx.createGain();
        gainNodeRef.current.connect(ctx.destination);
      }
      if (!sourceNodeRef.current) {
        sourceNodeRef.current = ctx.createMediaStreamSource(new MediaStream([participant.audioTrack]));
        sourceNodeRef.current.connect(gainNodeRef.current);
      }
      
      // Apply full gain (e.g., 1.5, 2.0)
      gainNodeRef.current.gain.setTargetAtTime(combined, ctx.currentTime, 0.01);

    } else {
      // --- STANDARD MODE (0-100%) ---
      // Cleanup Web Audio to prevent doubling/leaking
      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }
      
      // Use standard element
      audioEl.muted = false;
      audioEl.volume = Math.min(combined, 1.0);
    }

  }, [isDeafened, outputVolume, perUserVolume, isLocal, participant.audioTrack]);

  // Video Handling
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (activeVideoTrack) {
      videoEl.srcObject = new MediaStream([activeVideoTrack]);
    } else {
      videoEl.srcObject = null;
    }
  }, [activeVideoTrack]);

  // Cleanup Listeners
  useEffect(() => {
    const tracks = [participant.videoTrack, participant.screenTrack].filter((t): t is MediaStreamTrack => t !== null);
    if (tracks.length === 0) return;
    const onEnded = () => forceUpdate((n) => n + 1);
    tracks.forEach((t) => t.addEventListener('ended', onEnded));
    return () => tracks.forEach((t) => t.removeEventListener('ended', onEnded));
  }, [participant.videoTrack, participant.screenTrack]);

  // Interaction (Resume Context)
  const handleInteraction = useCallback(() => {
    const ctx = getSharedAudioCtx();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(console.error);
    }
  }, []);

  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);
  const [volumeMenu, setVolumeMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isLocal) return;
    e.preventDefault();
    handleInteraction();
    setVolumeMenu({ x: e.clientX, y: e.clientY });
  }, [isLocal, handleInteraction]);

  useEffect(() => {
    if (!volumeMenu) return;
    const close = () => setVolumeMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [volumeMenu]);

  return (
    <div
      onClick={handleInteraction}
      className={`relative bg-[#111214] rounded-xl overflow-hidden flex items-center justify-center group transition-all duration-200 ${
        participant.isSpeaking
          ? 'ring-[3px] ring-discord-green shadow-[0_0_12px_rgba(35,165,90,0.25)]'
          : 'ring-1 ring-white/[0.06] hover:ring-white/10'
      } ${large ? 'h-full w-full' : 'h-full aspect-video'}`}
      onContextMenu={handleContextMenu}
    >
      {/* Audio Element: Primary playback device */}
      {!isLocal && <audio ref={audioRef} autoPlay playsInline />}

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
            <Avatar src={null} name={participant.username} size={large ? 100 : 64} />
            {participant.isSpeaking && (
              <div className="absolute -inset-1.5 rounded-full ring-[3px] ring-discord-green animate-pulse" />
            )}
          </div>
        </div>
      )}

      {isScreenShare && hasVideo && (
        <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-discord-red rounded text-[11px] font-bold text-white uppercase tracking-wide">
          LIVE
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/70 via-black/30 to-transparent">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`font-semibold text-white truncate ${large ? 'text-base' : 'text-[13px]'}`}>
              {participant.username}
            </span>
            {isLocal && <span className="text-[10px] text-white/40 font-medium">(you)</span>}
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
            {(isLocal ? isDeafened : participant.isDeafened) && (
              <div className="w-5 h-5 bg-discord-red/90 rounded-full flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
                  <line x1="3" y1="3" x2="21" y2="21" stroke="white" strokeWidth="2" />
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>

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
