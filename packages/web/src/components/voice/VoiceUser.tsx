import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import { AudioManager } from '../../audio/AudioManager';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

interface VoiceUserProps {
  participant: ParticipantInfo;
  large?: boolean;
}

export function VoiceUser({ participant, large }: VoiceUserProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const screenAudioRef = useRef<HTMLAudioElement>(null);
  
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const outputVolume = useVoiceStore((s) => s.outputVolume);
  const participantVolumes = useVoiceStore((s) => s.participantVolumes);
  
  const [, forceUpdate] = useState(0);

  const perUserVolume = participantVolumes.get(participant.userId) ?? 100;
  const isLocal = participant.isLocal;

  // --- AUDIO PIPELINE: NATIVE FIRST ---
  
  // Refs for the optional boost pipeline
  const boostGainRef = useRef<GainNode | null>(null);
  const boostSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // 1. Basic Track Attachment (The Rock-Solid Foundation)
  useEffect(() => {
    const audioEl = audioRef.current;
    if (isLocal || !audioEl || !participant.audioTrack) return;

    // Direct attachment.
    const stream = new MediaStream([participant.audioTrack]);
    
    // Only update if changed to prevent interruptions
    if ((audioEl.srcObject as MediaStream)?.id !== stream.id) {
      audioEl.srcObject = stream;
      
      // Aggressive play attempt for Chrome
      const tryPlay = async () => {
        try {
          await audioEl.play();
        } catch (err) {
          console.warn("[Audio] Autoplay blocked, retrying...", err);
          // If blocked, we rely on the global interaction listener to resume context,
          // but we can also retry play() on the element itself on next click.
        }
      };
      tryPlay();
    }
  }, [participant.audioTrack, isLocal]);

  // 2. Volume Management (Hybrid)
  useEffect(() => {
    const audioEl = audioRef.current;
    if (isLocal || !audioEl || !participant.audioTrack) return;

    const globalScale = outputVolume / 100;
    const userScale = perUserVolume / 100;
    const finalVolume = globalScale * userScale;

    if (isDeafened) {
      audioEl.muted = true;
      return;
    }

    // Logic: 
    // If we are boosting (>100%) AND context is running, use Web Audio.
    // Otherwise, stick to the native element for maximum reliability.
    
    const audioManager = AudioManager.getInstance();
    const ctx = audioManager.getContext();
    const isBoosting = finalVolume > 1.0;
    const isContextReady = ctx && ctx.state === 'running';

    if (isBoosting && isContextReady) {
      // --- BOOST MODE (>100%) ---
      // Setup pipeline if missing
      if (!boostGainRef.current && ctx) {
        const gain = ctx.createGain();
        const source = ctx.createMediaStreamSource(new MediaStream([participant.audioTrack]));
        
        source.connect(gain);
        gain.connect(ctx.destination);
        
        boostGainRef.current = gain;
        boostSourceRef.current = source;
      }

      // Apply boosted gain
      if (boostGainRef.current && ctx) {
        boostGainRef.current.gain.setTargetAtTime(finalVolume, ctx.currentTime, 0.01);
      }
      
      // MUTE the element so we don't double audio
      audioEl.muted = true;
      
    } else {
      // --- STANDARD MODE (0% - 100%) ---
      // Clean up boost pipeline if it exists
      if (boostSourceRef.current) {
        boostSourceRef.current.disconnect();
        boostSourceRef.current = null;
        boostGainRef.current = null;
      }
      
      // Use the element
      audioEl.muted = false;
      audioEl.volume = Math.min(finalVolume, 1.0);
      
      // Ensure it's playing (in case it was paused/blocked earlier)
      if (audioEl.paused) {
        audioEl.play().catch(() => {});
      }
    }

    return () => {
      if (boostSourceRef.current) {
        boostSourceRef.current.disconnect();
        boostSourceRef.current = null;
        boostGainRef.current = null;
      }
    };
  }, [outputVolume, perUserVolume, isDeafened, isLocal, participant.audioTrack]);


  // --- SCREEN SHARE AUDIO PIPELINE ---

  const screenBoostGainRef = useRef<GainNode | null>(null);
  const screenBoostSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Screen share audio: track attachment
  useEffect(() => {
    const audioEl = screenAudioRef.current;
    if (isLocal || !audioEl || !participant.screenAudioTrack) {
      if (audioEl) audioEl.srcObject = null;
      return;
    }

    const stream = new MediaStream([participant.screenAudioTrack]);
    if ((audioEl.srcObject as MediaStream)?.id !== stream.id) {
      audioEl.srcObject = stream;
      audioEl.play().catch(() => {});
    }
  }, [participant.screenAudioTrack, isLocal]);

  // Screen share audio: volume management (mirrors mic audio pipeline)
  useEffect(() => {
    const audioEl = screenAudioRef.current;
    if (isLocal || !audioEl || !participant.screenAudioTrack) return;

    const globalScale = outputVolume / 100;
    const userScale = perUserVolume / 100;
    const finalVolume = globalScale * userScale;

    if (isDeafened) {
      audioEl.muted = true;
      return;
    }

    const audioManager = AudioManager.getInstance();
    const ctx = audioManager.getContext();
    const isBoosting = finalVolume > 1.0;
    const isContextReady = ctx && ctx.state === 'running';

    if (isBoosting && isContextReady) {
      if (!screenBoostGainRef.current && ctx) {
        const gain = ctx.createGain();
        const source = ctx.createMediaStreamSource(new MediaStream([participant.screenAudioTrack]));
        source.connect(gain);
        gain.connect(ctx.destination);
        screenBoostGainRef.current = gain;
        screenBoostSourceRef.current = source;
      }
      if (screenBoostGainRef.current && ctx) {
        screenBoostGainRef.current.gain.setTargetAtTime(finalVolume, ctx.currentTime, 0.01);
      }
      audioEl.muted = true;
    } else {
      if (screenBoostSourceRef.current) {
        screenBoostSourceRef.current.disconnect();
        screenBoostSourceRef.current = null;
        screenBoostGainRef.current = null;
      }
      audioEl.muted = false;
      audioEl.volume = Math.min(finalVolume, 1.0);
      if (audioEl.paused) {
        audioEl.play().catch(() => {});
      }
    }

    return () => {
      if (screenBoostSourceRef.current) {
        screenBoostSourceRef.current.disconnect();
        screenBoostSourceRef.current = null;
        screenBoostGainRef.current = null;
      }
    };
  }, [outputVolume, perUserVolume, isDeafened, isLocal, participant.screenAudioTrack]);

  // --- VIDEO & UI ---

  const liveScreen = participant.isScreenSharing && participant.screenTrack?.readyState === 'live' ? participant.screenTrack : null;
  const liveCamera = participant.isCameraOn && participant.videoTrack?.readyState === 'live' ? participant.videoTrack : null;
  const activeVideoTrack = liveScreen ?? liveCamera;
  const hasVideo = activeVideoTrack !== null;
  const isScreenShare = liveScreen !== null;

  // Force re-render when tracks end/mute
  useEffect(() => {
    const tracks = [participant.videoTrack, participant.screenTrack].filter((t): t is MediaStreamTrack => t !== null);
    if (tracks.length === 0) return;
    const onEnded = () => forceUpdate((n) => n + 1);
    tracks.forEach((t) => t.addEventListener('ended', onEnded));
    return () => tracks.forEach((t) => t.removeEventListener('ended', onEnded));
  }, [participant.videoTrack, participant.screenTrack]);

  // Attach Video
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (activeVideoTrack) {
      videoEl.srcObject = new MediaStream([activeVideoTrack]);
    } else {
      videoEl.srcObject = null;
    }
  }, [activeVideoTrack]);

  // Context Menu
  const [volumeMenu, setVolumeMenu] = useState<{ x: number; y: number } | null>(null);
  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isLocal) return;
    e.preventDefault();
    setVolumeMenu({ x: e.clientX, y: e.clientY });
  }, [isLocal]);

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
      } ${large ? 'h-full w-full' : 'h-full aspect-video'}`}
      onContextMenu={handleContextMenu}
    >
      {/* 
        Native Audio Element 
        - AutoPlay is critical
        - PlaysInline is critical for mobile
      */}
      {!isLocal && <audio ref={audioRef} autoPlay playsInline />}
      {!isLocal && <audio ref={screenAudioRef} autoPlay playsInline />}

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
            <span className="text-xs text-discord-text-secondary min-w-[32px] text-right">{perUserVolume}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
