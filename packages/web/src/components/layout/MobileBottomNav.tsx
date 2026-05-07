import React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useNavigate } from 'react-router-dom';

export function MobileBottomNav() {
  const mobileScreen = useUIStore((s) => s.mobileScreen);
  const mobileStack = useUIStore((s) => s.mobileStack);
  const setMobileTab = useUIStore((s) => s.setMobileTab);
  const navigate = useNavigate();

  // Badge data
  const unreadChannels = useChatStore((s) => s.unreadChannels);
  const voiceChannelIds = useSpaceStore((s) => s.voiceChannelIds);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const readStates = useChatStore((s) => s.readStates);
  const requests = useSocialStore((s) => s.requests);
  const authUser = useAuthStore((s) => s.user);

  // Hide when any screen is pushed (chat, settings, friends, etc.)
  if (mobileStack.length > 0) return null;

  // Compute unread DM count
  const unreadDmCount = dmChannels.filter((dm) => {
    const lastMsgId = dm.lastMessage?.id;
    const readState = readStates.get(dm.id);
    return lastMsgId && (!readState || readState < lastMsgId);
  }).length;

  // Compute whether any space has unread text channels
  const hasUnreadSpaces = Array.from(unreadChannels).some(chId => !voiceChannelIds.has(chId));

  // Pending friend requests — filter for incoming only
  const pendingIncoming = requests.filter(r => r.status === 'pending' && r.fromId !== authUser?.id);

  const handleTab = (tab: 'spaces' | 'dms' | 'you') => {
    setMobileTab(tab);
    if (tab === 'dms') navigate('/channels/@me');
    if (tab === 'spaces') {
      // Prefer `currentSpaceId` (the canonical "currently selected space" —
      // updated by URL routing, the space strip, SpaceInviteCard joins, etc.).
      // Fall back to `lastSelectedSpaceId`, the sticky memory that survives
      // navigating to `/channels/@me`. AppLayout's URL effect clears
      // `currentSpaceId` to null whenever the URL is `@me`; without the
      // sticky memory, returning to Spaces from a DM/Friends/Settings detour
      // would have nothing to anchor to and `MobileSpacesScreen`'s auto-select
      // would fall back to `spaces[0]`.
      const { currentSpaceId, lastSelectedSpaceId } = useSpaceStore.getState();
      const target = currentSpaceId ?? lastSelectedSpaceId;
      if (target) navigate(`/channels/${target}`);
      else navigate('/');
    }
  };

  const tabs = [
    {
      id: 'spaces' as const,
      label: 'Spaces',
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
        </svg>
      ),
      badge: hasUnreadSpaces ? ('dot' as const) : null,
    },
    {
      id: 'dms' as const,
      label: 'DMs',
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
      ),
      badge: unreadDmCount > 0 ? unreadDmCount : null,
    },
    {
      id: 'you' as const,
      label: 'You',
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
        </svg>
      ),
      badge: pendingIncoming.length > 0 ? ('dot' as const) : null,
    },
  ];

  return (
    <nav
      className="glass-bubble flex items-center justify-around shrink-0"
      style={{
        paddingBottom: 'env(safe-area-inset-bottom)',
        height: 'calc(56px + env(safe-area-inset-bottom))',
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => handleTab(tab.id)}
          className={`flex flex-col items-center justify-center gap-0.5 flex-1 py-2 relative transition-colors ${
            mobileScreen === tab.id ? 'text-accent-primary' : 'text-txt-secondary'
          }`}
        >
          <div className="relative">
            {tab.icon}
            {tab.badge === 'dot' && (
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-notification rounded-full" />
            )}
            {typeof tab.badge === 'number' && (
              <span className="absolute -top-1 -right-2 min-w-[16px] h-4 px-1 bg-notification text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {tab.badge > 99 ? '99+' : tab.badge}
              </span>
            )}
          </div>
          <span className="text-[10px] font-medium">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
