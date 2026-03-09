import React, { useEffect, useState, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { wsSend } from '../../hooks/useWebSocket';
import { useSpaceStore, getChannelOrigin, getMyUserIdForOrigin } from '../../stores/spaceStore';
import { ScreenShareSettingsPopover } from './ScreenShareSettingsPopover';
import { CAMERA_PRESET, startScreenShare, stopScreenShare } from '../../utils/screenShare';

const btnBase = 'w-10 h-10 flex items-center justify-center rounded-full transition-colors';
const btnDefault = `${btnBase} bg-surface-channel text-txt-secondary hover:bg-surface-elevated hover:text-txt-primary`;
const btnActive = (color: string) => `${btnBase} bg-${color}/20 text-${color} hover:bg-${color}/30`;
const btnGreen = `${btnBase} bg-surface-channel text-status-online hover:bg-surface-elevated`;

export function VoiceControlBar() {
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const voiceChatOpen = useUIStore((s) => s.voiceChatOpen);
  const toggleVoiceChat = useUIStore((s) => s.toggleVoiceChat);
  const voiceFullscreen = useUIStore((s) => s.voiceFullscreen);
  const toggleVoiceFullscreen = useUIStore((s) => s.toggleVoiceFullscreen);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const myUser = useAuthStore((s) => s.user);
  const spaceId = useSpaceStore((s) => currentVoiceChannelId ? s.channelToSpaceMap.get(currentVoiceChannelId) : null);
  const voiceOrigin = currentVoiceChannelId ? getChannelOrigin(currentVoiceChannelId) : '';
  const myOriginId = useSpaceStore((s) => currentVoiceChannelId ? getMyUserIdForOrigin(getChannelOrigin(currentVoiceChannelId)) : s.members.find(m => m.userId === myUser?.id)?.userId ?? myUser?.id);
  const serverMutedUserIds = useVoiceStore((s) => s.serverMutedUserIds);
  const serverDeafenedUserIds = useVoiceStore((s) => s.serverDeafenedUserIds);
  const isServerMuted = !!(myOriginId && spaceId && serverMutedUserIds.has(`${spaceId}:${myOriginId}`));
  const isServerDeafened = !!(myOriginId && spaceId && serverDeafenedUserIds.has(`${spaceId}:${myOriginId}`));
  const [qualityOpen, setQualityOpen] = useState(false);
  const qualityBtnRef = useRef<HTMLButtonElement>(null);

  const handleMute = React.useCallback(async () => {
    if (isServerMuted || isServerDeafened) return;
    const wasDeafened = useVoiceStore.getState().isDeafened;
    toggleMic();
    // Read fresh state after the smart toggle (may have cleared deafen too)
    const { isMuted: m, isDeafened: d, isCameraOn: c, isScreenSharing: ss } = useVoiceStore.getState();
    wsSend({ type: 'voice_status', isMuted: m, isDeafened: d, isCameraOn: c, isScreenSharing: ss }, voiceOrigin);
    // If unmuting while deafened cleared deafen, broadcast deafen=false via LiveKit data channel
    if (wasDeafened && !d) {
      const room = getActiveRoom();
      if (room) {
        const encoder = new TextEncoder();
        room.localParticipant.publishData(
          encoder.encode(JSON.stringify({ type: 'deafen', deafened: false })),
          { reliable: true }
        ).catch(() => {});
      }
    }
  }, [toggleMic, voiceOrigin, isServerMuted, isServerDeafened]);

  const handleDeafen = React.useCallback(async () => {
    if (isServerDeafened) return;
    const room = getActiveRoom();
    toggleDeafen();
    // Read fresh state — smart toggle handles mute coupling
    const { isMuted: m, isDeafened: d, isCameraOn: c, isScreenSharing: ss } = useVoiceStore.getState();
    // If server-muted, enforce muted even after undeafen
    const effectiveMuted = isServerMuted ? true : m;
    wsSend({ type: 'voice_status', isMuted: effectiveMuted, isDeafened: d, isCameraOn: c, isScreenSharing: ss }, voiceOrigin);
    if (room) {
      try {
        const encoder = new TextEncoder();
        room.localParticipant.publishData(
          encoder.encode(JSON.stringify({ type: 'deafen', deafened: d })),
          { reliable: true }
        ).catch(() => {});
      } catch (err) {
        console.error('[VoiceControlBar] Failed to toggle deafen:', err);
      }
    }
  }, [toggleDeafen, isServerMuted, isServerDeafened, voiceOrigin]);

  const handleCamera = async () => {
    const room = getActiveRoom();
    if (!room) return;
    try {
      const willEnable = !isCameraOn;
      if (willEnable) {
        await room.localParticipant.setCameraEnabled(true,
          { resolution: CAMERA_PRESET.resolution },
          {
            videoCodec: CAMERA_PRESET.codec,
            videoEncoding: CAMERA_PRESET.encoding,
            simulcast: true,
          }
        );
      } else {
        await room.localParticipant.setCameraEnabled(false);
      }
      toggleCamera();
      // Broadcast camera state via WebSocket
      const { isMuted: m, isDeafened: d, isScreenSharing: ss } = useVoiceStore.getState();
      wsSend({ type: 'voice_status', isMuted: m, isDeafened: d, isCameraOn: willEnable, isScreenSharing: ss }, voiceOrigin);
    } catch (err) {
      console.error('[VoiceControlBar] Failed to toggle camera:', err);
    }
  };

  const handleScreenShare = async () => {
    const room = getActiveRoom();
    if (!room) return;
    try {
      if (!isScreenSharing) {
        const started = await startScreenShare(room);
        if (started) {
          const { isMuted: m, isDeafened: d, isCameraOn: c } = useVoiceStore.getState();
          wsSend({ type: 'voice_status', isMuted: m, isDeafened: d, isCameraOn: c, isScreenSharing: true }, voiceOrigin);
        }
      } else {
        await stopScreenShare(room);
        const { isMuted: m, isDeafened: d, isCameraOn: c } = useVoiceStore.getState();
        wsSend({ type: 'voice_status', isMuted: m, isDeafened: d, isCameraOn: c, isScreenSharing: false }, voiceOrigin);
      }
    } catch (err) {
      console.error('[VoiceControlBar] Failed to toggle screen share:', err);
    }
  };

  const handleDisconnect = () => {
    const { activeDmCall } = useVoiceStore.getState();
    if (activeDmCall) {
      wsSend({ type: 'dm_call_end', dmChannelId: activeDmCall.dmChannelId }); // DM calls are home-only
      useVoiceStore.getState().setActiveDmCall(null);
    } else {
      wsSend({ type: 'voice_leave' }, voiceOrigin);
      useVoiceStore.getState().leaveVoice();
    }
    if (voiceFullscreen) {
      useUIStore.getState().setVoiceFullscreen(false);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    }
  };

  const handleFullscreen = () => {
    toggleVoiceFullscreen();
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        handleMute();
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        handleDeafen();
      } else if (e.key === 'Escape' && voiceFullscreen) {
        useUIStore.getState().setVoiceFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleMute, handleDeafen, voiceFullscreen]);

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 opacity-0 translate-y-4 group-hover/voice:opacity-100 group-hover/voice:translate-y-0 transition-all duration-300 ease-out">
      <div className="flex items-center gap-1.5 rounded-full px-3 py-2 glass-bubble">
        {/* Mute */}
        <button
          onClick={handleMute}
          className={(isServerMuted || isServerDeafened)
            ? `${btnBase} bg-accent-amber/20 text-accent-amber cursor-not-allowed`
            : isMuted || isDeafened
              ? `${btnBase} bg-accent-rose/20 text-txt-danger hover:bg-accent-rose/30`
              : btnDefault
          }
          title={(isServerMuted || isServerDeafened) ? 'Server Muted' : isMuted ? 'Unmute (M)' : 'Mute (M)'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            {(isMuted || isDeafened || isServerMuted) && <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />}
          </svg>
        </button>

        {/* Deafen */}
        <button
          onClick={handleDeafen}
          className={isServerDeafened
            ? `${btnBase} bg-accent-amber/20 text-accent-amber cursor-not-allowed`
            : isDeafened
              ? `${btnBase} bg-accent-rose/20 text-txt-danger hover:bg-accent-rose/30`
              : btnDefault
          }
          title={isServerDeafened ? 'Server Deafened' : isDeafened ? 'Undeafen (D)' : 'Deafen (D)'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
            {(isDeafened || isServerDeafened) && <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />}
          </svg>
        </button>

        {/* Camera */}
        <button
          onClick={handleCamera}
          className={isCameraOn ? btnGreen : btnDefault}
          title={isCameraOn ? 'Turn Off Camera' : 'Turn On Camera'}
        >
          {isCameraOn ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 10.5V7C17 6.45 16.55 6 16 6H4C3.45 6 3 6.45 3 7V17C3 17.55 3.45 18 4 18H16C16.55 18 17 17.55 17 17V13.5L21 17.5V6.5L17 10.5Z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 10.5V7C17 6.45 16.55 6 16 6H4C3.45 6 3 6.45 3 7V17C3 17.55 3.45 18 4 18H16C16.55 18 17 17.55 17 17V13.5L21 17.5V6.5L17 10.5Z" />
              <line x1="2" y1="2" x2="22" y2="22" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          )}
        </button>

        {/* Screen Share */}
        <button
          onClick={handleScreenShare}
          className={isScreenSharing ? btnGreen : btnDefault}
          title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 18C21.1 18 22 17.1 22 16V6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20ZM4 6H20V16H4V6Z" />
            <path d="M15 11L11 14V12H9V10H11V8L15 11Z" />
          </svg>
        </button>

        {/* Video Quality */}
        <button
          ref={qualityBtnRef}
          onClick={() => setQualityOpen(!qualityOpen)}
          className={qualityOpen
            ? `${btnBase} bg-surface-channel text-txt-primary`
            : btnDefault
          }
          title="Video Quality"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
          </svg>
        </button>
        <ScreenShareSettingsPopover open={qualityOpen} onClose={() => setQualityOpen(false)} anchorRef={qualityBtnRef} />

        {/* Separator */}
        <div className="w-[1px] h-6 bg-white/10 mx-0.5" />

        {/* Chat Toggle */}
        <button
          onClick={toggleVoiceChat}
          className={voiceChatOpen
            ? `${btnBase} bg-surface-channel text-txt-primary`
            : btnDefault
          }
          title="Toggle Chat"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z" />
          </svg>
        </button>

        {/* Fullscreen Toggle */}
        <button
          onClick={handleFullscreen}
          className={voiceFullscreen
            ? `${btnBase} bg-surface-channel text-txt-primary`
            : btnDefault
          }
          title={voiceFullscreen ? 'Exit Fullscreen (Esc)' : 'Fullscreen'}
        >
          {voiceFullscreen ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
            </svg>
          )}
        </button>

        {/* Separator */}
        <div className="w-[1px] h-6 bg-white/10 mx-0.5" />

        {/* Disconnect */}
        <button
          onClick={handleDisconnect}
          className={`${btnBase} bg-accent-rose hover:bg-accent-rose/80 text-white`}
          title="Disconnect"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 9C10.4 9 8.85 9.25 7.4 9.72V12.82C7.4 13.22 7.17 13.56 6.84 13.72C5.86 14.21 4.97 14.84 4.18 15.57C4 15.75 3.75 15.85 3.48 15.85C3.2 15.85 2.95 15.74 2.77 15.56L0.29 13.08C0.11 12.9 0 12.65 0 12.38C0 12.1 0.11 11.85 0.29 11.67C3.34 8.78 7.46 7 12 7S20.66 8.78 23.71 11.67C23.89 11.85 24 12.1 24 12.38C24 12.65 23.89 12.9 23.71 13.08L21.23 15.56C21.05 15.74 20.8 15.85 20.52 15.85C20.25 15.85 20 15.75 19.82 15.57C19.03 14.84 18.14 14.21 17.16 13.72C16.83 13.56 16.6 13.22 16.6 12.82V9.72C15.15 9.25 13.6 9 12 9Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
