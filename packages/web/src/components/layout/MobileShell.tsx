import React, { useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useLocation } from 'react-router-dom';
import { MobileScreenStack } from './MobileScreenStack';
import { MobileBottomNav } from './MobileBottomNav';
import { useSwipeGesture } from '../../hooks/useSwipeGesture';

import { MobileSpacesScreen } from './MobileSpacesScreen';
import { MobileDmsScreen } from './MobileDmsScreen';
import { MobileYouScreen } from './MobileYouScreen';
import { MobileChatScreen } from './MobileChatScreen';
import { MobileSettingsScreen } from './MobileSettingsScreen';
import { MobileInstancePanel } from './MobileInstancePanel';
import { MobileScreenHeader } from './MobileScreenHeader';
import { MobileVoiceMiniBar } from './MobileVoiceMiniBar';
import { MobileVoiceFullScreen } from './MobileVoiceFullScreen';
import { MemberSidebar } from './MemberSidebar';
import { FriendsPage } from '../chat/FriendsPage';
import { ExplorePage } from '../chat/ExplorePage';
import { UserProfileModal } from '../modals/UserProfileModal';
import { GeneralPanel } from '../modals/instanceSettingsPanels/GeneralPanel';
import { StreamingPanel } from '../modals/instanceSettingsPanels/StreamingPanel';
import { StoragePanel } from '../modals/instanceSettingsPanels/StoragePanel';
import { UsersPanel } from '../modals/instanceSettingsPanels/UsersPanel';

const screenMap: Record<string, (params?: Record<string, string>) => React.ReactNode> = {
  'channel-chat': (params) => <MobileChatScreen params={params} />,
  'friends': () => <FriendsPage mobile />,
  'settings': () => <MobileSettingsScreen />,
  'settings-account': () => <MobileSettingsScreen initialPanel="account" />,
  'settings-voice': () => <MobileSettingsScreen initialPanel="voice" />,
  'settings-privacy': () => <MobileSettingsScreen initialPanel="privacy" />,
  'settings-connections': () => <MobileSettingsScreen initialPanel="connections" />,
  'settings-instance': () => <MobileInstancePanel />,
  'settings-instance-general': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="General" />
      <div className="flex-1 overflow-y-auto p-4"><GeneralPanel /></div>
    </div>
  ),
  'settings-instance-streaming': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Streaming" />
      <div className="flex-1 overflow-y-auto p-4"><StreamingPanel /></div>
    </div>
  ),
  'settings-instance-storage': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Storage" />
      <div className="flex-1 overflow-y-auto p-4"><StoragePanel /></div>
    </div>
  ),
  'settings-instance-users': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Users" />
      <div className="flex-1 overflow-y-auto p-4"><UsersPanel /></div>
    </div>
  ),
  'members': () => <MemberSidebar />,
  'voice-full': () => <MobileVoiceFullScreen />,
  'explore': () => <ExplorePage />,
  'user-profile': (params) => {
    // Open the user profile modal with the userId from params
    if (params?.userId) {
      // Set modalData so UserProfileModal can read it
      useUIStore.getState().openModal('userProfile', { userId: params.userId });
    }
    return <UserProfileModal />;
  },
};

export function MobileShell() {
  const mobileScreen = useUIStore((s) => s.mobileScreen);
  const popMobileScreen = useUIStore((s) => s.popMobileScreen);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const mobileStack = useUIStore((s) => s.mobileStack);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const location = useLocation();

  // Edge swipe back gesture
  useSwipeGesture({
    onSwipeRight: () => {
      if (mobileStack.length > 0) {
        popMobileScreen();
      }
    },
    enabled: mobileStack.length > 0,
  });

  // Reconstruct mobile stack from URL on mount (deep link / refresh support)
  useEffect(() => {
    const path = location.pathname;
    const match = path.match(/^\/channels\/([^/]+)\/([^/]+)$/);
    if (match && mobileStack.length === 0) {
      const spaceId = match[1] ?? '';
      const channelId = match[2] ?? '';
      if (spaceId === '@me') {
        pushMobileScreen('channel-chat', { channelId, spaceId: '@me' });
      } else {
        pushMobileScreen('channel-chat', { channelId, spaceId });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount

  // Sync browser back button with mobile stack
  useEffect(() => {
    const handlePopState = () => {
      if (useUIStore.getState().mobileStack.length > 0) {
        popMobileScreen();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [popMobileScreen]);

  const rootScreens: Record<string, React.ReactNode> = {
    spaces: <MobileSpacesScreen />,
    dms: <MobileDmsScreen />,
    you: <MobileYouScreen />,
  };

  return (
    <div className="flex flex-col" style={{ height: '100dvh' }}>
      <MobileScreenStack
        rootScreen={rootScreens[mobileScreen]}
        screenMap={screenMap}
      />

      {/* Voice mini-bar — shown when in a voice call */}
      {currentVoiceChannelId && <MobileVoiceMiniBar />}

      {/* Bottom nav — MobileBottomNav hides itself when stack is non-empty */}
      <MobileBottomNav />
    </div>
  );
}
