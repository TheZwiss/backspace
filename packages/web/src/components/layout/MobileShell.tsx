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
import { TransferIndicator } from './TransferIndicator';
import { MobileVoiceMiniBar } from './MobileVoiceMiniBar';
import { MobileVoiceFullScreen } from './MobileVoiceFullScreen';
import { MobileMembersScreen } from './MobileMembersScreen';
import { FriendsPage } from '../chat/FriendsPage';
import { ExplorePage } from '../chat/ExplorePage';
import { UserProfileModal } from '../modals/UserProfileModal';
import { GeneralPanel } from '../modals/instanceSettingsPanels/GeneralPanel';
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
  const setApprovalCount = useUIStore((s) => s.setFederationApprovalCount);
  return (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Federation" rightActions={<TransferIndicator />} />
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
  'settings-instance': () => <MobileInstancePanel />,
  'settings-instance-general': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="General" rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><GeneralPanel /></div>
    </div>
  ),
  'settings-instance-registration': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Registration" rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><RegistrationPanel /></div>
    </div>
  ),
  'settings-instance-federation': () => <MobileFederationPanelWrapper />,
  'settings-instance-streaming': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Streaming" rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><StreamingPanel /></div>
    </div>
  ),
  'settings-instance-storage': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Storage" rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><StoragePanel /></div>
    </div>
  ),
  'settings-instance-users': () => (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Users" rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto p-4"><UsersPanel /></div>
    </div>
  ),
  'members': (params) => <MobileMembersScreen params={params} />,
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

  // Reconstruct mobile stack from URL on mount AND on subsequent pathname
  // changes (deep link, refresh, programmatic navigate from SpaceInviteCard
  // Join, joinByCode flows, etc.).
  //
  // Subscribes to `location.pathname` only — NOT to `mobileStack`. This is
  // important because pushing an unrelated screen (e.g. settings) must not
  // re-trigger this effect; otherwise we would re-push the channel-chat on
  // top of every newly-pushed screen, since pathname is still `/channels/...`.
  // We read the current stack imperatively via `useUIStore.getState()` for
  // the idempotency guard.
  //
  // Idempotency guard: callers like MobileSpacesScreen call BOTH
  // `pushMobileScreen('channel-chat', …)` AND `navigate('/channels/…')`.
  // The pushMobileScreen call alone doesn't change pathname (history.pushState
  // with no URL preserves it), but the navigate call does — and that pathname
  // change re-runs this effect after the screen is already on top. The guard
  // below catches that case by inspecting the topmost stack entry. We also
  // guard against the popstate path: when the user navigates back, popstate
  // pops both the browser history AND our stack; the resulting pathname change
  // matches the new top entry, so we skip.
  useEffect(() => {
    const path = location.pathname;
    const match = path.match(/^\/channels\/([^/]+)\/([^/]+)$/);
    if (!match) return;
    const spaceId = match[1] ?? '';
    const channelId = match[2] ?? '';
    const normalizedSpaceId = spaceId === '@me' ? '@me' : spaceId;

    // Read current stack imperatively to avoid re-firing on stack changes.
    const currentStack = useUIStore.getState().mobileStack;
    const top = currentStack[currentStack.length - 1];
    if (
      top &&
      top.screen === 'channel-chat' &&
      top.params?.channelId === channelId &&
      top.params?.spaceId === normalizedSpaceId
    ) {
      return;
    }

    // If the stack has channel-chat entries for OTHER channels, we still push
    // — this preserves back-stack semantics for in-app navigation (e.g. tapping
    // a SpaceInviteCard Join button while inside a chat should stack the new
    // channel on top so back returns to the originating chat).
    pushMobileScreen('channel-chat', { channelId, spaceId: normalizedSpaceId });
  }, [location.pathname, pushMobileScreen]);

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
