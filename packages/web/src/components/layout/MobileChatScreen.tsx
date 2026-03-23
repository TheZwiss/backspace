import React, { useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageList } from '../chat/MessageList';
import { MessageInput } from '../chat/MessageInput';
import { TypingIndicator } from '../chat/TypingIndicator';

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

  // Resolve channel/DM name
  let channelName = 'Channel';
  if (isDm && channelId) {
    const dm = dmChannels.find(d => d.id === channelId);
    if (dm) {
      const otherMembers = dm.members.filter(m => m.id !== authUser?.id);
      const isGroup = dm.members.length > 2;
      channelName = isGroup
        ? otherMembers.map(m => m.displayName ?? m.username).join(', ')
        : otherMembers[0]?.displayName ?? otherMembers[0]?.username ?? 'Direct Message';
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
        {!isDm && (
          <button
            onClick={() => pushMobileScreen('members')}
            className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
            </svg>
          </button>
        )}
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {channelId && <MessageList channelId={channelId} />}
      </div>

      {/* Typing indicator + Input */}
      {channelId && <TypingIndicator channelId={channelId} />}
      {channelId && <MessageInput channelId={channelId} channelName={channelName} />}
    </div>
  );
}
