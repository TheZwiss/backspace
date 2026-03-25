import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Message } from './Message';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore, isDmChannel } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { Avatar } from '../ui/Avatar';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { isSelf } from '../../utils/identity';
import { useDelayedLoading } from '../../hooks/useDelayedLoading';
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
  const saveScrollPosition = useChatStore((s) => s.saveScrollPosition);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const showInitialSkeleton = useDelayedLoading(isLoading && messages.length === 0);
  const showPaginationSkeleton = useDelayedLoading(isLoadingMore);
  const prevMessagesLength = useRef(0);
  const prevChannelIdRef = useRef<string>(channelId);
  const visibleMsgIdRef = useRef<string | null>(null);
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

  // Save scroll anchor (tracked by handleScroll) when leaving a channel, then reset tracking
  useEffect(() => {
    const prevId = prevChannelIdRef.current;
    prevChannelIdRef.current = channelId;

    // Save or clear the old channel's scroll position
    if (prevId && prevId !== channelId) {
      if (visibleMsgIdRef.current) {
        // User was scrolled up — save the anchor message
        saveScrollPosition(prevId, visibleMsgIdRef.current);
        visibleMsgIdRef.current = null;
      } else {
        // User was at bottom — clear any stale saved position so we snap to bottom next time
        const pos = useChatStore.getState().scrollPositions;
        if (pos.has(prevId)) {
          const next = new Map(pos);
          next.delete(prevId);
          useChatStore.setState({ scrollPositions: next });
        }
      }
    }

    prevMessagesLength.current = 0;

    // If we have a saved position for the incoming channel, don't mark as near/at-bottom
    // — this prevents the ResizeObserver from snapping to bottom before the restore rAF fires
    const willRestore = useChatStore.getState().scrollPositions.has(channelId);
    setIsNearBottom(!willRestore);
    isNearBottomRef.current = !willRestore;
    setIsAtBottom(!willRestore);
    isAtBottomRef.current = !willRestore;
  }, [channelId, saveScrollPosition]);

  // Handle scrolling: initial load restores position or snaps to bottom,
  // new messages smooth-scroll if near bottom
  useEffect(() => {
    const prev = prevMessagesLength.current;
    prevMessagesLength.current = messages.length;

    if (messages.length === 0) return;

    if (prev === 0) {
      // Initial load / channel switch — restore to saved message anchor or snap to bottom
      const savedMsgId = useChatStore.getState().scrollPositions.get(channelId);
      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container) return;
        if (savedMsgId) {
          const el = document.getElementById(`msg-${savedMsgId}`);
          if (el) {
            el.scrollIntoView({ block: 'start' });
            const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
            const near = dist < 5000;
            setIsNearBottom(near);
            isNearBottomRef.current = near;
            const atBot = dist < 150;
            setIsAtBottom(atBot);
            isAtBottomRef.current = atBot;
            return;
          }
        }
        // No saved anchor or message not in cache — snap to bottom
        container.scrollTop = container.scrollHeight;
        isAtBottomRef.current = true;
        setIsAtBottom(true);
      });
    } else if (messages.length > prev && isAtBottomRef.current) {
      // New messages arrived while at bottom — smooth scroll
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isAtBottomRef read via ref intentionally
  }, [messages.length, channelId]);

  // Auto-scroll when content height grows (embeds/images loading) while near bottom
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const content = contentRef.current;
    const container = containerRef.current;
    if (!content || !container) return;

    const observer = new ResizeObserver(() => {
      const c = containerRef.current;
      if (!c) return;
      // Use a tight threshold (150px) checked at fire time instead of the
      // generous 5000px isNearBottomRef — prevents snapping the user back
      // to bottom during momentum/inertial scrolling on mobile.
      const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
      if (isAtBottomRef.current && dist < 150) {
        c.scrollTop = c.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [hasMessages, channelId]);

  // Scroll to bottom when any image/media inside the message list finishes loading.
  // The `load` event doesn't bubble, but capture-phase listeners on ancestors still fire.
  // This handles the case ResizeObserver misses due to its own layout-loop suppression.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const handleMediaLoad = () => {
      const c = containerRef.current;
      if (!c) return;
      const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
      if (isAtBottomRef.current && dist < 150) {
        c.scrollTop = c.scrollHeight;
      }
    };

    content.addEventListener('load', handleMediaLoad, true);
    return () => content.removeEventListener('load', handleMediaLoad, true);
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

    // Check scroll position relative to bottom
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    // "at bottom" = within 150px — used for auto-scrolling on new messages
    const atBottom = distanceFromBottom < 150;
    setIsAtBottom(atBottom);
    isAtBottomRef.current = atBottom;
    // "near bottom" = within 5000px — used for "Jump to Present" button visibility
    const nearBottom = distanceFromBottom < 5000;
    setIsNearBottom(nearBottom);
    isNearBottomRef.current = nearBottom;

    // Track top-visible message for scroll position persistence
    if (!nearBottom) {
      const containerTop = container.getBoundingClientRect().top;
      const msgEls = container.querySelectorAll('[id^="msg-"]');
      for (const el of msgEls) {
        if (el.getBoundingClientRect().bottom > containerTop) {
          visibleMsgIdRef.current = el.id.replace('msg-', '');
          break;
        }
      }
    } else {
      visibleMsgIdRef.current = null;
    }

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

  if (showInitialSkeleton) {
    return (
      <div className="flex-1 flex flex-col justify-end px-4 pb-6" role="status" aria-label="Loading messages">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="flex gap-3 mb-5" style={{ animationDelay: `${i * 0.15}s` }}>
            <div className="skeleton skeleton-circle w-10 h-10 flex-shrink-0" style={{ animationDelay: `${i * 0.15}s` }} />
            <div className="flex-1 space-y-2 pt-1">
              <div className="skeleton skeleton-bar" style={{ width: `${20 + (i * 7) % 20}%`, animationDelay: `${i * 0.15}s` }} />
              <div className="skeleton skeleton-bar h-2.5" style={{ width: `${50 + (i * 13) % 40}%`, animationDelay: `${i * 0.15}s` }} />
              {i % 2 === 0 && (
                <div className="skeleton skeleton-bar h-2.5" style={{ width: `${30 + (i * 11) % 35}%`, animationDelay: `${i * 0.15}s` }} />
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex-1 relative min-h-0">
      <div
        ref={containerRef}
        className="h-full overflow-y-auto overflow-x-hidden no-scrollbar"
        onScroll={handleScroll}
      >
        {showPaginationSkeleton && (
          <div className="px-4 pt-4" role="status" aria-label="Loading older messages">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex gap-3 mb-5" style={{ animationDelay: `${i * 0.15}s` }}>
                <div className="skeleton skeleton-circle w-10 h-10 flex-shrink-0" style={{ animationDelay: `${i * 0.15}s` }} />
                <div className="flex-1 space-y-2 pt-1">
                  <div className="skeleton skeleton-bar" style={{ width: `${22 + (i * 9) % 18}%`, animationDelay: `${i * 0.15}s` }} />
                  <div className="skeleton skeleton-bar h-2.5" style={{ width: `${55 + (i * 11) % 35}%`, animationDelay: `${i * 0.15}s` }} />
                </div>
              </div>
            ))}
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
                  previousMessageId={messages[i - 1]?.id ?? null}
                />
              </React.Fragment>
            );
          })}
        </div>

        <div ref={bottomRef} />
      </div>

      {!isNearBottom && messages.length > 0 && (
        <button
          onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-[120] glass-bubble px-4 py-2 flex items-center gap-2 rounded-full text-txt-secondary hover:text-txt-primary transition-all animate-fade-in cursor-pointer"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
          </svg>
          <span className="text-[13px] font-medium">Jump to Present</span>
        </button>
      )}
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
