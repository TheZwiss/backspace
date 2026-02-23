import React, { useState } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useServerStore } from '../../stores/serverStore';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { wsSend } from '../../hooks/useWebSocket';
import { AudioManager } from '../../audio/AudioManager';
import { VideoQualityPopover } from './VideoQualityPopover';
import { ConnectionInfoPopover } from './ConnectionInfoPopover';

/**
 * VoiceControls renders the voice status + button rows.
 * It has NO wrapper/card styling — the parent provides the container.
 */
export function VoiceControls() {
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);
  const setRnnoiseEnabled = useVoiceStore((s) => s.setRnnoiseEnabled);
  const connectionError = useVoiceStore((s) => s.connectionError);
  const isLiveKitConnected = useVoiceStore((s) => s.isLiveKitConnected);
  const connectionQuality = useVoiceStore((s) => s.connectionQuality);
  const channels = useServerStore((s) => s.channels);
  const [showVideoQuality, setShowVideoQuality] = useState(false);
  const [showConnectionInfo, setShowConnectionInfo] = useState(false);

  if (!currentVoiceChannelId) return null;

  const channel = channels.find(c => c.id === currentVoiceChannelId);
  const channelName = channel?.name ?? 'Voice Channel';

  const handleCamera = async () => {
    const room = getActiveRoom();
    if (!room) return;
    try {
      await room.localParticipant.setCameraEnabled(!isCameraOn);
      toggleCamera();
    } catch (err) {
      console.error('[VoiceControls] Failed to toggle camera:', err);
    }
  };

  const handleScreenShare = async () => {
    const room = getActiveRoom();
    if (!room) return;
    try {
      if (!isScreenSharing) {
        AudioManager.getInstance().setScreenShareActive(true);
        await room.localParticipant.setScreenShareEnabled(true, { audio: true });
      } else {
        await room.localParticipant.setScreenShareEnabled(false);
        AudioManager.getInstance().setScreenShareActive(false);
      }
      toggleScreenShare();
    } catch (err) {
      console.error('[VoiceControls] Failed to toggle screen share:', err);
    }
  };

  const handleDisconnect = () => {
    wsSend({ type: 'voice_leave' });
    useVoiceStore.getState().leaveVoice();
  };

  const statusColor = connectionError
    ? 'text-discord-red'
    : isLiveKitConnected
      ? 'text-discord-green'
      : 'text-discord-yellow';

  const statusBgColor = connectionError
    ? 'bg-discord-red/20'
    : isLiveKitConnected
      ? 'bg-discord-green/20'
      : 'bg-discord-yellow/20';

  const qualityColor =
    connectionQuality === 'excellent' || connectionQuality === 'good'
      ? 'text-discord-green'
      : connectionQuality === 'poor'
        ? 'text-discord-yellow'
        : connectionQuality === 'lost'
          ? 'text-discord-red'
          : statusColor; // 'unknown' falls back to connection-state color

  const btnBase = 'flex-1 h-[34px] flex items-center justify-center rounded-[4px] transition-colors';
  const btnDefaultStyle = 'bg-[#111214] text-discord-text-muted hover:bg-[#1a1b1e] hover:text-discord-text-secondary';

  return (
    <>
      {/* Row 1: Signal icon + status text + disconnect */}
      <div className="relative flex items-center gap-2 px-3 pt-3 pb-1">
        <button
          onClick={() => {
            setShowConnectionInfo(!showConnectionInfo);
            if (!showConnectionInfo) setShowVideoQuality(false);
          }}
          className={`w-8 h-8 rounded-lg ${statusBgColor} flex items-center justify-center flex-shrink-0 hover:brightness-125 transition-all`}
          title="Connection Info"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className={qualityColor}>
            <path d="M1.5 21.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM3.14 15.75a.75.75 0 01-.09-1.06A8.46 8.46 0 0112 11a8.46 8.46 0 018.95 3.69.75.75 0 01-1.15.97A6.96 6.96 0 0012 12.5a6.96 6.96 0 00-7.8 3.16.75.75 0 01-1.06.09zM6.37 18.3a.75.75 0 01-.08-1.06A5.46 5.46 0 0112 15a5.46 5.46 0 015.71 2.24.75.75 0 01-1.14.97A3.96 3.96 0 0012 16.5a3.96 3.96 0 00-4.57 1.71.75.75 0 01-1.06.09z" />
          </svg>
        </button>

        <div className="min-w-0 flex-1">
          <div className={`text-[13px] font-semibold leading-[18px] ${statusColor}`}>
            {connectionError ? 'Connection Failed' : isLiveKitConnected ? 'Voice Connected' : 'Connecting...'}
          </div>
          <div className="text-[12px] text-discord-channels-default truncate leading-[16px]">
            {connectionError ? connectionError : channelName}
          </div>
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={handleDisconnect}
            className="w-7 h-7 flex items-center justify-center text-discord-text-muted hover:text-discord-text-primary transition-colors rounded"
            title="Disconnect"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 9C10.4 9 8.85 9.25 7.4 9.72V12.82C7.4 13.22 7.17 13.56 6.84 13.72C5.86 14.21 4.97 14.84 4.18 15.57C4 15.75 3.75 15.85 3.48 15.85C3.2 15.85 2.95 15.74 2.77 15.56L0.29 13.08C0.11 12.9 0 12.65 0 12.38C0 12.1 0.11 11.85 0.29 11.67C3.34 8.78 7.46 7 12 7S20.66 8.78 23.71 11.67C23.89 11.85 24 12.1 24 12.38C24 12.65 23.89 12.9 23.71 13.08L21.23 15.56C21.05 15.74 20.8 15.85 20.52 15.85C20.25 15.85 20 15.75 19.82 15.57C19.03 14.84 18.14 14.21 17.16 13.72C16.83 13.56 16.6 13.22 16.6 12.82V9.72C15.15 9.25 13.6 9 12 9Z" />
            </svg>
          </button>
        </div>

        {/* Connection Info Popover */}
        <ConnectionInfoPopover
          open={showConnectionInfo}
          onClose={() => setShowConnectionInfo(false)}
        />
      </div>

      {/* Row 2: Camera, Screen Share, Video Quality, Noise Suppression */}
      <div className="relative flex items-center gap-1 px-3 pb-2 pt-1">
        <button
          onClick={handleCamera}
          className={`${btnBase} ${
            isCameraOn
              ? 'bg-[#111214] text-discord-green hover:bg-[#1a1b1e]'
              : btnDefaultStyle
          }`}
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

        <button
          onClick={handleScreenShare}
          className={`${btnBase} ${
            isScreenSharing
              ? 'bg-[#111214] text-discord-green hover:bg-[#1a1b1e]'
              : btnDefaultStyle
          }`}
          title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 18C21.1 18 22 17.1 22 16V6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20ZM4 6H20V16H4V6Z" />
            <path d="M15 11L11 14V12H9V10H11V8L15 11Z" />
          </svg>
        </button>

        {/* Video Quality */}
        <button
          onClick={() => {
            setShowVideoQuality(!showVideoQuality);
            if (!showVideoQuality) setShowConnectionInfo(false);
          }}
          className={`${btnBase} ${
            showVideoQuality
              ? 'bg-[#111214] text-discord-blurple hover:bg-[#1a1b1e]'
              : btnDefaultStyle
          }`}
          title="Video Quality"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 5v14h18V5H3zm16 12H5V7h14v10z" />
            <path d="M8 15l2.5-3.21L13 15l2-2.5L18 17H6z" />
          </svg>
        </button>

        {/* AI Noise Suppression (RNNoise) */}
        <button
          onClick={() => setRnnoiseEnabled(!rnnoiseEnabled)}
          className={`${btnBase} ${
            rnnoiseEnabled
              ? 'bg-[#111214] text-discord-green hover:bg-[#1a1b1e]'
              : btnDefaultStyle
          }`}
          title={rnnoiseEnabled ? 'Disable AI Noise Suppression' : 'Enable AI Noise Suppression'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" opacity={rnnoiseEnabled ? 0.15 : 0.08} />
            <path d="M12 1a2 2 0 012 2v1a2 2 0 01-4 0V3a2 2 0 012-2z" />
            <path d="M12 7c-1.66 0-3 1.34-3 3v2c0 1.66 1.34 3 3 3s3-1.34 3-3v-2c0-1.66-1.34-3-3-3z" />
            <path d="M17 11v1c0 2.76-2.24 5-5 5s-5-2.24-5-5v-1H5v1c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92v-1h-2z" />
            {rnnoiseEnabled ? (
              <>
                <circle cx="18" cy="5" r="1.2" fill="currentColor" />
                <circle cx="20" cy="8" r="0.9" fill="currentColor" opacity="0.7" />
                <circle cx="6" cy="5" r="1.2" fill="currentColor" />
                <circle cx="4" cy="8" r="0.9" fill="currentColor" opacity="0.7" />
              </>
            ) : (
              <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
            )}
          </svg>
        </button>

        {/* Video Quality Popover */}
        <VideoQualityPopover
          open={showVideoQuality}
          onClose={() => setShowVideoQuality(false)}
        />
      </div>
    </>
  );
}
