import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { ServerSidebar } from './ServerSidebar';
import { ChannelSidebar } from './ChannelSidebar';
import { MainContent } from './MainContent';
import { RightPanel } from './RightPanel';
import { MobileNav } from './MobileNav';
import { ImagePreview } from '../chat/ImagePreview';
import { CreateServerModal } from '../modals/CreateServer';
import { JoinServerModal } from '../modals/JoinServer';
import { CreateChannelModal } from '../modals/CreateChannel';
import { InviteModal } from '../modals/InviteModal';
import { UserSettingsModal } from '../modals/UserSettings';
import { ServerSettingsModal } from '../modals/ServerSettings';
import { ChannelSettingsModal } from '../modals/ChannelSettingsModal';
import { NewDmModal } from '../modals/NewDmModal';
import { AddDmMemberModal } from '../modals/AddDmMemberModal';
import { IncomingCallModal } from '../voice/IncomingCallModal';
import { PictureInPicture } from '../voice/PictureInPicture';
import { SoundController } from '../voice/SoundController';
import { GlobalAudioRenderer } from '../voice/GlobalAudioRenderer';
import { UserProfilePopout } from '../ui/UserProfilePopout';
import { useAuth } from '../../hooks/useAuth';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useLiveKit } from '../../hooks/useLiveKit';
import { useServerStore } from '../../stores/serverStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { AudioManager } from '../../audio/AudioManager';

export function AppLayout() {
  const { serverId, channelId, inviteCode } = useParams<{ serverId?: string; channelId?: string; inviteCode?: string }>();
  
  // Global interaction handler to resume AudioContext
  useEffect(() => {
    const resume = () => {
      AudioManager.getInstance().resumeContext().then(() => {
        window.removeEventListener('click', resume);
        window.removeEventListener('keydown', resume);
        window.removeEventListener('touchstart', resume);
      });
    };
    window.addEventListener('click', resume);
    window.addEventListener('keydown', resume);
    window.addEventListener('touchstart', resume);
    return () => {
      window.removeEventListener('click', resume);
      window.removeEventListener('keydown', resume);
      window.removeEventListener('touchstart', resume);
    };
  }, []);

  // MutationObserver: neutralize rogue LiveKit <audio> elements that bypass our Web Audio pipeline.
  // LiveKit can re-attach hidden <audio> elements after .detach(), causing full-volume playback
  // that ignores our volume/mute controls. Any <audio> without data-backspace is immediately killed.
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLAudioElement && !node.dataset.backspace) {
            node.muted = true;
            node.volume = 0;
            node.pause();
            node.srcObject = null;
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Sync persisted output device preference to AudioManager.
  // AudioManager defers setSinkId until the AudioContext is actually created,
  // so this is safe to call before any user interaction.
  const outputDeviceId = useVoiceStore((s) => s.outputDeviceId);
  useEffect(() => {
    AudioManager.getInstance().setOutputDevice(outputDeviceId);
  }, [outputDeviceId]);

  const { user, isLoading } = useAuth();
  const setCurrentServer = useServerStore((s) => s.setCurrentServer);
  const loadServerDetail = useServerStore((s) => s.loadServerDetail);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const setIsMobile = useUIStore((s) => s.setIsMobile);
  const setShowDms = useUIStore((s) => s.setShowDms);
  const openModal = useUIStore((s) => s.openModal);

  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const isMobile = useUIStore((s) => s.isMobile);
  const userProfilePopout = useUIStore((s) => s.userProfilePopout);
  const closeUserProfile = useUIStore((s) => s.closeUserProfile);
  
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const activeDmCall = useVoiceStore((s) => s.activeDmCall);
  const {
    connect: connectVoice,
    disconnect: disconnectVoice,
    isConnected: isVoiceConnected,
    isConnecting: isVoiceConnecting,
    connectedChannelId,
  } = useLiveKit();

  // Initialize WebSocket
  const { isConnected: isWsConnected } = useWebSocket();

  // Track the last channel we attempted to connect to, to prevent effect loops
  const lastAttemptedRef = React.useRef<string | null>(null);

  // Manage voice connection
  useEffect(() => {
    if (isLoading || !user || !isWsConnected) return;

    const manageConnection = async () => {
      // Determine what we SHOULD be connected to
      const targetChannelId = activeDmCall 
        ? `dm-${activeDmCall.dmChannelId}` 
        : currentVoiceChannelId;

      // 1. If we have a target
      if (targetChannelId) {
        // If we're not connected to the RIGHT place, trigger connect.
        // We IGNORE isVoiceConnecting here to allow "interrupting" a connection
        // or switching rooms immediately.
        if (connectedChannelId !== targetChannelId) {
          // Prevent spamming the same connection attempt if React re-renders
          if (lastAttemptedRef.current === targetChannelId && isVoiceConnecting) {
            return;
          }
          
          console.log(`[AppLayout] Switching/Connecting to: ${targetChannelId}`);
          lastAttemptedRef.current = targetChannelId;
          
          if (activeDmCall) {
            await connectVoice(activeDmCall.dmChannelId, true);
          } else {
            await connectVoice(targetChannelId);
          }
        } else {
          // We are connected to the right place. Reset ref.
          lastAttemptedRef.current = null;
        }
        return;
      }

      // 2. No target — ensure disconnected
      if (connectedChannelId !== null || isVoiceConnected || isVoiceConnecting) {
        console.log('[AppLayout] Leaving voice (no target)');
        lastAttemptedRef.current = null;
        await disconnectVoice();
      }
    };

    manageConnection();
  }, [
    currentVoiceChannelId, 
    activeDmCall, 
    connectedChannelId,
    isVoiceConnected, 
    isVoiceConnecting, 
    isWsConnected, 
    isLoading, 
    user, 
    connectVoice,
    disconnectVoice
  ]);

  // Responsive detection
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [setIsMobile]);

  // Handle route params
  useEffect(() => {
    if (serverId === '@me') {
      setShowDms(true);
      setCurrentServer(null);
    } else if (serverId) {
      setShowDms(false);
      setCurrentServer(serverId);
      loadServerDetail(serverId);
    }
  }, [serverId, setCurrentServer, loadServerDetail, setShowDms]);

  useEffect(() => {
    if (inviteCode) {
      openModal('joinServer');
    }
  }, [inviteCode, openModal]);

  useEffect(() => {
    if (channelId) {
      setCurrentChannel(channelId);
      loadMessages(channelId);
    } else {
      setCurrentChannel(null);
    }
  }, [channelId, setCurrentChannel, loadMessages]);

  if (isLoading || !user) {
    return (
      <div className="h-screen flex items-center justify-center bg-discord-bg-primary">
        <div className="text-center">
          <svg className="animate-spin w-10 h-10 text-discord-blurple mx-auto mb-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-discord-text-muted">Loading Backspace...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-discord-bg-tertiary overflow-hidden">
      {/* Server sidebar - always visible on desktop, toggled on mobile */}
      <div className={`${isMobile ? `fixed z-40 h-full transition-transform ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}` : 'flex h-full'}`}>
        <ServerSidebar />
        <ChannelSidebar />
      </div>

      {/* Main content area */}
      <div className="flex-1 flex min-w-0 bg-discord-bg-primary relative">
        <MainContent />
        <RightPanel />
      </div>

      {/* Modals */}
      <CreateServerModal />
      <JoinServerModal />
      <CreateChannelModal />
      <InviteModal />
      <UserSettingsModal />
      <ServerSettingsModal />
      <ChannelSettingsModal />
      <NewDmModal />
      <AddDmMemberModal />
      <IncomingCallModal />
      <ImagePreview />
      <PictureInPicture />
      <SoundController />
      <GlobalAudioRenderer />

      {/* User Profile Popout */}
      {userProfilePopout.user && userProfilePopout.position && (
        <>
          <div 
            className="fixed inset-0 z-[45]" 
            onClick={closeUserProfile}
          />
          <UserProfilePopout 
            user={userProfilePopout.user} 
            onClose={closeUserProfile}
            position={userProfilePopout.position}
          />
        </>
      )}
    </div>
  );
}
