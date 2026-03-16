import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Message } from './Message';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore, isDmChannel } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { Avatar } from '../ui/Avatar';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { isSelf } from '../../utils/identity';
import type { MessageWithUser } from '@backspace/shared';

const EMPTY_MESSAGES: MessageWithUser[] = [];

interface MessageListProps {
  channelId: string;
  jumpToMessageId?: string | null;
  onJumpComplete?: () => void;
}

function isSameGroup(prev: MessageWithUser, curr: MessageWithUser): boolean {
  if (prev.userId !== curr.userId) return false;
  const timeDiff = curr.createdAt - prev.createdAt;
  return timeDiff < 5 * 60 * 1000; // 5 minutes
}

function formatDateDivider(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function shouldShowDateDivider(prev: MessageWithUser | undefined, curr: MessageWithUser): boolean {
  if (!prev) return true;
  const prevDate = new Date(prev.createdAt).toDateString();
  const currDate = new Date(curr.createdAt).toDateString();
  return prevDate !== currDate;
}

export function MessageList({ channelId, jumpToMessageId, onJumpComplete }: MessageListProps) {
  const messages = useChatStore((s) => s.messages.get(channelId)) ?? EMPTY_MESSAGES;
  const loadMessages = useChatStore((s) => s.loadMessages);
  const loadMoreMessages = useChatStore((s) => s.loadMoreMessages);
  const loadMessagesAround = useChatStore((s) => s.loadMessagesAround);
  const isLoading = useChatStore((s) => s.isLoading);
  const hasMore = useChatStore((s) => s.hasMore.get(channelId) ?? true);
  const ackChannel = useChatStore((s) => s.ackChannel);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const prevMessagesLength = useRef(0);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Permission check: DM channels always allow history; space channels check READ_MESSAGE_HISTORY
  const channelPerms = useSpaceStore((s) => s.channelPermissions.get(channelId));
  const isDm = isDmChannel(channelId);
  const canReadHistory = isDm || hasPermissionBit(channelPerms, PermissionBits.READ_MESSAGE_HISTORY);

  useEffect(() => {
    if (canReadHistory) {
      loadMessages(channelId);
    }
  }, [channelId, loadMessages, canReadHistory]);

  // Track the last message ID so the ack re-fires when a temp message is replaced by its server-confirmed ID
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]?.id ?? '' : '';

  // Ack channel when messages load or when new messages arrive while near bottom
  useEffect(() => {
    if (messages.length > 0 && isNearBottom) {
      clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(() => ackChannel(channelId), 200);
    }
    return () => clearTimeout(ackTimerRef.current);
  }, [channelId, messages.length, lastMessageId, isNearBottom, ackChannel]);

  // Reset scroll tracking on channel switch so initial-load scroll fires
  useEffect(() => {
    prevMessagesLength.current = 0;
    setIsNearBottom(true);
    isNearBottomRef.current = true;
  }, [channelId]);

  // Handle scrolling: initial load snaps to bottom, new messages smooth-scroll if near bottom
  useEffect(() => {
    const prev = prevMessagesLength.current;
    prevMessagesLength.current = messages.length;

    if (messages.length === 0) return;

    if (prev === 0) {
      // Initial load / channel switch — snap to bottom
      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      });
    } else if (messages.length > prev && isNearBottom) {
      // New messages arrived while near bottom — smooth scroll
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, isNearBottom]);

  // Auto-scroll when content height grows (embeds/images loading) while near bottom
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const content = contentRef.current;
    const container = containerRef.current;
    if (!content || !container) return;

    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current && containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasMessages, channelId]);

  // Jump-to-message: scroll to target and highlight
  useEffect(() => {
    if (!jumpToMessageId) return;

    const scrollToMessage = () => {
      const el = document.getElementById(`msg-${jumpToMessageId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('search-highlight');
        setTimeout(() => el.classList.remove('search-highlight'), 2000);
        onJumpComplete?.();
        return true;
      }
      return false;
    };

    // Check if the message is already in the cache
    if (scrollToMessage()) return;

    // Not in cache — load messages around the target
    loadMessagesAround(channelId, jumpToMessageId).then(() => {
      // Wait for React to render the new messages
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToMessage();
        });
      });
    });
  }, [jumpToMessageId, channelId, loadMessagesAround, onJumpComplete]);

  const handleScroll = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    // Check if near bottom
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distanceFromBottom < 100;
    setIsNearBottom(nearBottom);
    isNearBottomRef.current = nearBottom;

    // Load more when scrolled to top
    if (container.scrollTop < 50 && hasMore && !isLoadingMore) {
      setIsLoadingMore(true);
      const prevScrollHeight = container.scrollHeight;
      const loaded = await loadMoreMessages(channelId);
      if (loaded) {
        // Maintain scroll position
        requestAnimationFrame(() => {
          container.scrollTop = container.scrollHeight - prevScrollHeight;
        });
      }
      setIsLoadingMore(false);
    }
  }, [channelId, hasMore, isLoadingMore, loadMoreMessages]);

  if (!canReadHistory) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-txt-tertiary text-[14px]">You do not have permission to view message history in this channel</span>
      </div>
    );
  }

  if (isLoading && messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar"
      onScroll={handleScroll}
    >
      {isLoadingMore && (
        <div className="py-4">
          <LoadingSpinner size={24} />
        </div>
      )}

      {!hasMore && <WelcomeHeader channelId={channelId} />}

      <div ref={contentRef} className="pt-4 pb-6 md:pb-20">
        {messages.map((msg, i) => {
          const prevMsg = messages[i - 1];
          const showDate = shouldShowDateDivider(prevMsg, msg);
          const isFirstInGroup = !prevMsg || showDate || !isSameGroup(prevMsg, msg);

          return (
            <React.Fragment key={msg.id}>
              {showDate && (
                <div className="flex items-center px-5 my-2 select-none pointer-events-none">
                  <div className="flex-1 h-[1px] bg-border-hard" />
                  <span className="px-[14px] text-[11px] font-bold text-txt-tertiary leading-tight">
                    {formatDateDivider(msg.createdAt)}
                  </span>
                  <div className="flex-1 h-[1px] bg-border-hard" />
                </div>
              )}
              <Message
                message={msg}
                isCompact={!isFirstInGroup}
                isFirstInGroup={isFirstInGroup}
              />
            </React.Fragment>
          );
        })}
      </div>

      <div ref={bottomRef} />
    </div>
  );
}

function WelcomeHeader({ channelId }: { channelId: string }) {
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const authUser = useAuthStore((s) => s.user);
  const removeFriend = useSocialStore((s) => s.removeFriend);
  const friends = useSocialStore((s) => s.friends);
  const isDm = isDmChannel(channelId);

  if (isDm) {
    const dm = dmChannels.find(d => d.id === channelId);
    const otherUser = dm?.members.find(m => !isSelf(m, authUser));
    const displayName = otherUser?.displayName ?? otherUser?.username ?? 'Unknown';
    const username = otherUser?.username ?? 'unknown';
    const isFriend = otherUser ? friends.some(f => f.id === otherUser.id) : false;

    return (
      <div className="px-4 pt-8 pb-4">
        <div className="mb-2">
          <Avatar src={otherUser?.avatar} name={displayName} size={80} user={otherUser ?? undefined} />
        </div>
        <h3 className="text-[32px] leading-10 font-bold text-txt-primary">{displayName}</h3>
        <p className="text-txt-secondary text-[14px] mt-1">
          This is the beginning of your direct message history with <strong>@{username}</strong>.
        </p>
        {isFriend && otherUser && (
          <div className="mt-4">
            <button
              onClick={() => removeFriend(otherUser.id)}
              className="px-4 py-1.5 bg-surface-elevated hover:bg-surface-elevated text-[14px] font-medium text-txt-primary rounded-[3px] transition-colors"
            >
              Remove Friend
            </button>
          </div>
        )}
        <div className="mt-6 border-b border-interactive-muted" />
      </div>
    );
  }

  return (
    <div className="px-4 pt-8 pb-4">
      <div className="w-[68px] h-[68px] rounded-full bg-surface-elevated flex items-center justify-center mb-4 text-white">
        <svg width="42" height="42" viewBox="0 0 24 24" fill="currentColor">
          <path d="M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z" />
        </svg>
      </div>
      <h3 className="text-[32px] leading-10 font-bold text-txt-primary">Welcome to the channel!</h3>
      <p className="text-txt-secondary text-[16px] mt-2">This is the start of the conversation.</p>
      <div className="mt-6 border-b border-interactive-muted" />
    </div>
  );
}
