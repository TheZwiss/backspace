import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageList } from '../chat/MessageList';
import { MessageInput } from '../chat/MessageInput';
import { VoiceGrid } from '../voice/VoiceGrid';
import { VoiceControlBar } from '../voice/VoiceControlBar';
import { VoiceChatPanel } from '../voice/VoiceChatPanel';
import { FriendsPage } from '../chat/FriendsPage';
import { ExplorePage } from '../chat/ExplorePage';
import { Avatar } from '../ui/Avatar';
import { useVoiceStore } from '../../stores/voiceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { MemberListToggleButton } from './MemberListToggleButton';
import { TransferIndicator } from './TransferIndicator';
import { isSelf, parseFederatedUsername } from '../../utils/identity';
import { Tooltip } from '../ui/Tooltip';
import { joinVoiceChannel } from '../../utils/voice';
import { SearchPopover } from '../chat/SearchPopover';
import { isDmChannel, getChannelOrigin } from '../../stores/spaceStore';

export function MainContent() {
  // 1. ALL HOOKS AT THE TOP
  const channels = useSpaceStore((s) => s.channels);
  const currentChannelId = useChatStore((s) => s.currentChannelId);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const voiceChatOpen = useUIStore((s) => s.voiceChatOpen);
  const voiceFullscreen = useUIStore((s) => s.voiceFullscreen);
  const setVoiceFullscreen = useUIStore((s) => s.setVoiceFullscreen);
  const participants = useVoiceStore((s) => s.participants);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isLiveKitConnected = useVoiceStore((s) => s.isLiveKitConnected);
  const connectionError = useVoiceStore((s) => s.connectionError);
  const showDms = useUIStore((s) => s.showDms);
  const location = useLocation();
  const isExplorePage = location.pathname === '/explore';
  const activeDmCall = useVoiceStore((s) => s.activeDmCall);
  const outgoingCall = useVoiceStore((s) => s.outgoingCall);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const authUser = useAuthStore((s) => s.user);
  const openModal = useUIStore((s) => s.openModal);

  const voiceContainerRef = useRef<HTMLDivElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jumpToMessageId, setJumpToMessageId] = useState<string | null>(null);

  // Reset search when channel changes
  useEffect(() => {
    setSearchOpen(false);
  }, [currentChannelId]);

  // Handle actual browser fullscreen API
  useEffect(() => {
    const handleFullscreenChange = () => {
      setVoiceFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [setVoiceFullscreen]);

  useEffect(() => {
    if (voiceFullscreen && voiceContainerRef.current && !document.fullscreenElement) {
      voiceContainerRef.current.requestFullscreen().catch(err => {
        console.error('Error attempting to enable full-screen mode:', err);
      });
    } else if (!voiceFullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, [voiceFullscreen]);

  // 2. LOGIC AND EARLY RETURNS
  const channel = channels.find(c => c.id === currentChannelId);
  const isVoiceChannel = channel?.type === 'voice';

  if (showDms || isExplorePage || !currentSpaceId) {
    if (!currentChannelId) {
      if (isExplorePage) return <ExplorePage />;
      return <FriendsPage />;
    }

    const dmChannel = dmChannels.find(dm => dm.id === currentChannelId);
    const otherMembers = dmChannel?.members.filter(m => !isSelf(m, authUser)) ?? [];
    const isGroupDm = !!dmChannel?.ownerId;
    const firstOther = otherMembers[0];
    const { baseName: firstBaseName, domain: firstDomain } = parseFederatedUsername(firstOther?.username ?? '');
    const dmName = isGroupDm
      ? otherMembers.map(m => m.displayName ?? parseFederatedUsername(m.username).baseName).join(', ')
      : firstOther?.displayName ?? (firstBaseName || 'Direct Message');

    const isInDmCall = activeDmCall?.dmChannelId === currentChannelId;
    const isCallingThisDm = outgoingCall?.dmChannelId === currentChannelId;

    const handleStartVoiceCall = () => {
      if (!currentChannelId) return;
      useVoiceStore.getState().setOutgoingCall({ dmChannelId: currentChannelId });
      wsSend({ type: 'dm_call_start', dmChannelId: currentChannelId }, getChannelOrigin(currentChannelId));
    };

    const handleCancelCall = () => {
      if (!currentChannelId) return;
      useVoiceStore.getState().setOutgoingCall(null);
      const { federatedCallId, callOrigin } = useVoiceStore.getState();
      const origin = callOrigin || getChannelOrigin(currentChannelId);
      wsSend({ type: 'dm_call_end', dmChannelId: currentChannelId, federatedCallId }, origin);
    };

    if (isInDmCall) {
      return (
        <div
          ref={voiceContainerRef}
          className={`flex-1 flex flex-col bg-surface-base min-w-0 group/voice relative ${voiceFullscreen ? 'h-screen' : ''}`}
        >
          <div className={`h-14 px-5 flex items-center justify-between border-b border-border-hard flex-shrink-0 bg-surface-base transition-opacity duration-300 ${voiceFullscreen ? 'opacity-0 hover:opacity-100' : ''}`}>
            <div className="flex items-center gap-[10px]">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
              <span className="font-bold text-[15px] tracking-[-0.02em] text-txt-primary">{dmName}</span>
              {connectionError ? (
                <span className="text-xs text-txt-danger font-medium ml-2">Connection Failed</span>
              ) : isLiveKitConnected ? (
                <>
                  <span className="text-xs text-status-online font-medium ml-2">Connected</span>
                  <span className="text-xs text-txt-tertiary ml-1">{participants.length} in call</span>
                </>
              ) : (
                <span className="text-xs text-status-idle font-medium ml-2">Connecting...</span>
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <TransferIndicator />
              <MemberListToggleButton />
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden pb-20">
            <VoiceGrid participants={participants} />
            {voiceChatOpen && !voiceFullscreen && (
              <VoiceChatPanel channelId={currentChannelId} channelName={`@${dmName}`} />
            )}
          </div>

          <VoiceControlBar />
        </div>
      );
    }

    return (
      <div className="flex-1 flex flex-col bg-surface-chat min-w-0 relative">
        {isCallingThisDm && (
          <div className="bg-status-online/10 border-b border-status-online/20 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-status-online animate-pulse">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
              <span className="text-status-online text-sm font-medium">Calling {dmName}...</span>
            </div>
            <button
              onClick={handleCancelCall}
              className="px-3 py-1 bg-accent-rose hover:bg-accent-rose/80 text-white text-xs font-medium rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
        <div className="h-14 px-5 flex items-center justify-between border-b border-border-hard flex-shrink-0 z-10 bg-surface-chat">
          <div className="flex items-center gap-[10px] min-w-0">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary flex-shrink-0">
              <path d="M12.5 2A6.5 6.5 0 0 0 6 8.5c0 1.82.75 3.47 1.95 4.65A10.02 10.02 0 0 0 2 22h2c0-4.42 3.58-8 8-8 .35 0 .69.03 1.03.07A6.49 6.49 0 0 0 19 8.5 6.5 6.5 0 0 0 12.5 2Zm0 11A4.5 4.5 0 1 1 17 8.5a4.5 4.5 0 0 1-4.5 4.5Z" />
            </svg>
            <span className="font-bold text-[15px] tracking-[-0.02em] text-txt-primary truncate">{dmName}</span>
            {!isGroupDm && firstDomain && (
              <Tooltip content={firstOther?.username ?? ''} position="bottom">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary/80 flex-shrink-0">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                </svg>
              </Tooltip>
            )}
            {isGroupDm && (
              <span className="text-xs text-txt-tertiary flex-shrink-0">({dmChannel?.members.length} Members)</span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={handleStartVoiceCall}
              disabled={!!outgoingCall || !!activeDmCall}
              className="w-8 h-8 flex items-center justify-center text-txt-tertiary hover:text-txt-primary transition-colors rounded-[6px] hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
              title="Start Voice Call"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </button>
            <button
              onClick={handleStartVoiceCall}
              disabled={!!outgoingCall || !!activeDmCall}
              className="w-8 h-8 flex items-center justify-center text-txt-tertiary hover:text-txt-primary transition-colors rounded-[6px] hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
              title="Start Video Call"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z" />
              </svg>
            </button>
            <button className="w-8 h-8 flex items-center justify-center text-txt-tertiary hover:text-txt-primary transition-colors rounded-[6px] hover:bg-interactive-hover" title="Pinned Messages">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" transform="rotate(45 12 12)" />
                <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
              </svg>
            </button>
            <button
              onClick={() => openModal('addDmMember', { dmChannelId: currentChannelId })}
              className="w-8 h-8 flex items-center justify-center text-txt-tertiary hover:text-txt-primary transition-colors rounded-[6px] hover:bg-interactive-hover"
              title="Add Friends to DM"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M14 8.00598C14 10.211 12.206 12.006 10 12.006C7.795 12.006 6 10.211 6 8.00598C6 5.80098 7.794 4.00598 10 4.00598C12.206 4.00598 14 5.80098 14 8.00598ZM2 19.006C2 15.473 5.29 13.006 10 13.006C14.711 13.006 18 15.473 18 19.006V20.006H2V19.006ZM20 20.006H22V19.006C22 16.451 20.178 14.471 17.532 13.471C19.461 14.601 20 16.561 20 19.006V20.006Z" />
              </svg>
            </button>
            <button
              ref={searchButtonRef}
              onClick={() => setSearchOpen(!searchOpen)}
              className={`w-8 h-8 flex items-center justify-center transition-colors rounded-[6px] ${searchOpen ? 'text-txt-primary bg-interactive-active' : 'text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover'}`}
              title="Search"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21.707 20.293l-5.395-5.395A7.457 7.457 0 0018 10.5 7.5 7.5 0 1010.5 18c1.575 0 3.027-.486 4.228-1.31l5.476 5.476a.997.997 0 001.414 0l.089-.089a1 1 0 000-1.414l.001-.37zM10.5 16a5.5 5.5 0 110-11 5.5 5.5 0 010 11z" />
              </svg>
            </button>
            <TransferIndicator />
            <div className="w-[1px] h-5 bg-border-soft mx-1" />
            <MemberListToggleButton />
          </div>
        </div>
        <MessageList channelId={currentChannelId} jumpToMessageId={jumpToMessageId} onJumpComplete={() => setJumpToMessageId(null)} />
        <MessageInput channelId={currentChannelId} channelName={`@${dmName}`} />
        <SearchPopover
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          anchorRef={searchButtonRef}
          channelId={currentChannelId}
          isDm={true}
          onJumpToMessage={(id) => { setJumpToMessageId(id); setSearchOpen(false); }}
        />
      </div>
    );
  }

  if (!currentChannelId || !channel) {
    return (
      <div className="flex-1 flex flex-col bg-surface-chat relative">
        <div className="h-14 px-5 flex items-center justify-between border-b border-border-hard">
          <span className="text-txt-tertiary">Select a channel</span>
          <div className="flex items-center gap-1 flex-shrink-0">
            <TransferIndicator />
            <MemberListToggleButton />
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center text-txt-tertiary">
          <p>Select a text or voice channel to get started</p>
        </div>
      </div>
    );
  }

  if (isVoiceChannel) {
    const isInThisChannel = currentVoiceChannelId === currentChannelId;

    if (!isInThisChannel) {
      return (
        <div className="flex-1 flex flex-col bg-surface-base">
          <div className="h-14 px-5 flex items-center justify-between border-b border-border-hard flex-shrink-0 bg-surface-base">
            <div className="flex items-center gap-[10px]">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
                <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" />
              </svg>
              <span className="font-bold text-[15px] tracking-[-0.02em] text-txt-primary">{channel.name}</span>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <TransferIndicator />
              <MemberListToggleButton />
            </div>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center gap-8 relative">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(124,108,246,0.12)_0%,transparent_70%)] animate-gradient-pulse pointer-events-none" />
            <div className="text-center relative z-10">
              <h2 className="text-[28px] font-bold text-white mb-3">{channel.name}</h2>
              <p className="text-txt-tertiary text-[15px]">No one is currently in this voice channel.</p>
            </div>
            <button
              onClick={() => joinVoiceChannel(currentChannelId, useVoiceStore.getState().connectFn ?? undefined)}
              className="relative z-10 px-8 py-3 bg-accent-primary hover:bg-accent-primary-hover text-white font-semibold rounded-full transition-all text-[15px] shadow-[0_4px_20px_rgba(124,108,246,0.3)]"
            >
              Join Voice
            </button>
          </div>
        </div>
      );
    }

    return (
      <div 
        ref={voiceContainerRef}
        className={`flex-1 flex flex-col bg-surface-base min-w-0 group/voice relative ${voiceFullscreen ? 'h-screen' : ''}`}
      >
        <div className={`h-14 px-5 flex items-center justify-between border-b border-border-hard flex-shrink-0 bg-surface-base transition-opacity duration-300 ${voiceFullscreen ? 'opacity-0 hover:opacity-100' : ''}`}>
          <div className="flex items-center gap-[10px]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
              <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" />
            </svg>
            <span className="font-bold text-[15px] tracking-[-0.02em] text-txt-primary">{channel.name}</span>
            {connectionError ? (
              <span className="text-xs text-txt-danger font-medium ml-2">Connection Failed</span>
            ) : isLiveKitConnected ? (
              <>
                <span className="text-xs text-status-online font-medium ml-2">Connected</span>
                <span className="text-xs text-txt-tertiary ml-1">{participants.length} connected</span>
              </>
            ) : (
              <span className="text-xs text-status-idle font-medium ml-2">Connecting...</span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <TransferIndicator />
            <MemberListToggleButton />
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden pb-20">
          <VoiceGrid participants={participants} />
          {voiceChatOpen && !voiceFullscreen && (
            <VoiceChatPanel channelId={currentChannelId} channelName={channel.name} />
          )}
        </div>

        <VoiceControlBar />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-surface-chat min-w-0 relative">
      <div className="h-14 px-5 flex items-center justify-between border-b border-border-hard flex-shrink-0 z-10 bg-surface-chat">
        <div className="flex items-center gap-[10px] min-w-0">
          <span className="text-[20px] font-medium text-txt-tertiary flex-shrink-0 leading-none">#</span>
          <span className="font-bold text-[15px] tracking-[-0.02em] text-txt-primary truncate leading-tight">{channel.name}</span>
          {channel.topic && (
            <>
              <div className="w-[1px] h-5 bg-border-soft mx-2" />
              <span className="text-[13px] text-txt-tertiary truncate leading-tight">{channel.topic}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button className="w-8 h-8 flex items-center justify-center text-txt-tertiary hover:text-txt-primary transition-colors rounded-[6px] hover:bg-interactive-hover" title="Notification Settings">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
            </svg>
          </button>
          <button className="w-8 h-8 flex items-center justify-center text-txt-tertiary hover:text-txt-primary transition-colors rounded-[6px] hover:bg-interactive-hover" title="Pinned Messages">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
            </svg>
          </button>
          <button
            ref={searchButtonRef}
            onClick={() => setSearchOpen(!searchOpen)}
            className={`w-8 h-8 flex items-center justify-center transition-colors rounded-[6px] ${searchOpen ? 'text-txt-primary bg-interactive-active' : 'text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover'}`}
            title="Search"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21.707 20.293l-5.395-5.395A7.457 7.457 0 0018 10.5 7.5 7.5 0 1010.5 18c1.575 0 3.027-.486 4.228-1.31l5.476 5.476a.997.997 0 001.414 0l.089-.089a1 1 0 000-1.414l.001-.37zM10.5 16a5.5 5.5 0 110-11 5.5 5.5 0 010 11z" />
            </svg>
          </button>
          <TransferIndicator />
          <div className="w-[1px] h-5 bg-border-soft mx-1" />
          <MemberListToggleButton />
        </div>
      </div>
      <MessageList channelId={currentChannelId} jumpToMessageId={jumpToMessageId} onJumpComplete={() => setJumpToMessageId(null)} />
      <MessageInput channelId={currentChannelId} channelName={channel.name} />
      <SearchPopover
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        anchorRef={searchButtonRef}
        channelId={currentChannelId}
        isDm={false}
        onJumpToMessage={(id) => { setJumpToMessageId(id); setSearchOpen(false); }}
      />
    </div>
  );
}
