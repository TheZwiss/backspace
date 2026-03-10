import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { getActiveRoom, setStreamSubscription } from '../../hooks/useLiveKit';
import { ScreenShareSettingsPopover } from './ScreenShareSettingsPopover';
import { stopScreenShare, changeScreenShare } from '../../utils/screenShare';

interface StreamContextMenuProps {
  userId: string;
  identity: string;
  isLocal: boolean;
  position: { x: number; y: number };
  onClose: () => void;
}

export function StreamContextMenu({ userId, identity, isLocal, position, onClose }: StreamContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  const [qualityPopoverOpen, setQualityPopoverOpen] = useState(false);
  const qualityBtnRef = useRef<HTMLButtonElement>(null);

  const streamVolumes = useVoiceStore((s) => s.streamVolumes);
  const streamMutes = useVoiceStore((s) => s.streamMutes);
  const watchingStreams = useVoiceStore((s) => s.watchingStreams);
  const streamAttenuationEnabled = useVoiceStore((s) => s.streamAttenuationEnabled);
  const streamAttenuationStrength = useVoiceStore((s) => s.streamAttenuationStrength);
  const setStreamVolumeAction = useVoiceStore((s) => s.setStreamVolume);
  const setStreamMuteAction = useVoiceStore((s) => s.setStreamMute);
  const setAttenuationEnabled = useVoiceStore((s) => s.setStreamAttenuationEnabled);
  const setAttenuationStrength = useVoiceStore((s) => s.setStreamAttenuationStrength);

  const isWatching = watchingStreams.has(userId);
  const streamVolume = streamVolumes.get(userId) ?? 100;
  const isStreamMuted = streamMutes.get(userId) ?? false;

  const handleWatch = useCallback(() => {
    useVoiceStore.getState().watchStream(userId);
    setStreamSubscription(getActiveRoom(), identity, true);
  }, [userId, identity]);

  const handleUnwatch = useCallback(() => {
    useVoiceStore.getState().unwatchStream(userId);
    setStreamSubscription(getActiveRoom(), identity, false);
  }, [userId, identity]);

  const handleStopStreaming = useCallback(async () => {
    const room = getActiveRoom();
    if (room) {
      await stopScreenShare(room);
    }
  }, []);

  const handleChangeStream = useCallback(async () => {
    const room = getActiveRoom();
    if (room) {
      await changeScreenShare(room);
    }
  }, []);

  // Click-outside dismissal (guards nested popover)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (qualityPopoverOpen) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, qualityPopoverOpen]);

  // Viewport-aware positioning
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = position.x;
    let y = position.y;
    if (rect.right > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (rect.bottom > window.innerHeight) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [position]);

  const btnClass = 'w-full text-left px-2 py-1.5 mx-1.5 text-sm rounded-sm flex items-center gap-2 text-txt-secondary hover:bg-accent-primary hover:text-white';
  const btnStyle: React.CSSProperties = { width: 'calc(100% - 12px)' };

  return ReactDOM.createPortal(
    <div
      ref={menuRef}
      className="fixed z-[200] bg-surface-elevated rounded-md shadow-elevation-high min-w-[220px] max-h-[calc(100vh-16px)] overflow-y-auto scrollbar-thin animate-fade-in"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {isLocal ? (
        <>
          <div className="py-1.5">
            <button
              onClick={() => {
                handleStopStreaming();
                onClose();
              }}
              className={`${btnClass} text-red-400 hover:text-white`}
              style={btnStyle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
                <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" />
                <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" strokeWidth="2" />
              </svg>
              Stop Streaming
            </button>
            <button
              onClick={() => {
                handleChangeStream();
                onClose();
              }}
              className={btnClass}
              style={btnStyle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
                <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
              </svg>
              Change Stream
            </button>
          </div>
          <div className="h-px bg-white/[0.06] mx-1.5" />
          <div className="p-3">
            <div className="text-xs text-txt-tertiary mb-2 font-medium uppercase tracking-wider">
              Stream Quality
            </div>
            <div className="relative">
              <button
                ref={qualityBtnRef}
                onClick={() => setQualityPopoverOpen(!qualityPopoverOpen)}
                className="w-full flex items-center justify-between px-2 py-1.5 text-sm text-txt-secondary hover:bg-interactive-hover rounded transition-colors"
              >
                <span>{`${useVoiceStore.getState().screenShareConfig.height}p ${useVoiceStore.getState().screenShareConfig.fps}fps`}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              </button>
              {qualityPopoverOpen && (
                <ScreenShareSettingsPopover
                  open={qualityPopoverOpen}
                  onClose={() => setQualityPopoverOpen(false)}
                  anchorRef={qualityBtnRef}
                />
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="py-1.5">
            {isWatching ? (
              <button
                onClick={() => {
                  handleUnwatch();
                  onClose();
                }}
                className={btnClass}
                style={btnStyle}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
                  <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
                </svg>
                Stop Watching
              </button>
            ) : (
              <button
                onClick={() => {
                  handleWatch();
                  onClose();
                }}
                className={btnClass}
                style={btnStyle}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
                  <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                </svg>
                Watch Stream
              </button>
            )}
          </div>
          <div className="h-px bg-white/[0.06] mx-1.5" />
          <div className="py-1.5">
            <button
              onClick={() => setStreamMuteAction(userId, !isStreamMuted)}
              className={btnClass}
              style={btnStyle}
            >
              <span className="flex-1">Mute Stream</span>
              <div
                className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                  isStreamMuted
                    ? 'bg-accent-primary border-accent-primary'
                    : 'border-txt-tertiary'
                }`}
              >
                {isStreamMuted && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="white">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                )}
              </div>
            </button>
          </div>
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
                onChange={(e) => setStreamVolumeAction(userId, parseInt(e.target.value))}
                className="flex-1 accent-accent-primary h-1"
              />
              <span className="text-xs text-txt-secondary min-w-[32px] text-right">
                {streamVolume}%
              </span>
            </div>
          </div>
          <div className="h-px bg-white/[0.06] mx-1.5" />
          <div className="py-1.5">
            <button
              onClick={() => setAttenuationEnabled(!streamAttenuationEnabled)}
              className={btnClass}
              style={btnStyle}
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
        </>
      )}
    </div>,
    document.body,
  );
}
