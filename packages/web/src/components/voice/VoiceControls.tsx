import React, { useState, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { wsSend } from '../../hooks/useWebSocket';
import { ScreenShareSettingsPopover } from './ScreenShareSettingsPopover';
import { ConnectionInfoPopover } from './ConnectionInfoPopover';
import { startScreenShare, stopScreenShare } from '../../utils/screenShare';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { broadcastVoiceStatus } from '../../utils/voice';

/**
 * VoiceControls renders the voice status + button rows.
 * It has NO wrapper/card styling — the parent provides the container.
 */
export function VoiceControls() {
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);
  const setRnnoiseEnabled = useVoiceStore((s) => s.setRnnoiseEnabled);
  const connectionError = useVoiceStore((s) => s.connectionError);
  const isLiveKitConnected = useVoiceStore((s) => s.isLiveKitConnected);
  const connectionQuality = useVoiceStore((s) => s.connectionQuality);
  const channels = useSpaceStore((s) => s.channels);
  const [showScreenShareSettings, setShowScreenShareSettings] = useState(false);
  const [showConnectionInfo, setShowConnectionInfo] = useState(false);
  const connectionBtnRef = useRef<HTMLButtonElement>(null);
  const qualityBtnRef = useRef<HTMLButtonElement>(null);

  const activeDmCall = useVoiceStore((s) => s.activeDmCall);
  const channelPerms = useSpaceStore((s) => currentVoiceChannelId ? s.channelPermissions.get(currentVoiceChannelId) : undefined);

  // In DM calls, all permissions are granted; in space channels, check SPEAK and STREAM
  const isDmCall = !!activeDmCall;
  const canSpeak = isDmCall || hasPermissionBit(channelPerms, PermissionBits.SPEAK);
  const canStream = isDmCall || hasPermissionBit(channelPerms, PermissionBits.STREAM);

  const voiceOrigin = currentVoiceChannelId ? getChannelOrigin(currentVoiceChannelId) : '';

  if (!currentVoiceChannelId && !activeDmCall) return null;

  const channel = channels.find(c => c.id === currentVoiceChannelId);
  const channelName = channel?.name ?? (activeDmCall ? 'DM Call' : 'Voice Channel');

  const handleCamera = async () => {
    const room = getActiveRoom();
    if (!room) return;
    try {
      const willEnable = !isCameraOn;
      await room.localParticipant.setCameraEnabled(willEnable);
      toggleCamera();
      broadcastVoiceStatus();
    } catch (err) {
      console.error('[VoiceControls] Failed to toggle camera:', err);
    }
  };

  const handleScreenShare = async () => {
    const room = getActiveRoom();
    if (!room) return;
    try {
      if (!isScreenSharing) {
        const started = await startScreenShare(room);
        if (started) broadcastVoiceStatus();
      } else {
        await stopScreenShare(room);
        broadcastVoiceStatus();
      }
    } catch (err) {
      console.error('[VoiceControls] Failed to toggle screen share:', err);
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
  };

  const statusColor = connectionError
    ? 'text-txt-danger'
    : isLiveKitConnected
      ? 'text-status-online'
      : 'text-status-idle';

  const statusBgColor = connectionError
    ? 'bg-accent-rose/20'
    : isLiveKitConnected
      ? 'bg-status-online/20'
      : 'bg-status-idle/20';

  const qualityColor =
    connectionQuality === 'excellent' || connectionQuality === 'good'
      ? 'text-status-online'
      : connectionQuality === 'poor'
        ? 'text-status-idle'
        : connectionQuality === 'lost'
          ? 'text-txt-danger'
          : statusColor; // 'unknown' falls back to connection-state color

  const btnBase = 'flex-1 h-[34px] flex items-center justify-center rounded-[4px] transition-colors';
  const btnDefaultStyle = 'bg-surface-base text-txt-tertiary hover:bg-surface-channel hover:text-txt-secondary';

  return (
    <>
      {/* Row 1: Signal icon + status text + disconnect */}
      <div className="relative flex items-center gap-2 px-3 pt-3 pb-1">
        <button
          ref={connectionBtnRef}
          onClick={() => {
            setShowConnectionInfo(!showConnectionInfo);
            if (!showConnectionInfo) setShowScreenShareSettings(false);
          }}
          className={`w-8 h-8 rounded-lg ${statusBgColor} flex items-center justify-center flex-shrink-0 hover:brightness-125 transition-all`}
          title="Connection Info"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className={qualityColor}>
            <path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z" />
          </svg>
        </button>

        <div className="min-w-0 flex-1">
          <div className={`text-[13px] font-semibold leading-[18px] ${statusColor}`}>
            {connectionError ? 'Connection Failed' : isLiveKitConnected ? 'Voice Connected' : 'Connecting...'}
          </div>
          <div className="text-[12px] text-txt-tertiary truncate leading-[16px]">
            {connectionError ? connectionError : channelName}
          </div>
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={handleDisconnect}
            className="w-7 h-7 flex items-center justify-center text-txt-tertiary hover:text-txt-primary transition-colors rounded"
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
          anchorRef={connectionBtnRef}
        />
      </div>

      {/* Row 2: Camera, Screen Share, Video Quality, Noise Suppression */}
      <div className="relative flex items-center gap-1 px-3 pb-2 pt-1">
        {canSpeak && (
          <button
            onClick={handleCamera}
            className={`${btnBase} ${
              isCameraOn
                ? 'bg-surface-base text-status-online hover:bg-surface-channel'
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
        )}

        {canStream && (
          <button
            onClick={handleScreenShare}
            className={`${btnBase} ${
              isScreenSharing
                ? 'bg-surface-base text-status-online hover:bg-surface-channel'
                : btnDefaultStyle
            }`}
            title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 18C21.1 18 22 17.1 22 16V6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20ZM4 6H20V16H4V6Z" />
              <path d="M15 11L11 14V12H9V10H11V8L15 11Z" />
            </svg>
          </button>
        )}

        {/* Video Quality */}
        <button
          ref={qualityBtnRef}
          onClick={() => {
            setShowScreenShareSettings(!showScreenShareSettings);
            if (!showScreenShareSettings) setShowConnectionInfo(false);
          }}
          className={`${btnBase} ${
            showScreenShareSettings
              ? 'bg-surface-base text-accent-primary hover:bg-surface-channel'
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
              ? 'bg-surface-base text-status-online hover:bg-surface-channel'
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

        {/* Screen Share Settings Popover */}
        <ScreenShareSettingsPopover
          open={showScreenShareSettings}
          onClose={() => setShowScreenShareSettings(false)}
          anchorRef={qualityBtnRef}
        />
      </div>
    </>
  );
}
