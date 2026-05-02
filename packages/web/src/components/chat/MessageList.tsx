import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Message } from './Message';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore, isDmChannel } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import {
  usePendingMessageStore,
  isPendingMessage,
  type PendingMessageView,
  type PendingAttachmentView,
  type PendingBubble,
} from '../../stores/pendingMessageStore';
import { Avatar } from '../ui/Avatar';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { isSelf, parseFederatedUsername } from '../../utils/identity';
import { useDelayedLoading } from '../../hooks/useDelayedLoading';
import type { MessageWithUser, SpaceInviteSystemPayload } from '@backspace/shared';
import { SpaceInviteCard } from './SpaceInviteCard';

const EMPTY_MESSAGES: MessageWithUser[] = [];
const EMPTY_PENDING_BUBBLES: PendingBubble[] = [];

interface MessageListProps {
  channelId: string;
  jumpToMessageId?: string | null;
  onJumpComplete?: () => void;
}

function isSameGroup(prev: MessageWithUser, curr: MessageWithUser): boolean {
  if (prev.type === 'system' || curr.type === 'system') return false;
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
  const lastProgrammaticBottomScrollRef = useRef<number | null>(null);
  // Smooth-scroll intent tracking. While a smooth scroll is animating toward the bottom,
  // intermediate `handleScroll` measurements would otherwise see a large `distanceFromBottom`
  // and flip `isAtBottomRef` to false — closing the ResizeObserver/load-handler gate so
  // late-loading media (avatars, embeds, images, Spotify thumbs) growing `scrollHeight`
  // mid-animation never triggers a re-pin. The smooth scroll then lands at the originally
  // computed (now stale) target, leaving the user above the true bottom.
  // 'bottom' = animating toward the bottom, suppress at-bottom flip during the window.
  // 'message' = jump-to-message animation, do NOT suppress (the user is legitimately moving away).
  // null = no animation in progress.
  const smoothScrollIntentRef = useRef<'bottom' | 'message' | null>(null);
  const smoothScrollDeadlineRef = useRef(0);
  const smoothScrollFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 5000px = same threshold as `nearBottom`. If the user wheels away mid-animation, their
  // distance jumps well past this, and we let the at-bottom flag flip honestly so the
  // smooth scroll's terminal frames don't fight a deliberate user gesture.
  const SMOOTH_SCROLL_USER_INTENT_THRESHOLD = 5000;
  const SMOOTH_SCROLL_DEADLINE_MS = 800;
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const showInitialSkeleton = useDelayedLoading(isLoading && messages.length === 0);
  const showPaginationSkeleton = useDelayedLoading(isLoadingMore);
  const prevMessagesLength = useRef(0);
  const prevChannelIdRef = useRef<string>(channelId);
  const visibleMsgIdRef = useRef<string | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout>>();
  // Live mirror of the current `channelId` prop. Updated synchronously each render so
  // that async callbacks (notably the `loadMoreMessages` await in `handleScroll` and the
  // `requestAnimationFrame` it schedules) can compare a captured channel against the
  // current channel and bail if the user switched away mid-flight. We don't read the
  // store's `currentChannelId` because it lags one render behind a URL-driven channel
  // switch (it's set in an `AppLayout` effect that fires after MessageList renders with
  // the new prop), which would let the guard mis-fire during that single-frame window.
  const currentChannelIdRef = useRef(channelId);
  currentChannelIdRef.current = channelId;

  // Final defensive pin after a bottom-bound smooth scroll completes.
  // Runs from either the native `scrollend` handler (preferred) or the timeout fallback
  // (browsers without scrollend support). Whichever fires first clears the intent and
  // cancels its counterpart.
  const finalizeBottomSmoothScroll = useCallback(() => {
    if (smoothScrollIntentRef.current !== 'bottom') {
      // Already cleared (e.g. user wheeled away and we let the gate flip honestly,
      // or the scrollend fired for an unrelated user-driven scroll).
      return;
    }
    const container = containerRef.current;
    if (!container) {
      smoothScrollIntentRef.current = null;
      smoothScrollDeadlineRef.current = 0;
      if (smoothScrollFallbackTimerRef.current) {
        clearTimeout(smoothScrollFallbackTimerRef.current);
        smoothScrollFallbackTimerRef.current = null;
      }
      return;
    }
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const userScrolledAway = distanceFromBottom >= SMOOTH_SCROLL_USER_INTENT_THRESHOLD;
    if (!userScrolledAway) {
      container.scrollTop = container.scrollHeight;
      lastProgrammaticBottomScrollRef.current = container.scrollTop;
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      isNearBottomRef.current = true;
      setIsNearBottom(true);
    }
    smoothScrollIntentRef.current = null;
    smoothScrollDeadlineRef.current = 0;
    if (smoothScrollFallbackTimerRef.current) {
      clearTimeout(smoothScrollFallbackTimerRef.current);
      smoothScrollFallbackTimerRef.current = null;
    }
  }, []);

  // Set the smooth-scroll intent and arm the final-pin path. Pick exactly one signal
  // (native scrollend if supported, timeout otherwise) — the scrollend listener itself
  // is registered persistently in a separate effect; here we only arm the timeout fallback
  // when scrollend is unavailable so they don't double-fire.
  const beginSmoothScrollIntent = useCallback((intent: 'bottom' | 'message') => {
    smoothScrollIntentRef.current = intent;
    smoothScrollDeadlineRef.current = performance.now() + SMOOTH_SCROLL_DEADLINE_MS;
    if (smoothScrollFallbackTimerRef.current) {
      clearTimeout(smoothScrollFallbackTimerRef.current);
      smoothScrollFallbackTimerRef.current = null;
    }
    const hasScrollend = typeof window !== 'undefined' && 'onscrollend' in window;
    if (intent === 'bottom' && !hasScrollend) {
      smoothScrollFallbackTimerRef.current = setTimeout(() => {
        smoothScrollFallbackTimerRef.current = null;
        finalizeBottomSmoothScroll();
      }, SMOOTH_SCROLL_DEADLINE_MS);
    }
    // For 'message' intent: there is no defensive final pin (the target is not the bottom),
    // but the intent ref must still be cleared once the animation ends. Use a timeout in all
    // cases for 'message' — the scrollend listener also clears it, whichever fires first.
    if (intent === 'message') {
      smoothScrollFallbackTimerRef.current = setTimeout(() => {
        smoothScrollFallbackTimerRef.current = null;
        if (smoothScrollIntentRef.current === 'message') {
          smoothScrollIntentRef.current = null;
          smoothScrollDeadlineRef.current = 0;
        }
      }, SMOOTH_SCROLL_DEADLINE_MS);
    }
  }, [finalizeBottomSmoothScroll]);

  // Permission check: DM channels always allow history; space channels check READ_MESSAGE_HISTORY
  const channelPerms = useSpaceStore((s) => s.channelPermissions.get(channelId));
  const isDm = isDmChannel(channelId);
  const canReadHistory = isDm || hasPermissionBit(channelPerms, PermissionBits.READ_MESSAGE_HISTORY);

  // Pending bubble interleaving — synthetic MessageWithUser-shaped objects
  // representing optimistic sends. `Message.tsx` (Task 19) branches on the
  // `__pending` sentinel to render upload progress instead of confirmed state.
  // Note: per-byte transfer progress is intentionally NOT subscribed here.
  // Each attachment carries only `__transferId`; Message.tsx subscribes to a
  // single transfer in isolation so progress ticks don't re-render the list.
  const pendingBubbles = usePendingMessageStore((s) => s.bubbles.get(channelId)) ?? EMPTY_PENDING_BUBBLES;
  const currentUser = useAuthStore((s) => s.user);

  // Map for O(1) replyTo lookup when synthesizing pending bubbles. Built once
  // per `messages` change; per-bubble lookup is then constant-time.
  const messagesById = useMemo(() => {
    const m = new Map<string, MessageWithUser>();
    for (const msg of messages) m.set(msg.id, msg);
    return m;
  }, [messages]);

  const interleavedMessages: (MessageWithUser | PendingMessageView)[] = useMemo(() => {
    if (!currentUser || pendingBubbles.length === 0) return messages;
    // Synthesized DM messages keep the chatStore convention of channelId === ''
    // (real DM messages have empty channelId — DM identity lives on dmChannelId).
    const isDm = isDmChannel(channelId);
    const synthChannelId = isDm ? '' : channelId;
    const synthesized: PendingMessageView[] = pendingBubbles.map((b) => {
      const synth: PendingMessageView = {
        id: `pending-${b.clientId}`,
        channelId: synthChannelId,
        userId: currentUser.id,
        content: b.content,
        replyToId: b.replyToId,
        type: 'user',
        editedAt: null,
        createdAt: b.createdAtLocal,
        user: currentUser,
        attachments: b.transferIds.map((tid): PendingAttachmentView => ({
          id: `tx-${tid}`,                         // synthetic — no real attachmentId yet
          messageId: '',
          filename: '',                            // unknown until Message.tsx looks up the transfer
          originalName: '',
          mimetype: 'application/octet-stream',
          size: 0,
          thumbnailFilename: null,
          width: null,
          height: null,
          duration: null,
          createdAt: b.createdAtLocal,
          __transferId: tid,
        })),
        embeds: [],
        reactions: [],
        replyTo: b.replyToId ? messagesById.get(b.replyToId) ?? null : null,
        __pending: b,
        ...(isDm ? { dmChannelId: channelId } : {}),
      };
      return synth;
    });
    return [...messages, ...synthesized].sort((a, b) => a.createdAt - b.createdAt);
  }, [messages, pendingBubbles, messagesById, channelId, currentUser]);

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
    lastProgrammaticBottomScrollRef.current = null;

    // Belt-and-suspenders: clear any in-flight pagination flag from the outgoing channel.
    // `handleScroll`'s try/finally normally clears it when the await resolves, but the
    // captured-channelId guard only silently drops the stale result — if the network
    // hangs and the await never resolves, the new channel would inherit the flag and
    // render a phantom pagination skeleton. Resetting here costs nothing and covers
    // the never-resolves case. Idempotent w.r.t. the finally block.
    setIsLoadingMore(false);

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
        lastProgrammaticBottomScrollRef.current = container.scrollTop;
        isAtBottomRef.current = true;
        setIsAtBottom(true);
      });
    } else if (messages.length > prev && isAtBottomRef.current) {
      // New messages arrived while at bottom — smooth scroll
      beginSmoothScrollIntent('bottom');
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isAtBottomRef read via ref intentionally
  }, [messages.length, channelId, beginSmoothScrollIntent]);

  // Auto-scroll when content height grows (embeds/images loading) while near bottom
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const content = contentRef.current;
    const container = containerRef.current;
    if (!content || !container) return;

    const observer = new ResizeObserver(() => {
      const c = containerRef.current;
      if (!c || !isAtBottomRef.current) return;
      c.scrollTop = c.scrollHeight;
      lastProgrammaticBottomScrollRef.current = c.scrollTop;
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
      if (!c || !isAtBottomRef.current) return;
      c.scrollTop = c.scrollHeight;
      lastProgrammaticBottomScrollRef.current = c.scrollTop;
    };

    content.addEventListener('load', handleMediaLoad, true);
    return () => content.removeEventListener('load', handleMediaLoad, true);
  }, [hasMessages, channelId]);

  // Effect 7 — `scrollend` listener (Chrome 114+, Safari 18+).
  // Fires once per smooth-scroll animation completion. When a 'bottom' intent is in
  // flight, do a final defensive instant pin: layout may have grown between the
  // smooth-scroll command and its terminal frame (lazy-loaded media, late embeds),
  // and the smooth animation will have stopped at the originally computed target.
  // For browsers without scrollend, the timeout fallback armed in
  // `beginSmoothScrollIntent` handles the same final pin.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof window === 'undefined' || !('onscrollend' in window)) return;

    const handleScrollEnd = () => {
      const intent = smoothScrollIntentRef.current;
      if (intent === 'bottom') {
        finalizeBottomSmoothScroll();
      } else if (intent === 'message') {
        // No defensive pin (target is not bottom), but clear the intent so the next
        // bottom-bound smooth scroll's suppression works correctly.
        smoothScrollIntentRef.current = null;
        smoothScrollDeadlineRef.current = 0;
        if (smoothScrollFallbackTimerRef.current) {
          clearTimeout(smoothScrollFallbackTimerRef.current);
          smoothScrollFallbackTimerRef.current = null;
        }
      }
    };

    container.addEventListener('scrollend', handleScrollEnd);
    return () => container.removeEventListener('scrollend', handleScrollEnd);
  }, [hasMessages, channelId, finalizeBottomSmoothScroll]);

  // Cleanup: on channel switch / unmount, clear any in-flight smooth-scroll intent
  // (we don't want a 'bottom' intent armed on the previous channel to suppress the
  // first user scroll on the new channel).
  useEffect(() => {
    return () => {
      smoothScrollIntentRef.current = null;
      smoothScrollDeadlineRef.current = 0;
      if (smoothScrollFallbackTimerRef.current) {
        clearTimeout(smoothScrollFallbackTimerRef.current);
        smoothScrollFallbackTimerRef.current = null;
      }
    };
  }, [channelId]);

  // Jump-to-message: scroll to target and highlight
  useEffect(() => {
    if (!jumpToMessageId) return;

    const scrollToMessage = () => {
      const el = document.getElementById(`msg-${jumpToMessageId}`);
      if (el) {
        beginSmoothScrollIntent('message');
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
  }, [jumpToMessageId, channelId, loadMessagesAround, onJumpComplete, beginSmoothScrollIntent]);

  const handleScroll = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    const sentinelBefore = lastProgrammaticBottomScrollRef.current;
    const sentinelMatch = container.scrollTop === sentinelBefore;

    // Sentinel: if scrollTop equals our last programmatic bottom-scroll value, this event
    // was queued by our own command. Layout may have grown between the command and the
    // event firing, but our intent is "stay at bottom" — do not let a post-growth distance
    // measurement flip the at-bottom flags. Re-pin defensively (content may have grown
    // again) and update the sentinel. See docs/systems/message-list.md (Auto-scroll model).
    if (sentinelMatch) {
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      isNearBottomRef.current = true;
      setIsNearBottom(true);
      container.scrollTop = container.scrollHeight;
      lastProgrammaticBottomScrollRef.current = container.scrollTop;
      visibleMsgIdRef.current = null;
      return;
    }

    // Sentinel mismatch — the user has scrolled (or is scrolling) somewhere we did not
    // command. Invalidate the sentinel so a future user scroll that coincidentally lands on
    // the stale value can't trigger a false match and yank them to bottom.
    lastProgrammaticBottomScrollRef.current = null;

    // Check scroll position relative to bottom
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    // "at bottom" = within 150px — used for auto-scrolling on new messages
    const atBottomMeasured = distanceFromBottom < 150;
    // "near bottom" = within 5000px — used for "Jump to Present" button visibility
    const nearBottom = distanceFromBottom < 5000;

    // Smooth-scroll-to-bottom suppression: while a smooth animation we initiated is
    // animating toward the bottom, intermediate frames report large `distanceFromBottom`.
    // Honoring those would flip `isAtBottomRef` to false and close the
    // ResizeObserver/load-handler gates — preventing any late-loading media (avatars,
    // embeds, attachment images, Spotify thumbs) growing scrollHeight mid-animation
    // from re-pinning. The smooth scroll then lands at the originally computed (now
    // stale) target. Suppress the flip ONLY for 'bottom' intent — 'message' intent
    // (jump-to-message) legitimately moves the user away from bottom, so let the gate
    // flip honestly there. Also let the gate flip if the user has wheeled away well
    // past the near-bottom band (5000px), which signals a deliberate user gesture
    // overriding our animation.
    const intent = smoothScrollIntentRef.current;
    const intentActive = intent === 'bottom' && performance.now() < smoothScrollDeadlineRef.current;
    const userScrolledAway = distanceFromBottom >= SMOOTH_SCROLL_USER_INTENT_THRESHOLD;
    const suppressBottomFlip = intentActive && !userScrolledAway;

    const atBottom = suppressBottomFlip ? true : atBottomMeasured;
    setIsAtBottom(atBottom);
    isAtBottomRef.current = atBottom;
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

    // Load more when scrolled to top.
    // Capture the channelId locally so we can detect a channel switch that races the
    // async load. Two guard points:
    //  1. Before scheduling the rAF — if the user already switched, we have no business
    //     touching scroll on the outgoing channel's (now-unmounted-from-view) container,
    //     and `prevScrollHeight` is meaningless against the new channel's DOM.
    //  2. *Inside* the rAF callback — the rAF runs ~16ms after we schedule it, so the
    //     channel can switch in that window even if it was still current at schedule time.
    // The try/finally guarantees `setIsLoadingMore(false)` runs even if `loadMoreMessages`
    // throws (defense in depth — `chatStore.loadMoreMessages` currently catches and returns
    // false, but we don't want a future refactor to leak the flag). The Effect-3 reset on
    // channel switch is the third safety net for the "await never resolves" case.
    if (container.scrollTop < 50 && hasMore && !isLoadingMore) {
      const requestChannelId = channelId;
      setIsLoadingMore(true);
      const prevScrollHeight = container.scrollHeight;
      try {
        const loaded = await loadMoreMessages(requestChannelId);
        if (!loaded) return;
        // Channel-switch guard #1: skip the rAF entirely if the user moved away during
        // the await. The container ref now points at the new channel's scroller, so
        // applying `scrollHeight - prevScrollHeight` would yank it to a wrong position.
        if (currentChannelIdRef.current !== requestChannelId) return;
        requestAnimationFrame(() => {
          // Channel-switch guard #2: re-check inside the rAF callback. The frame between
          // scheduling and firing (~16ms) is enough time for a click to switch channels,
          // and the same wrong-position outcome would result.
          if (currentChannelIdRef.current !== requestChannelId) return;
          const c = containerRef.current;
          if (!c) return;
          c.scrollTop = c.scrollHeight - prevScrollHeight;
        });
      } finally {
        setIsLoadingMore(false);
      }
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
          {interleavedMessages.map((msg, i) => {
            const prevMsg = interleavedMessages[i - 1];
            const showDate = shouldShowDateDivider(prevMsg, msg);
            const isFirstInGroup = !prevMsg || showDate || !isSameGroup(prevMsg, msg);

            // Walk back to find the nearest non-pending neighbor for "Mark Unread".
            // A `pending-${clientId}` ID would be rejected by the server, so we skip
            // any pending entries when computing the previous-message reference.
            let realPrevId: string | null = null;
            for (let j = i - 1; j >= 0; j--) {
              const candidate = interleavedMessages[j];
              if (candidate && !isPendingMessage(candidate)) {
                realPrevId = candidate.id;
                break;
              }
            }

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
                {msg.type === 'system' ? (
                  <SystemMessage message={msg} />
                ) : (
                  <Message
                    message={msg}
                    isCompact={!isFirstInGroup}
                    isFirstInGroup={isFirstInGroup}
                    previousMessageId={realPrevId}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        <div ref={bottomRef} />
      </div>

      {!isNearBottom && messages.length > 0 && (
        <button
          onClick={() => {
            beginSmoothScrollIntent('bottom');
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
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

function SystemMessage({ message }: { message: MessageWithUser }) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(message.content ?? '{}'); } catch { /* fall through */ }

  const actorName = message.user?.displayName ?? message.user?.username ?? 'Someone';

  if (data.event === 'space_invite') {
    return (
      <div className="px-4 py-1">
        <SpaceInviteCard payload={data as unknown as SpaceInviteSystemPayload} senderName={actorName} />
      </div>
    );
  }

  // Legacy inline-text events
  let text = '';
  let icon = '';
  switch (data.event) {
    case 'member_added':
      icon = '\u2192'; // →
      text = `${actorName} added ${data.targetDisplayName} to the group`;
      break;
    case 'member_removed':
      if (data.reason === 'leave') {
        icon = '\u2190'; // ←
        text = `${data.targetDisplayName} left the group`;
      } else {
        icon = '\u2190';
        text = `${actorName} removed ${data.targetDisplayName} from the group`;
      }
      break;
    case 'owner_changed':
      icon = '\u265B'; // ♛
      text = `${data.newOwnerDisplayName} is now the group owner`;
      break;
    default:
      text = message.content ?? '';
  }

  return (
    <div className="flex items-center justify-center py-1 px-4 select-none">
      <span className="text-xs text-txt-tertiary">
        <span className="mr-1.5">{icon}</span>
        {text}
      </span>
    </div>
  );
}

function WelcomeHeader({ channelId }: { channelId: string }) {
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const authUser = useAuthStore((s) => s.user);
  const removeFriend = useSocialStore((s) => s.removeFriend);
  const friends = useSocialStore((s) => s.friends);
  const isDm = isDmChannel(channelId);
  const navigate = useNavigate();

  if (isDm) {
    const dm = dmChannels.find(d => d.id === channelId);
    if (!dm) return null; // DM data not yet loaded (WebSocket ready pending)
    const otherMembers = dm.members.filter(m => !isSelf(m, authUser));
    const isGroupDm = !!dm.ownerId;

    if (isGroupDm) {
      const groupName = otherMembers
        .map(m => m.displayName ?? (m.username?.includes('@') ? m.username.split('@')[0] : m.username))
        .join(', ');
      const ownerMember = dm.members.find(m => m.id === dm.ownerId);
      const ownerName = ownerMember?.displayName ?? ownerMember?.username ?? 'Unknown';
      const hasFederated = dm.members.some(m => m.homeInstance);

      const handleLeaveGroup = async () => {
        try {
          await api.dm.leave(channelId);
          navigate('/channels/@me');
        } catch (err) {
          console.error('Failed to leave group:', err);
        }
      };

      return (
        <div className="px-4 pt-8 pb-4">
          <div className="mb-2 relative" style={{ width: 80, height: 80 }}>
            {otherMembers.slice(0, 2).map((m, idx) => (
              <div
                key={m.id}
                className="absolute rounded-full overflow-hidden border-2 border-surface-chat"
                style={{
                  width: 56,
                  height: 56,
                  left: idx * 28,
                  top: idx * 12,
                  zIndex: 2 - idx,
                }}
              >
                <Avatar src={m.avatar} name={m.displayName ?? m.username ?? ''} size={56} user={m} />
              </div>
            ))}
          </div>
          <h3 className="text-[32px] leading-10 font-bold text-txt-primary mt-2">{groupName}</h3>
          <p className="text-txt-secondary text-[14px] mt-1">
            This is the beginning of your group conversation.
          </p>
          <p className="text-xs text-txt-tertiary mt-1">
            Group created by <strong>@{ownerName}</strong>
          </p>
          {hasFederated && (
            <p className="text-xs text-txt-tertiary mt-1">
              Messages are stored on your and your recipients' home instances. They are not end-to-end encrypted.
            </p>
          )}
          <div className="mt-4">
            <button
              onClick={handleLeaveGroup}
              className="px-4 py-1.5 bg-surface-elevated hover:bg-surface-elevated text-[14px] font-medium text-txt-primary rounded-[3px] transition-colors"
            >
              Leave Group
            </button>
          </div>
          <div className="mt-6 border-b border-interactive-muted" />
        </div>
      );
    }

    // 1-on-1 DM welcome header
    const otherUser = otherMembers[0];
    const { baseName } = parseFederatedUsername(otherUser?.username ?? '');
    const displayName = otherUser?.displayName ?? (baseName || 'Direct Message');
    const mentionName = otherUser?.displayName ?? baseName;
    const isFriend = otherUser ? friends.some(f => f.id === otherUser.id) : false;

    return (
      <div className="px-4 pt-8 pb-4">
        <div className="mb-2">
          <Avatar src={otherUser?.avatar} name={displayName} size={80} user={otherUser ?? undefined} />
        </div>
        <h3 className="text-[32px] leading-10 font-bold text-txt-primary">{displayName}</h3>
        <p className="text-txt-secondary text-[14px] mt-1">
          This is the beginning of your direct message history with <strong>@{mentionName}</strong>.
        </p>
        {otherUser?.homeInstance && (
          <p className="text-xs text-txt-tertiary mt-1">
            Messages are stored on your and your recipient's home instances. They are not end-to-end encrypted.
          </p>
        )}
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
