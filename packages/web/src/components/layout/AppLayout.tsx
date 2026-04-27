import React, { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SpaceSidebar } from './SpaceSidebar';
import { ChannelSidebar } from './ChannelSidebar';
import { MainContent } from './MainContent';
import { RightPanel } from './RightPanel';
import { MobileShell } from './MobileShell';
import { ImagePreview } from '../chat/ImagePreview';
import { CreateSpaceModal } from '../modals/CreateSpace';
import { JoinSpaceModal } from '../modals/JoinSpace';
import { CreateChannelModal } from '../modals/CreateChannel';
import { CreateCategoryModal } from '../modals/CreateCategory';
import { InviteModal } from '../modals/InviteModal';
import { UserSettingsModal } from '../modals/UserSettings';
import { SpaceSettingsModal } from '../modals/SpaceSettings';
import { ChannelSettingsModal } from '../modals/ChannelSettingsModal';
import { CategorySettingsModal } from '../modals/CategorySettingsModal';
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
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { useAuth } from '../../hooks/useAuth';
import { useDelayedLoading } from '../../hooks/useDelayedLoading';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useFederationToasts } from '../../hooks/useFederationToasts';
import { useLiveKit } from '../../hooks/useLiveKit';
import { useKeybinds } from '../../hooks/useKeybinds';
import { useDeepLinkHandler } from '../../platform/deepLink';
import { initActivityBridge, teardownActivityBridge } from '../../platform/activityBridge';
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

  // Sweep stale persisted device IDs (mic/speaker/camera) on mount and whenever
  // the device list changes (USB plug/unplug, permission unlock, etc.).
  useEffect(() => {
    const prune = useVoiceStore.getState().pruneStaleDevices;
    prune(); // initial sweep
    const handler = () => prune();
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
  }, []);

  const { user, isLoading } = useAuth();
  const showBootSkeleton = useDelayedLoading(isLoading);
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

  const {
    connect: connectVoice,
    disconnect: disconnectVoice,
  } = useLiveKit();

  // Register connect/disconnect refs in voiceStore so click handlers can access them
  // without calling useLiveKit() (which would create duplicate Room instances).
  useEffect(() => {
    useVoiceStore.getState().setConnectFn(connectVoice);
    useVoiceStore.getState().setDisconnectFn(disconnectVoice);
    return () => {
      useVoiceStore.getState().setConnectFn(null);
      useVoiceStore.getState().setDisconnectFn(null);
    };
  }, [connectVoice, disconnectVoice]);

  // Initialize WebSocket
  useWebSocket();

  // Federation toast notifications for remote instance connection state changes
  useFederationToasts();

  // Keybinds handler
  useKeybinds();

  // Deep link handler for Electron (backspace:// protocol)
  useDeepLinkHandler();

  // Electron activity detection bridge (game/app process scanning → activityStore)
  useEffect(() => {
    initActivityBridge();
    return () => teardownActivityBridge();
  }, []);

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

  if (!user || showBootSkeleton) {
    return (
      <div className="h-full flex bg-surface-base" role="status" aria-label="Loading Backspace">
        {/* Space strip */}
        <div className="w-[72px] hidden md:flex flex-col items-center gap-3 pt-4 bg-surface-base flex-shrink-0">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton skeleton-circle w-12 h-12" style={{ animationDelay: `${i * 0.1}s` }} />
          ))}
        </div>

        {/* Sidebar */}
        <div className="w-60 hidden md:flex bg-surface-channel flex-shrink-0 flex-col pt-4 px-2">
          {/* Header bar */}
          <div className="skeleton skeleton-bar w-[60%] h-4 mb-6 ml-2" />
          {/* Channel items */}
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-1.5 mb-0.5" style={{ animationDelay: `${i * 0.08}s` }}>
              <div className="skeleton w-3.5 h-3.5 rounded-sm flex-shrink-0" style={{ animationDelay: `${i * 0.08}s` }} />
              <div className="skeleton skeleton-bar flex-1" style={{ width: `${45 + (i * 11) % 35}%`, animationDelay: `${i * 0.08}s` }} />
            </div>
          ))}
        </div>

        {/* Main chat area */}
        <div className="flex-1 bg-surface-chat flex flex-col">
          {/* Channel header */}
          <div className="h-12 flex items-center px-4 border-b border-white/[0.04]">
            <div className="skeleton skeleton-bar w-32 h-3.5" />
          </div>

          {/* Messages area — bottom-aligned */}
          <div className="flex-1 flex flex-col justify-end px-4 pb-6">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex gap-3 mb-5" style={{ animationDelay: `${i * 0.12}s` }}>
                <div className="skeleton skeleton-circle w-10 h-10 flex-shrink-0" style={{ animationDelay: `${i * 0.12}s` }} />
                <div className="flex-1 space-y-2 pt-1">
                  <div className="skeleton skeleton-bar" style={{ width: `${20 + (i * 7) % 20}%`, animationDelay: `${i * 0.12}s` }} />
                  <div className="skeleton skeleton-bar h-2.5" style={{ width: `${50 + (i * 13) % 40}%`, animationDelay: `${i * 0.12}s` }} />
                  {i % 3 === 0 && (
                    <div className="skeleton skeleton-bar h-2.5" style={{ width: `${30 + (i * 11) % 35}%`, animationDelay: `${i * 0.12}s` }} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Mobile layout ──
  if (isMobile) {
    return (
      <>
        <MobileShell />
        {/* Modals still render globally for both mobile and desktop */}
        <CreateSpaceModal />
        <JoinSpaceModal />
        <CreateChannelModal />
        <CreateCategoryModal />
        <InviteModal />
        {/* UserSettings is a pushed screen on mobile (MobileSettingsScreen), not a modal */}
        <SpaceSettingsModal />
        <ChannelSettingsModal />
        <CategorySettingsModal />
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
        <ToastContainer />
        <ContextMenuRenderer />
      </>
    );
  }

  // ── Desktop layout ──
  return (
    <div className="h-full flex flex-col md:grid md:grid-cols-[312px_1fr] md:grid-rows-[minmax(0,1fr)] bg-surface-base overflow-hidden">
      {/* Space sidebar - always visible on desktop */}
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
      <CategorySettingsModal />
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
      <ContextMenuRenderer />
    </div>
  );
}
