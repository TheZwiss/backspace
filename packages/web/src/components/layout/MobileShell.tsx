import React, { useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useLocation } from 'react-router-dom';
import { MobileScreenStack } from './MobileScreenStack';
import { MobileBottomNav } from './MobileBottomNav';

// Screen components — imported as they are created in subsequent tasks.
// Inline placeholders are used until the real components exist.
const PlaceholderScreen = ({ label }: { label: string }) => (
  <div className="flex-1 flex items-center justify-center bg-surface-base text-txt-secondary">
    {label}
  </div>
);

// These will be replaced with real imports as each task is completed:
const MobileSpacesScreen = () => <PlaceholderScreen label="Spaces" />;
const MobileDmsScreen = () => <PlaceholderScreen label="DMs" />;
const MobileYouScreen = () => <PlaceholderScreen label="You" />;
const MobileChatScreen = ({ params: _params }: { params?: Record<string, string> }) => <PlaceholderScreen label="Chat" />;
const MobileSettingsScreen = ({ initialPanel: _p }: { initialPanel?: string }) => <PlaceholderScreen label="Settings" />;
const MobileVoiceMiniBar = () => null;
const MobileVoiceFullScreen = () => <PlaceholderScreen label="Voice" />;

const screenMap: Record<string, (params?: Record<string, string>) => React.ReactNode> = {
  'channel-chat': (params) => <MobileChatScreen params={params} />,
  'friends': () => <PlaceholderScreen label="Friends" />,
  'settings': () => <MobileSettingsScreen />,
  'settings-account': () => <MobileSettingsScreen initialPanel="account" />,
  'settings-voice': () => <MobileSettingsScreen initialPanel="voice" />,
  'settings-privacy': () => <MobileSettingsScreen initialPanel="privacy" />,
  'settings-connections': () => <MobileSettingsScreen initialPanel="connections" />,
  'settings-instance': () => <MobileSettingsScreen initialPanel="instance" />,
  'members': () => <PlaceholderScreen label="Members" />,
  'voice-full': () => <MobileVoiceFullScreen />,
  'explore': () => <PlaceholderScreen label="Explore" />,
  'user-profile': () => <PlaceholderScreen label="Profile" />,
};

export function MobileShell() {
  const mobileScreen = useUIStore((s) => s.mobileScreen);
  const popMobileScreen = useUIStore((s) => s.popMobileScreen);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const mobileStack = useUIStore((s) => s.mobileStack);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const location = useLocation();

  // Reconstruct mobile stack from URL on mount (deep link / refresh support)
  useEffect(() => {
    const path = location.pathname;
    const match = path.match(/^\/channels\/([^/]+)\/([^/]+)$/);
    if (match && mobileStack.length === 0) {
      const [, spaceId, channelId] = match;
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
