import React, { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SpaceSidebar } from './SpaceSidebar';
import { ChannelSidebar } from './ChannelSidebar';
import { MainContent } from './MainContent';
import { RightPanel } from './RightPanel';
import { MobileNav } from './MobileNav';
import { ImagePreview } from '../chat/ImagePreview';
import { CreateSpaceModal } from '../modals/CreateSpace';
import { JoinSpaceModal } from '../modals/JoinSpace';
import { CreateChannelModal } from '../modals/CreateChannel';
import { CreateCategoryModal } from '../modals/CreateCategory';
import { InviteModal } from '../modals/InviteModal';
import { UserSettingsModal } from '../modals/UserSettings';
import { SpaceSettingsModal } from '../modals/SpaceSettings';
import { ChannelSettingsModal } from '../modals/ChannelSettingsModal';
import { NewDmModal } from '../modals/NewDmModal';
import { AddDmMemberModal } from '../modals/AddDmMemberModal';
import { UserProfileModal } from '../modals/UserProfileModal';
import { IncomingCallModal } from '../voice/IncomingCallModal';
import { PictureInPicture } from '../voice/PictureInPicture';
import { SoundController } from '../voice/SoundController';
import { GlobalAudioRenderer } from '../voice/GlobalAudioRenderer';
import { NotificationController } from '../NotificationController';
import { UserProfilePopout } from '../ui/UserProfilePopout';
import { ToastContainer } from '../ui/ToastContainer';
import { UpdateToast } from '../ui/UpdateToast';
import { useAuth } from '../../hooks/useAuth';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useFederationToasts } from '../../hooks/useFederationToasts';
import { useLiveKit } from '../../hooks/useLiveKit';
import { useDeepLinkHandler } from '../../platform/deepLink';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { AudioManager } from '../../audio/AudioManager';

export function AppLayout() {
  const { spaceId, channelId } = useParams<{ spaceId?: string; channelId?: string }>();
  const navigate = useNavigate();
  
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
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const setIsMobile = useUIStore((s) => s.setIsMobile);
  const setShowDms = useUIStore((s) => s.setShowDms);

  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const isMobile = useUIStore((s) => s.isMobile);
  const userProfilePopout = useUIStore((s) => s.userProfilePopout);
  const closeUserProfile = useUIStore((s) => s.closeUserProfile);
  
  const channels = useSpaceStore((s) => s.channels);

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

  // Federation toast notifications for remote instance connection state changes
  useFederationToasts();

  // Deep link handler for Electron (backspace:// protocol)
  useDeepLinkHandler();

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
    if (spaceId === '@me') {
      setShowDms(true);
      setCurrentSpace(null);
    } else if (spaceId) {
      setShowDms(false);
      setCurrentSpace(spaceId);
      loadSpaceDetail(spaceId);
    } else {
      setShowDms(false);
      setCurrentSpace(null);
    }
  }, [spaceId, setCurrentSpace, loadSpaceDetail, setShowDms]);

  useEffect(() => {
    if (channelId) {
      setCurrentChannel(channelId);
      loadMessages(channelId);
      if (spaceId && spaceId !== '@me') {
        useUIStore.getState().setLastChannel(spaceId, channelId);
      }
    } else {
      setCurrentChannel(null);
    }
  }, [channelId, spaceId, setCurrentChannel, loadMessages]);

  // Auto-select last visited (or first) channel when opening a server without a channelId
  useEffect(() => {
    if (!spaceId || spaceId === '@me' || channelId) return;
    if (channels.length === 0) return;

    const firstChannel = channels[0];
    if (!firstChannel) return;

    // Guard: only redirect when channels belong to the target server.
    // `channels` is shared per-view state set by loadSpaceDetail (async).
    // Without this check, stale channels from a previously viewed server
    // would cause a wrong redirect during the fetch window.
    const { channelToSpaceMap } = useSpaceStore.getState();
    if (channelToSpaceMap.get(firstChannel.id) !== spaceId) return;

    const lastId = useUIStore.getState().lastChannelPerSpace[spaceId];
    const target = (lastId && channels.find((c) => c.id === lastId)) || firstChannel;
    if (target) {
      navigate(`/channels/${spaceId}/${target.id}`, { replace: true });
    }
  }, [spaceId, channelId, channels, navigate]);

  // Guard: redirect when URL channelId no longer exists (deleted, permission revoked, etc.)
  useEffect(() => {
    if (!spaceId || spaceId === '@me' || !channelId) return;
    if (channels.length === 0) return;

    const { channelToSpaceMap } = useSpaceStore.getState();
    const firstCh = channels[0];
    if (!firstCh || channelToSpaceMap.get(firstCh.id) !== spaceId) return;

    if (!channels.some(c => c.id === channelId)) {
      navigate(`/channels/${spaceId}`, { replace: true });
    }
  }, [spaceId, channelId, channels, navigate]);

  if (isLoading || !user) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-chat">
        <div className="text-center">
          <svg className="animate-spin w-10 h-10 text-accent-primary mx-auto mb-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-txt-tertiary">Loading Backspace...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col md:grid md:grid-cols-[312px_1fr] md:grid-rows-[minmax(0,1fr)] bg-surface-base overflow-hidden">
      {/* Space sidebar - always visible on desktop, toggled on mobile */}
      <div className={`fixed inset-y-0 left-0 z-40 flex w-[312px] transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} md:static md:z-auto md:w-auto md:transform-none`}>
        <SpaceSidebar />
        <ChannelSidebar />
      </div>

      {/* Main content area */}
      <div className="flex-1 flex min-w-0 min-h-0 bg-surface-chat relative">
        <MainContent />
        <RightPanel />
      </div>

      {/* Modals */}
      <CreateSpaceModal />
      <JoinSpaceModal />
      <CreateChannelModal />
      <CreateCategoryModal />
      <InviteModal />
      <UserSettingsModal />
      <SpaceSettingsModal />
      <ChannelSettingsModal />
      <NewDmModal />
      <AddDmMemberModal />
      <UserProfileModal />
      <IncomingCallModal />
      <ImagePreview />
      <PictureInPicture />
      <SoundController />
      <GlobalAudioRenderer />
      <NotificationController />
      <UpdateToast />

      {/* User Profile Popout */}
      {userProfilePopout.user && userProfilePopout.position && (
        <>
          <div 
            className="fixed inset-0 z-[145]"
            onClick={closeUserProfile}
          />
          <UserProfilePopout 
            user={userProfilePopout.user} 
            onClose={closeUserProfile}
            position={userProfilePopout.position}
          />
        </>
      )}

      {/* Federation toasts */}
      <ToastContainer />
    </div>
  );
}
