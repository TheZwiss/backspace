import React from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useServerStore } from '../../stores/serverStore';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { wsSend } from '../../hooks/useWebSocket';

export function VoiceControls() {
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);
  const connectionError = useVoiceStore((s) => s.connectionError);
  const isLiveKitConnected = useVoiceStore((s) => s.isLiveKitConnected);
  const channels = useServerStore((s) => s.channels);

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
      await room.localParticipant.setScreenShareEnabled(!isScreenSharing);
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

  return (
    <div className="bg-[#232428] border-t border-discord-bg-tertiary">
      {/* Row 1: Signal icon + status text + right icons */}
      <div className="flex items-center gap-2 px-2 pt-[10px] pb-1">
        {/* Signal icon */}
        <div className={`w-8 h-8 rounded-lg ${statusBgColor} flex items-center justify-center flex-shrink-0`}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className={statusColor}>
            <path d="M1.5 21.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM3.14 15.75a.75.75 0 01-.09-1.06A8.46 8.46 0 0112 11a8.46 8.46 0 018.95 3.69.75.75 0 01-1.15.97A6.96 6.96 0 0012 12.5a6.96 6.96 0 00-7.8 3.16.75.75 0 01-1.06.09zM6.37 18.3a.75.75 0 01-.08-1.06A5.46 5.46 0 0112 15a5.46 5.46 0 015.71 2.24.75.75 0 01-1.14.97A3.96 3.96 0 0012 16.5a3.96 3.96 0 00-4.57 1.71.75.75 0 01-1.06.09z" />
          </svg>
        </div>

        {/* Status text */}
        <div className="min-w-0 flex-1">
          <div className={`text-[13px] font-semibold leading-[18px] ${statusColor}`}>
            {connectionError ? 'Connection Failed' : isLiveKitConnected ? 'Voice Connected' : 'Connecting...'}
          </div>
          <div className="text-[12px] text-discord-channels-default truncate leading-[16px]">
            {connectionError ? connectionError : channelName}
          </div>
        </div>

        {/* Right icons */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {/* Signal quality */}
          <button className="w-7 h-7 flex items-center justify-center text-discord-text-muted hover:text-discord-text-primary transition-colors rounded" title="Connection Info">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2 20h2V8H2v12zm5 0h2V4H7v16zm5 0h2v-8h-2v8zm5 0h2V12h-2v8z" />
            </svg>
          </button>
          {/* Disconnect */}
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
      </div>

      {/* Row 2: Media control buttons */}
      <div className="flex items-center gap-1 px-2 pb-[10px] pt-1">
        {/* Camera */}
        <button
          onClick={handleCamera}
          className={`flex-1 h-[34px] flex items-center justify-center rounded-[4px] transition-colors ${
            isCameraOn
              ? 'bg-discord-bg-tertiary text-discord-green hover:bg-discord-bg-tertiary/80'
              : 'bg-discord-bg-tertiary text-discord-text-muted hover:bg-discord-bg-tertiary/80 hover:text-discord-text-secondary'
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

        {/* Screen Share */}
        <button
          onClick={handleScreenShare}
          className={`flex-1 h-[34px] flex items-center justify-center rounded-[4px] transition-colors ${
            isScreenSharing
              ? 'bg-discord-bg-tertiary text-discord-green hover:bg-discord-bg-tertiary/80'
              : 'bg-discord-bg-tertiary text-discord-text-muted hover:bg-discord-bg-tertiary/80 hover:text-discord-text-secondary'
          }`}
          title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 18C21.1 18 22 17.1 22 16V6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20ZM4 6H20V16H4V6Z" />
            <path d="M15 11L11 14V12H9V10H11V8L15 11Z" />
          </svg>
        </button>

        {/* Noise Suppression */}
        <button
          className="flex-1 h-[34px] flex items-center justify-center rounded-[4px] bg-discord-bg-tertiary text-discord-text-muted hover:bg-discord-bg-tertiary/80 hover:text-discord-text-secondary transition-colors"
          title="Noise Suppression"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L9.19 8.63L2 9.24L7.46 13.97L5.82 21L12 17.27L18.18 21L16.54 13.97L22 9.24L14.81 8.63L12 2Z" />
          </svg>
        </button>

        {/* Activities */}
        <button
          className="flex-1 h-[34px] flex items-center justify-center rounded-[4px] bg-discord-bg-tertiary text-discord-text-muted hover:bg-discord-bg-tertiary/80 hover:text-discord-text-secondary transition-colors"
          title="Activities"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.5 2C5.01 2 3 4.01 3 6.5C3 8.99 5.01 11 7.5 11S12 8.99 12 6.5C12 4.01 9.99 2 7.5 2ZM16.5 2C14.01 2 12 4.01 12 6.5C12 8.99 14.01 11 16.5 11S21 8.99 21 6.5C21 4.01 18.99 2 16.5 2ZM7.5 13C5.01 13 3 15.01 3 17.5S5.01 22 7.5 22 12 19.99 12 17.5 9.99 13 7.5 13ZM16.5 13C14.01 13 12 15.01 12 17.5S14.01 22 16.5 22 21 19.99 21 17.5 18.99 13 16.5 13Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
