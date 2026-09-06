import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useLocation } from 'react-router-dom';
import { useMobileRouteSync } from '../../hooks/useMobileRouteSync';
import { MobileScreenStack } from './MobileScreenStack';
import { MobileBottomNav } from './MobileBottomNav';
import { useSwipeGesture } from '../../hooks/useSwipeGesture';
import { useVisualViewportInset } from '../../hooks/useVisualViewportInset';

import { MobileSpacesScreen } from './MobileSpacesScreen';
import { MobileDmsScreen } from './MobileDmsScreen';
import { MobileYouScreen } from './MobileYouScreen';
import { MobileChatScreen } from './MobileChatScreen';
import { MobileSettingsScreen } from './MobileSettingsScreen';
import { MobileInstancePanel } from './MobileInstancePanel';
import { MobileScreenHeader } from './MobileScreenHeader';
import { TransferIndicator } from './TransferIndicator';
import { MobileVoiceMiniBar } from './MobileVoiceMiniBar';
import { MobileVoiceFullScreen } from './MobileVoiceFullScreen';
import { MobileMembersScreen } from './MobileMembersScreen';
import { MobileGroupDmInfo } from './MobileGroupDmInfo';
import { FriendsPage } from '../chat/FriendsPage';
import { ExplorePage } from '../chat/ExplorePage';
import { UserProfileModal } from '../modals/UserProfileModal';
import { GeneralPanel } from '../modals/instanceSettingsPanels/GeneralPanel';
import { UpdatesPanel } from '../modals/instanceSettingsPanels/UpdatesPanel';
import { RegistrationPanel } from '../modals/instanceSettingsPanels/RegistrationPanel';
import { FederationPanel } from '../modals/instanceSettingsPanels/FederationPanel';
import { StreamingPanel } from '../modals/instanceSettingsPanels/StreamingPanel';
import { StoragePanel } from '../modals/instanceSettingsPanels/StoragePanel';
import { UsersPanel } from '../modals/instanceSettingsPanels/UsersPanel';

/**
 * Wrapper for the Federation sub-panel that forwards FederationPanel's
 * approval-count callback into the shared uiStore slot read by
 * MobileInstancePanel — this keeps the badge live while the admin is inside
 * the panel approving/denying requests.
 */
function MobileFederationPanelWrapper() {
  const { t } = useTranslation('settings');
  const setApprovalCount = useUIStore((s) => s.setFederationApprovalCount);
  return (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={t('instance.tabs.federation')} rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4">
        <FederationPanel onApprovalCountChange={setApprovalCount} />
      </div>
    </div>
  );
}

const screenMap: Record<string, (params?: Record<string, string>) => React.ReactNode> = {
  'channel-chat': (params) => <MobileChatScreen params={params} />,
  'friends': () => <FriendsPage mobile />,
  'settings': () => <MobileSettingsScreen />,
  'settings-account': () => <MobileSettingsScreen initialPanel="account" />,
  'settings-voice': () => <MobileSettingsScreen initialPanel="voice" />,
  'settings-privacy': () => <MobileSettingsScreen initialPanel="privacy" />,
  'settings-connections': () => <MobileSettingsScreen initialPanel="connections" />,
  'settings-keybinds': () => <MobileSettingsScreen initialPanel="keybinds" />,
  'settings-desktop': () => <MobileSettingsScreen initialPanel="desktop" />,
  'settings-instance': () => <MobileInstancePanel />,
  'settings-instance-general': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={i18n.t('settings:instance.tabs.general')} rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><GeneralPanel /></div>
    </div>
  ),
  'settings-instance-registration': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={i18n.t('settings:instance.tabs.registration')} rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><RegistrationPanel /></div>
    </div>
  ),
  'settings-instance-federation': () => <MobileFederationPanelWrapper />,
  'settings-instance-streaming': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={i18n.t('settings:instance.tabs.streaming')} rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><StreamingPanel /></div>
    </div>
  ),
  'settings-instance-storage': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={i18n.t('settings:instance.tabs.storage')} rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><StoragePanel /></div>
    </div>
  ),
  'settings-instance-updates': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={i18n.t('settings:instance.tabs.updates')} rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><UpdatesPanel /></div>
    </div>
  ),
  'settings-instance-users': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title={i18n.t('settings:instance.tabs.users')} rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><UsersPanel /></div>
    </div>
  ),
  'members': (params) => <MobileMembersScreen params={params} />,
  'group-dm-info': (params) => <MobileGroupDmInfo params={params} />,
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

  useMobileRouteSync(location.pathname);

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
    spaces: <MobileSpacesScreen />, // i18n-check: allow-literal (object keys, not JSX text)
    dms: <MobileDmsScreen />, // i18n-check: allow-literal (object keys, not JSX text)
    you: <MobileYouScreen />,
  };

  // Size the shell to the visual viewport when the iOS soft keyboard is open
  // so a `position: absolute; bottom: 0` child (the chat composer) lands on
  // the keyboard's top edge — independent of how reliably the
  // `visualViewport.resize` event fires in standalone PWA mode. When the
  // keyboard is closed we use `100dvh` so the shell extends through the
  // home-indicator safe area as designed. See `useVisualViewportInset` for
  // the iOS-PWA-specific fallback (focusin polling) that updates `height`
  // even when no `resize` event ever lands.
  const { keyboardOpen, height: vvHeight } = useVisualViewportInset();
  const shellHeight = keyboardOpen && vvHeight !== null ? `${vvHeight}px` : 'calc(100*var(--app-dvh))';

  return (
    <div className="flex flex-col" style={{ height: shellHeight }}>
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
