import { Tooltip } from '../ui/Tooltip';
import { StrikeLine } from '../ui/StrikeLine';
import { TextVoiceButton } from './TextVoice';
import { SoundboardButton } from './Soundboard';
import React, { useEffect, useState, useRef } from 'react';
import { isElectron } from '../../platform/platform';
import { openDetachedCallWindow } from './DetachedCallWindow';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore, getChannelOrigin, getMyUserIdForOrigin } from '../../stores/spaceStore';
import { ScreenShareSettingsPopover } from './ScreenShareSettingsPopover';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { handleMuteAction, handleDeafenAction, handleCameraAction, handleScreenShareAction, handleScreenShareActionForWindow, handleChangeScreenShareAction, handleDisconnectAction } from '../../utils/voiceActions';
import { VOICE_CHROME_ATTR } from '../../hooks/usePointerReveal';

const btnBase = 'w-10 h-10 flex items-center justify-center rounded-full transition-colors';
const btnDefault = `${btnBase} bg-surface-channel text-txt-secondary hover:bg-surface-elevated hover:text-txt-primary`;
const btnActive = (color: string) => `${btnBase} bg-${color}/20 text-${color} hover:bg-${color}/30`;
const btnGreen = `${btnBase} bg-surface-channel text-status-online hover:bg-surface-elevated`;

/**
 * `revealed` is the fullscreen idle state, owned by MainContent because it
 * watches the voice container the pointer actually moves over. It is ignored
 * while docked, where plain hover on the voice panel is the right model.
 */
export function VoiceControlBar({ revealed = false, variant = 'floating', detached = false, detachedFullscreen = false, onDetachedFullscreenToggle }: { revealed?: boolean; variant?: 'floating' | 'docked'; detached?: boolean; detachedFullscreen?: boolean; onDetachedFullscreenToggle?: () => void }) {
  const { t } = useTranslation(['voice', 'common']);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isCameraStarting = useVoiceStore((s) => s.isCameraStarting);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const voiceChatOpen = useUIStore((s) => s.voiceChatOpen);
  const voiceChatFocus = useUIStore((s) => s.voiceChatFocus);
  const toggleVoiceChat = useUIStore((s) => s.toggleVoiceChat);
  const toggleVoiceChatFocus = useUIStore((s) => s.toggleVoiceChatFocus);
  const mainFullscreen = useUIStore((s) => s.voiceFullscreen);
  const voiceFullscreen = detached ? detachedFullscreen : mainFullscreen;
  const toggleVoiceFullscreen = useUIStore((s) => s.toggleVoiceFullscreen);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const myUser = useAuthStore((s) => s.user);
  const spaceId = useSpaceStore((s) => currentVoiceChannelId ? s.channelToSpaceMap.get(currentVoiceChannelId) : null);
  const myOriginId = useSpaceStore((s) => currentVoiceChannelId ? getMyUserIdForOrigin(getChannelOrigin(currentVoiceChannelId)) : s.members.find(m => m.userId === myUser?.id)?.userId ?? myUser?.id);
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const isSpaceMuted = !!(myOriginId && spaceId && spaceMutedUserIds.has(`${spaceId}:${myOriginId}`));
  const isSpaceDeafened = !!(myOriginId && spaceId && spaceDeafenedUserIds.has(`${spaceId}:${myOriginId}`));
  const activeDmCall = useVoiceStore((s) => s.activeDmCall);
  const channelPerms = useSpaceStore((s) => currentVoiceChannelId ? s.channelPermissions.get(currentVoiceChannelId) : undefined);
  const isDmCall = !!activeDmCall;
  const canSpeak = isDmCall || hasPermissionBit(channelPerms, PermissionBits.SPEAK);
  const canStream = isDmCall || hasPermissionBit(channelPerms, PermissionBits.STREAM);
  // The screen-share button is the single entry point to stream settings:
  // idle → opens the OS/Electron source picker; live → opens the settings
  // popover (quality controls + the red stop action).
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const shareBtnRef = useRef<HTMLButtonElement>(null);

  // An open share menu pins the bar: the popover hangs off it, so letting the
  // idle timer pull it away would take the menu with it.
  const fullscreenVisibility = revealed || shareMenuOpen
    ? 'opacity-100'
    : 'opacity-0 focus-within:opacity-100 [@media(hover:none)]:opacity-100 [@media(any-pointer:coarse)]:opacity-100';
  const containerClassName = variant === 'docked'
    ? 'relative z-20 h-20 flex items-center justify-center border-t border-border-soft bg-surface-chat flex-shrink-0'
    : voiceFullscreen
      ? `pointer-events-none absolute inset-x-0 bottom-0 z-20 h-24 flex items-end justify-center pb-6 transition-opacity duration-300 ease-out ${fullscreenVisibility}`
      : 'absolute bottom-6 left-1/2 -translate-x-1/2 z-20 opacity-0 translate-y-4 group-hover/voice:opacity-100 group-hover/voice:translate-y-0 transition-all duration-300 ease-out';

  const handleMute = React.useCallback(() => {
    handleMuteAction(isSpaceMuted, isSpaceDeafened);
  }, [isSpaceMuted, isSpaceDeafened]);

  const handleDeafen = React.useCallback(() => {
    handleDeafenAction(isSpaceDeafened);
  }, [isSpaceDeafened]);

  const handleCamera = () => handleCameraAction();

  const handleScreenShare = () => {
    if (isScreenSharing) {
      setShareMenuOpen((open) => !open);
      return;
    }
    if (detached && shareBtnRef.current) {
      void handleScreenShareActionForWindow(shareBtnRef.current.ownerDocument);
    } else {
      void handleScreenShareAction();
    }
  };

  const handleStopSharing = () => {
    setShareMenuOpen(false);
    handleScreenShareAction();
  };

  const handleChangeSource = () => {
    setShareMenuOpen(false);
    handleChangeScreenShareAction(detached ? shareBtnRef.current?.ownerDocument : undefined);
  };

  // A share that ends outside the menu (OS "Stop sharing" bar, track loss,
  // keybind) must not leave a stale settings popover anchored to the button.
  useEffect(() => {
    if (!isScreenSharing) setShareMenuOpen(false);
  }, [isScreenSharing]);

  const handleDisconnect = () => handleDisconnectAction();

  const handleFullscreen = () => {
    if (detached) onDetachedFullscreenToggle?.();
    else toggleVoiceFullscreen();
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && voiceFullscreen) {
        useUIStore.getState().setVoiceFullscreen(false);
      }
    };
    if (detached) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [voiceFullscreen, detached]);

  return (
    <div
      data-testid="voice-control-overlay"
      className={containerClassName}
      {...(voiceFullscreen ? { [VOICE_CHROME_ATTR]: '' } : {})}
    >
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full px-3 py-2 glass-bubble">
        <TextVoiceButton />
        <SoundboardButton />
        {/* Mute */}
        <Tooltip content={(isSpaceMuted || isSpaceDeafened)
            ? (isMuted ? t('voice:controls.spaceMutedSelfMuted') : t('voice:badges.spaceMuted'))
            : isMuted ? t('voice:controls.unmuteShortcut') : t('voice:controls.muteShortcut')} position="top"><button data-icon-motion="toggle" aria-label={(isSpaceMuted || isSpaceDeafened)
            ? (isMuted ? t('voice:controls.spaceMutedSelfMuted') : t('voice:badges.spaceMuted'))
            : isMuted ? t('voice:controls.unmuteShortcut') : t('voice:controls.muteShortcut')}
          onClick={handleMute}
          className={(isSpaceMuted || isSpaceDeafened)
            ? `${btnBase} bg-accent-amber/20 text-accent-amber cursor-not-allowed`
            : isMuted || isDeafened
              ? `${btnBase} bg-accent-rose/20 text-txt-danger hover:bg-accent-rose/30`
              : btnDefault
          }

        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
            <StrikeLine active={isMuted || isDeafened || isSpaceMuted || isSpaceDeafened} />
          </svg>
        </button></Tooltip>

        {/* Deafen */}
        <Tooltip content={isSpaceDeafened ? t('voice:badges.spaceDeafened') : isDeafened ? t('voice:controls.undeafenShortcut') : t('voice:controls.deafenShortcut')} position="top"><button data-icon-motion="toggle" aria-label={isSpaceDeafened ? t('voice:badges.spaceDeafened') : isDeafened ? t('voice:controls.undeafenShortcut') : t('voice:controls.deafenShortcut')}
          onClick={handleDeafen}
          className={isSpaceDeafened
            ? `${btnBase} bg-accent-amber/20 text-accent-amber cursor-not-allowed`
            : isDeafened
              ? `${btnBase} bg-accent-rose/20 text-txt-danger hover:bg-accent-rose/30`
              : btnDefault
          }

        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z" />
            <StrikeLine active={isDeafened || isSpaceDeafened} />
          </svg>
        </button></Tooltip>

        {/* Camera */}
        {canSpeak && (
          <Tooltip content={isCameraOn ? t('voice:controls.cameraOff') : t('voice:controls.cameraOn')} position="top"><button data-icon-motion="toggle" aria-label={isCameraOn ? t('voice:controls.cameraOff') : t('voice:controls.cameraOn')}
            onClick={handleCamera}
            aria-busy={isCameraStarting || undefined}
            disabled={isCameraStarting}
            className={`${isCameraOn ? btnGreen : btnDefault} ${isCameraStarting ? 'cursor-progress' : ''}`}

          >
            {isCameraStarting ? <LoadingSpinner size={20} /> : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17 10.5V7C17 6.45 16.55 6 16 6H4C3.45 6 3 6.45 3 7V17C3 17.55 3.45 18 4 18H16C16.55 18 17 17.55 17 17V13.5L21 17.5V6.5L17 10.5Z" />
                <StrikeLine active={!isCameraOn} inset={2} />
              </svg>
            )}
          </button></Tooltip>
        )}

        {/* Screen Share — picker when idle, settings + stop menu when live */}
        {canStream && (
          <>
            <Tooltip content={isScreenSharing ? t('voice:controls.shareOptions') : t('voice:controls.shareScreen')} position="top"><button data-icon-motion="expand" aria-label={isScreenSharing ? t('voice:controls.shareOptions') : t('voice:controls.shareScreen')}
              ref={shareBtnRef}
              onClick={handleScreenShare}
              // Idle the button starts a share; live it toggles a menu, so it
              // only claims a popup in the state where it actually opens one.
              aria-haspopup={isScreenSharing ? 'dialog' : undefined}
              aria-expanded={isScreenSharing ? shareMenuOpen : undefined}
              className={isScreenSharing ? btnGreen : btnDefault}

            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 18C21.1 18 22 17.1 22 16V6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20ZM4 6H20V16H4V6Z" />
                <path d="M15 11L11 14V12H9V10H11V8L15 11Z" />
              </svg>
            </button></Tooltip>
            <ScreenShareSettingsPopover
              open={shareMenuOpen && isScreenSharing}
              onClose={() => setShareMenuOpen(false)}
              anchorRef={shareBtnRef}
              onChangeSource={handleChangeSource}
              onStopSharing={handleStopSharing}
            />
          </>
        )}

        {/* Separator */}
        <div className="w-[1px] h-6 bg-wash/10 mx-0.5" />

        {!detached && <>
        {/* Chat Toggle */}
        <Tooltip content={t('voice:controls.toggleChat')} position="top"><button data-icon-motion="press" aria-label={t('voice:controls.toggleChat')}
          onClick={toggleVoiceChat}
          className={voiceChatOpen
            ? `${btnBase} bg-surface-channel text-txt-primary`
            : btnDefault
          }

        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z" />
          </svg>
        </button></Tooltip>

        {/* Chat focus */}
        <Tooltip content={voiceChatFocus ? t('voice:controls.unfocusChat') : t('voice:controls.focusChat')} position="top"><button data-icon-motion="press" aria-label={voiceChatFocus ? t('voice:controls.unfocusChat') : t('voice:controls.focusChat')}
          onClick={toggleVoiceChatFocus}
          aria-pressed={voiceChatFocus}
          className={voiceChatFocus
            ? `${btnBase} bg-surface-channel text-txt-primary`
            : btnDefault
          }

        >
          {voiceChatFocus ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 2v10h10V7H4Zm12 0v10h4V7h-4Z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v12h11V6H4Zm13 0v12h3V6h-3ZM9 8l4 4-4 4v-3H6v-2h3V8Z" />
            </svg>
          )}
        </button></Tooltip>

        </>}

        {/* Fullscreen Toggle */}
        <Tooltip content={voiceFullscreen ? t('voice:controls.exitFullscreen') : t('voice:controls.fullscreen')} position="top"><button data-icon-motion="expand" aria-label={voiceFullscreen ? t('voice:controls.exitFullscreen') : t('voice:controls.fullscreen')}
          onClick={handleFullscreen}
          className={voiceFullscreen
            ? `${btnBase} bg-surface-channel text-txt-primary`
            : btnDefault
          }

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
        </button></Tooltip>

        {!detached && isElectron() && (
          <Tooltip content={t('voice:controls.openCallWindow')} position="top"><button data-icon-motion="press" aria-label={t('voice:controls.openCallWindow')} onClick={() => {
            if (!openDetachedCallWindow()) useUIStore.getState().addToast(t('voice:controls.callWindowFailed'), 'warning');
          }} className={btnDefault} >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M4 5h10v2H4v11h14v-8h2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm12-2h6v6h-2V6.4l-5.3 5.3-1.4-1.4L18.6 5H16V3Z" />
            </svg>
          </button></Tooltip>
        )}

        {/* Separator */}
        <div className="w-[1px] h-6 bg-wash/10 mx-0.5" />

        {/* Disconnect */}
        <Tooltip content={t('voice:controls.disconnect')} position="top"><button data-icon-motion="press" aria-label={t('voice:controls.disconnect')}
          onClick={handleDisconnect}
          className={`${btnBase} bg-accent-rose hover:bg-accent-rose/80 text-white`}

        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 9C10.4 9 8.85 9.25 7.4 9.72V12.82C7.4 13.22 7.17 13.56 6.84 13.72C5.86 14.21 4.97 14.84 4.18 15.57C4 15.75 3.75 15.85 3.48 15.85C3.2 15.85 2.95 15.74 2.77 15.56L0.29 13.08C0.11 12.9 0 12.65 0 12.38C0 12.1 0.11 11.85 0.29 11.67C3.34 8.78 7.46 7 12 7S20.66 8.78 23.71 11.67C23.89 11.85 24 12.1 24 12.38C24 12.65 23.89 12.9 23.71 13.08L21.23 15.56C21.05 15.74 20.8 15.85 20.52 15.85C20.25 15.85 20 15.75 19.82 15.57C19.03 14.84 18.14 14.21 17.16 13.72C16.83 13.56 16.6 13.22 16.6 12.82V9.72C15.15 9.25 13.6 9 12 9Z" />
          </svg>
        </button></Tooltip>
      </div>
    </div>
  );
}
