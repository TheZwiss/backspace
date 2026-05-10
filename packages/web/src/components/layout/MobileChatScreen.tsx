import React, { useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageList } from '../chat/MessageList';
import { MessageInput } from '../chat/MessageInput';
import { TransferIndicator } from './TransferIndicator';
import { parseFederatedUsername } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import type { User } from '@backspace/shared';

const FALLBACK_USER = { id: '', username: '', createdAt: 0, isAdmin: false, replicatedInstances: [] } as unknown as User;

interface MobileChatScreenProps {
  params?: Record<string, string>;
}

export function MobileChatScreen({ params }: MobileChatScreenProps) {
  const popMobileScreen = useUIStore((s) => s.popMobileScreen);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);

  const channelId = params?.channelId;
  const spaceId = params?.spaceId;
  const isDm = spaceId === '@me';

  const loadMessages = useChatStore((s) => s.loadMessages);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
  const channels = useSpaceStore((s) => s.channels);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const authUser = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!channelId) return;
    setCurrentChannel(channelId);
    loadMessages(channelId);
  }, [channelId, setCurrentChannel, loadMessages]);

  // Resolve the "main other member" of a 1:1 DM up-front so we can route it
  // through useCanonicalUserView (hook, must run unconditionally). Group DMs
  // don't get the cache treatment in the header — the comma-joined title falls
  // back to per-member parseFederatedUsername normalization, matching the
  // pattern in MobileDmsScreen.
  const dm = isDm && channelId ? dmChannels.find(d => d.id === channelId) : undefined;
  const otherMembers = dm ? dm.members.filter(m => m.id !== authUser?.id) : [];
  const isGroup = !!dm?.ownerId;
  const rawMainOther = !isGroup ? otherMembers[0] : undefined;
  const canonicalMainOther = useCanonicalUserView((rawMainOther as unknown as User) ?? FALLBACK_USER);

  // Resolve channel/DM name
  let channelName = 'Channel';
  if (isDm && dm) {
    if (isGroup) {
      channelName = otherMembers
        .map(m => m.displayName ?? parseFederatedUsername(m.username).baseName)
        .join(', ');
    } else if (rawMainOther) {
      channelName =
        canonicalMainOther.displayName ??
        parseFederatedUsername(canonicalMainOther.username).baseName ??
        'Direct Message';
    } else {
      channelName = 'Direct Message';
    }
  } else if (!isDm && channelId) {
    const ch = channels.find(c => c.id === channelId);
    channelName = ch?.name || 'channel';
  }

  return (
    <div className="flex flex-col h-full bg-surface-chat">
      {/* Header */}
      <header className="h-12 flex items-center gap-2 px-3 border-b border-border-soft bg-surface-base shrink-0">
        <button onClick={popMobileScreen} className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-txt-primary truncate">
            {isDm ? channelName : `# ${channelName}`}
          </h1>
        </div>
        <TransferIndicator />
        {/* Members button — shown for space channels AND group DMs. 1-on-1
            DMs have no roster, so it stays hidden there. Tapping a space-
            channel button pushes the regular `members` screen; tapping a
            group-DM button pushes the new `group-dm-info` screen so the user
            lands on the full info + management surface. */}
        {(!isDm || isGroup) && (
          <button
            onClick={() => {
              if (isDm && isGroup && channelId) {
                pushMobileScreen('group-dm-info', { channelId });
              } else {
                pushMobileScreen('members');
              }
            }}
            className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
            aria-label={isDm && isGroup ? 'Group info' : 'Members'}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
            </svg>
          </button>
        )}
      </header>

      {/* Messages + floating composer.
          Mirrors the desktop pattern in `MainContent.tsx`: a single relative
          flex-1 region holds both `<MessageList>` (filling the area) and
          `<MessageInput>` (floating glass-bubble at the bottom). The bubble
          is `position: absolute` and is positioned from `MessageInput.tsx`
          via the `useVisualViewportInset` hook so it lifts above the iOS
          soft keyboard when one is open and rests above the home-indicator
          safe-area when not. MessageList content carries `pb-20` so the last
          message can scroll fully into view above the bubble.
          TypingIndicator is rendered inside MessageInput itself (anchored
          `absolute bottom-full` to the bubble), so we don't render it here. */}
      <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
        {channelId && <MessageList channelId={channelId} />}
        {channelId && <MessageInput channelId={channelId} channelName={channelName} />}
      </div>
    </div>
  );
}
