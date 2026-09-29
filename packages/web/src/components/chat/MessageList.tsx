import React, { useEffect, useLayoutEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatters } from '../../i18n/formatters';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Message } from './Message';
import { useChatStore, type LoadAroundResult } from '../../stores/chatStore';
import { useSpaceStore, useIsDmChannel } from '../../stores/spaceStore';
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
import { ProfileAvatar } from '../ui/ProfileAvatar';
import { AvatarStack } from '../ui/AvatarStack';
import { useUIStore } from '../../stores/uiStore';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { isSelf, parseFederatedUsername } from '../../utils/identity';
import { formatDmHeaderName } from '../../utils/dmFormatters';
import { useDelayedLoading } from '../../hooks/useDelayedLoading';
import type { MessageWithUser } from '@backspace/shared';
import { SystemMessage } from './SystemMessage';
import { MessageJumpContext } from './messageJumpContext';
import {
  BOTTOM_ANCHOR,
  firstUnreadMessageId,
  pageReachesReadPosition,
  resolveOpenTarget,
  type OpenTarget,
  type ScrollAnchor,
} from './scrollAnchor';
import { layoutPixels } from '../../platform/interfaceScale';

const EMPTY_MESSAGES: MessageWithUser[] = [];
const EMPTY_PENDING_BUBBLES: PendingBubble[] = [];

// Constant-height slot rendered above messages whenever hasMore === true.
// Value derived from the pagination skeleton's analytical rendered height
// (pt-4 + 3 × (h-10 row) + 2 × mb-5 = 176px after stripping the last row's
// mb-5), rounded UP to the nearest 4-pixel step for a buffer. See
// docs/systems/message-list.md "Top-of-list reservation slot".
const PAGINATION_SLOT_HEIGHT_PX = 200;

// Class that flashes the row a jump landed on (search result or reply
// preview). Defined in globals.css with the `message-jump-flash` keyframes.
const JUMP_HIGHLIGHT_CLASS = 'message-jump-highlight';
const JUMP_HIGHLIGHT_ANIMATION = 'message-jump-flash';

// The auto-scroll model's thresholds (see handleScroll): within AT_BOTTOM the
// list follows new messages, within NEAR_BOTTOM Jump to Present stays hidden.
const AT_BOTTOM_THRESHOLD_PX = 150;
const NEAR_BOTTOM_THRESHOLD_PX = 5000;

function isMessageLoaded(channelId: string, messageId: string): boolean {
  return (useChatStore.getState().messages.get(channelId) ?? []).some((m) => m.id === messageId);
}

/**
 * The scrollTop a `scrollIntoView({ block: 'center' })` of `el` lands on:
 * the row centred in the container, clamped to the scrollable range.
 */
function centredScrollTop(container: HTMLElement, el: HTMLElement): number {
  const height = layoutPixels(el.getBoundingClientRect().height);
  const unclamped = container.scrollTop + rowOffset(container, el) - (container.clientHeight - height) / 2;
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.min(max, Math.max(0, unclamped));
}

// Where a channel opened at its first unread message holds that row: far
// enough below the viewport top that the unread divider above it shows.
const UNREAD_ROW_OFFSET_PX = 64;

// A row's height before it is laid out, for anchoring a jump target that is
// still loading. The anchor is re-measured once the row renders.
const ROW_HEIGHT_ESTIMATE_PX = 40;

/** Rows with a server id; optimistic sends (`pending-…`, `temp_…`) are not anchors. */
const ANCHORABLE_ROW = /^msg-\d+$/;

function findRow(container: HTMLElement, messageId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[id="msg-${messageId}"]`);
}

/** Distance in layout pixels from the scroll viewport's top edge to the row's top edge. */
function rowOffset(container: HTMLElement, row: HTMLElement): number {
  return layoutPixels(row.getBoundingClientRect().top - container.getBoundingClientRect().top);
}

/** The first row with a server id whose bottom edge is below the viewport's top edge. */
function topmostVisibleRow(container: HTMLElement): HTMLElement | null {
  const top = container.getBoundingClientRect().top;
  for (const row of container.querySelectorAll<HTMLElement>('[id^="msg-"]')) {
    if (!ANCHORABLE_ROW.test(row.id)) continue;
    if (row.getBoundingClientRect().bottom > top) return row;
  }
  return null;
}

/** True when `id` falls between the oldest and newest server ids in `ids`. */
function idWithinRows(id: string, ids: readonly string[]): boolean {
  if (!/^\d+$/.test(id)) return false;
  const target = BigInt(id);
  let min: bigint | null = null;
  let max: bigint | null = null;
  for (const rowId of ids) {
    if (!/^\d+$/.test(rowId)) continue;
    const value = BigInt(rowId);
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
  }
  return min !== null && max !== null && target >= min && target <= max;
}

function sharesAnyId(previous: readonly string[], next: readonly string[]): boolean {
  if (previous.length === 0) return false;
  const seen = new Set(previous);
  return next.some((id) => seen.has(id));
}

interface MessageListProps {
  channelId: string;
  /** A jump requested from outside the list (search). Taken once, then `onJumpHandled` fires. */
  jumpToMessageId?: string | null;
  onJumpHandled?: () => void;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Restartable background flash on the row a jump landed on. */
function flashMessage(el: HTMLElement): void {
  el.classList.remove(JUMP_HIGHLIGHT_CLASS);
  // Force a style flush so a second jump to the same row restarts the animation.
  void el.offsetWidth;
  el.classList.add(JUMP_HIGHLIGHT_CLASS);
  const onEnd = (e: AnimationEvent) => {
    // animationend bubbles from the row's children (skeletons, typing dots);
    // only the flash's own end removes the class.
    if (e.target !== el || e.animationName !== JUMP_HIGHLIGHT_ANIMATION) return;
    el.classList.remove(JUMP_HIGHLIGHT_CLASS);
    el.removeEventListener('animationend', onEnd);
  };
  el.addEventListener('animationend', onEnd);
}

/**
 * Keyboard focus follows a jump to the row it landed on, so the next Tab
 * continues from there rather than from a control that may now be off screen.
 * The row is a tab stop only while it holds that focus. `preventScroll`: the
 * smooth scroll is already under way.
 */
function focusJumpTarget(el: HTMLElement): void {
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1');
    el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
  }
  el.focus({ preventScroll: true });
}

function isSameGroup(prev: MessageWithUser, curr: MessageWithUser): boolean {
  if (prev.type === 'system' || curr.type === 'system') return false;
  if (prev.userId !== curr.userId) return false;
  const timeDiff = curr.createdAt - prev.createdAt;
  return timeDiff < 5 * 60 * 1000; // 5 minutes
}

function formatDateDivider(timestamp: number): string {
  return formatters.formatFullDate(timestamp);
}

function shouldShowDateDivider(prev: MessageWithUser | undefined, curr: MessageWithUser): boolean {
  if (!prev) return true;
  const prevDate = new Date(prev.createdAt).toDateString();
  const currDate = new Date(curr.createdAt).toDateString();
  return prevDate !== currDate;
}

export function MessageList({ channelId, jumpToMessageId, onJumpHandled }: MessageListProps) {
  const { t } = useTranslation(['chat', 'common']);
  const messages = useChatStore((s) => s.messages.get(channelId)) ?? EMPTY_MESSAGES;
  const loadMessages = useChatStore((s) => s.loadMessages);
  const loadMoreMessages = useChatStore((s) => s.loadMoreMessages);
  const loadMessagesAround = useChatStore((s) => s.loadMessagesAround);
  const isDetached = useChatStore((s) => s.detachedChannels.has(channelId));
  const addToast = useUIStore((s) => s.addToast);
  const loadState = useChatStore((s) => s.loadStates.get(channelId));
  const isLoading = loadState?.status === 'loading';
  const hasMore = useChatStore((s) => s.hasMore.get(channelId) ?? true);
  const ackChannel = useChatStore((s) => s.ackChannel);
  const saveScrollPosition = useChatStore((s) => s.saveScrollPosition);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);

  // ─── Anchoring model ─────────────────────────────────────────────────────
  // One anchor says what the view is held to: the bottom, or a row at an
  // offset from the viewport top. Opening, remounting, a cache replaced under
  // the open view, jumps, Jump to Present and every size change go through it.
  // See docs/systems/message-list.md, "Anchoring model".
  const anchorRef = useRef<ScrollAnchor>(BOTTOM_ANCHOR);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // The offset and scroll geometry the list last set or measured. A scroll
  // event at that offset with that geometry is the list's own; one after the
  // geometry changed was caused by layout, not by the user.
  const appliedScrollTopRef = useRef<number | null>(null);
  const appliedGeometryRef = useRef<{ scrollHeight: number; clientHeight: number } | null>(null);
  // The channel whose open target has been taken. Until then nothing derives
  // or applies an anchor: the list has no rows to hold.
  const openedChannelRef = useRef<string | null>(null);
  const openTargetRef = useRef<OpenTarget>(BOTTOM_ANCHOR);
  // A load that will bring the anchored row (jump, restore) is in flight.
  const anchorLoadInFlightRef = useRef(false);
  // The rows the last render held, to tell a replaced cache from an edit.
  const renderedIdsRef = useRef<{ channelId: string; ids: string[] }>({ channelId, ids: [] });
  // The first unread message when the channel opened, shown with a divider
  // above it for the rest of the visit (a snapshot: acking does not move it).
  const [unreadMarker, setUnreadMarker] = useState<{ channelId: string; messageId: string } | null>(null);

  // Smooth-scroll intent tracking. While a smooth scroll is animating toward the bottom,
  // intermediate `handleScroll` measurements would otherwise see a large distance from
  // the bottom and move the anchor off it. The smooth scroll would then land at its
  // originally computed (now stale) target while media loaded underneath.
  // 'bottom' = animating toward the bottom, the anchor stays at the bottom meanwhile.
  // 'message' = jump-to-message animation; nothing re-applies the anchor until it lands.
  // null = no animation in progress.
  const smoothScrollIntentRef = useRef<'bottom' | 'message' | null>(null);
  const smoothScrollDeadlineRef = useRef(0);
  const smoothScrollFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 5000px = same threshold as `nearBottom`. If the user wheels away mid-animation, their
  // distance jumps well past this, and we let the anchor move honestly so the
  // smooth scroll's terminal frames don't fight a deliberate user gesture.
  const SMOOTH_SCROLL_USER_INTENT_THRESHOLD = 5000;
  const SMOOTH_SCROLL_DEADLINE_MS = 800;
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const showInitialSkeleton = useDelayedLoading(isLoading && messages.length === 0);
  // 50 ms threshold (vs the 200 ms default on showInitialSkeleton above) is
  // safe here because the constant-height slot eliminated the layout
  // shift the 200 ms originally hid. 50 ms is below the ~100 ms visual
  // perception threshold so near-instant cache hits still complete without
  // ever rendering the skeleton, while slow loads see the skeleton appear
  // before the user's eye can register the slot as empty.
  const showPaginationSkeleton = useDelayedLoading(isLoadingMore, { threshold: 50 });
  const prevChannelIdRef = useRef<string>(channelId);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout>>();
  // Live mirror of the current `channelId` prop. Updated synchronously each render so
  // that async callbacks (the `loadMoreMessages` await in `handleScroll`, the jump and
  // restore loads) can compare a captured channel against the current channel and bail
  // if the user switched away mid-flight. We don't read the store's `currentChannelId`
  // because it lags one render behind a URL-driven channel switch (it's set in an
  // `AppLayout` effect that fires after MessageList renders with the new prop).
  const currentChannelIdRef = useRef(channelId);
  currentChannelIdRef.current = channelId;
  // Suppress the first scroll event after a channel switch from triggering
  // pagination. When the new channel's content is shorter than the outgoing
  // channel's, the browser clamps `scrollTop` to its new max and dispatches a
  // synthetic scroll event. That event lands in `handleScroll` near the top,
  // and for any channel where `hasMore` is `true` (default for unvisited
  // channels per the `?? true` fallback at the `hasMore` selector) it would
  // fire `loadMoreMessages` even though the user never scrolled. The flag is
  // armed on every channel change and consumed by the load-more block on the
  // next scroll event. A 250 ms setTimeout disarms it as a fallback in case no
  // clamp event fires, so a real user scroll-to-top shortly after a channel
  // switch isn't permanently suppressed.
  const suppressNextLoadMoreRef = useRef(false);
  const suppressNextLoadMoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (suppressNextLoadMoreTimerRef.current) {
      clearTimeout(suppressNextLoadMoreTimerRef.current);
      suppressNextLoadMoreTimerRef.current = null;
    }
  }, []);

  // Monotonic id of the latest request that moves the view on purpose (a
  // jump, Jump to Present, restoring a reading position). An older request
  // still awaiting its load compares against it and gives up, so the newest
  // one wins.
  const jumpSeqRef = useRef(0);

  const setAnchor = useCallback((anchor: ScrollAnchor) => {
    anchorRef.current = anchor;
    setIsAtBottom(anchor.kind === 'bottom');
  }, []);

  const recordGeometry = useCallback((container: HTMLElement) => {
    appliedGeometryRef.current = { scrollHeight: container.scrollHeight, clientHeight: container.clientHeight };
    const near = container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
    setIsNearBottom(near);
  }, []);

  /**
   * Hold the view to its anchor: the bottom, or the anchored row at its
   * offset. Idempotent, and it only writes scrollTop when the view is off
   * its anchor. A jump's smooth scroll is left to land.
   */
  const applyAnchor = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (smoothScrollIntentRef.current === 'message' && performance.now() < smoothScrollDeadlineRef.current) return;
    const anchor = anchorRef.current;
    if (anchor.kind === 'bottom') {
      container.scrollTop = container.scrollHeight;
    } else {
      const row = findRow(container, anchor.messageId);
      if (row) {
        const delta = rowOffset(container, row) - anchor.offsetPx;
        if (Math.abs(delta) >= 1) container.scrollTop = container.scrollTop + delta;
      }
    }
    appliedScrollTopRef.current = container.scrollTop;
    recordGeometry(container);
  }, [recordGeometry]);

  /** The anchor the view is at now: the bottom, or the topmost visible row. */
  const anchorFromLayout = useCallback((container: HTMLElement): ScrollAnchor => {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < AT_BOTTOM_THRESHOLD_PX) return BOTTOM_ANCHOR;
    const row = topmostVisibleRow(container);
    if (!row) return BOTTOM_ANCHOR;
    return { kind: 'message', messageId: row.id.slice(4), offsetPx: rowOffset(container, row) };
  }, []);

  const deriveAnchorFromLayout = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    setAnchor(anchorFromLayout(container));
    appliedScrollTopRef.current = null;
    recordGeometry(container);
  }, [anchorFromLayout, recordGeometry, setAnchor]);

  // Final defensive pin after a bottom-bound smooth scroll completes.
  // Runs from either the native `scrollend` handler (preferred) or the timeout fallback
  // (browsers without scrollend support). Whichever fires first clears the intent and
  // cancels its counterpart.
  const finalizeBottomSmoothScroll = useCallback(() => {
    if (smoothScrollIntentRef.current !== 'bottom') return;
    smoothScrollIntentRef.current = null;
    smoothScrollDeadlineRef.current = 0;
    if (smoothScrollFallbackTimerRef.current) {
      clearTimeout(smoothScrollFallbackTimerRef.current);
      smoothScrollFallbackTimerRef.current = null;
    }
    const container = containerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom >= SMOOTH_SCROLL_USER_INTENT_THRESHOLD) return;
    setAnchor(BOTTOM_ANCHOR);
    applyAnchor();
  }, [applyAnchor, setAnchor]);

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
    // For 'message' intent: there is no final pin (the target is not the bottom), but the
    // intent must still be cleared once the animation ends. Use a timeout in all cases for
    // 'message' — the scrollend listener also clears it, whichever fires first.
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

  // A request that moves the view on purpose cancels everything that pins the
  // list to the bottom: a queued scroll event at the list's own offset would
  // re-apply the old anchor, and a pending bottom-bound smooth scroll would
  // finish at the bottom.
  const cancelBottomPinning = useCallback(() => {
    appliedScrollTopRef.current = null;
    if (smoothScrollIntentRef.current === 'bottom') {
      smoothScrollIntentRef.current = null;
      smoothScrollDeadlineRef.current = 0;
      if (smoothScrollFallbackTimerRef.current) {
        clearTimeout(smoothScrollFallbackTimerRef.current);
        smoothScrollFallbackTimerRef.current = null;
      }
    }
  }, []);

  /**
   * The anchored row is not in the cache: the cache was replaced under the
   * open view (a reconnect refetched the newest page, or Jump to Present
   * loaded it after a newer jump). Load the window around the row and hold
   * it again; if it is gone, keep whatever the view shows now.
   */
  const restoreAnchor = useCallback(async (anchor: Extract<ScrollAnchor, { kind: 'message' }>) => {
    const seq = ++jumpSeqRef.current;
    const requestChannelId = channelId;
    anchorLoadInFlightRef.current = true;
    let result: LoadAroundResult;
    try {
      result = await loadMessagesAround(requestChannelId, anchor.messageId);
    } finally {
      if (jumpSeqRef.current === seq) anchorLoadInFlightRef.current = false;
    }
    if (jumpSeqRef.current !== seq || currentChannelIdRef.current !== requestChannelId) return;
    await nextFrame();
    if (jumpSeqRef.current !== seq || currentChannelIdRef.current !== requestChannelId) return;
    const container = containerRef.current;
    if (result === 'loaded' && container && findRow(container, anchor.messageId)) {
      applyAnchor();
      return;
    }
    deriveAnchorFromLayout();
  }, [channelId, loadMessagesAround, applyAnchor, deriveAnchorFromLayout]);

  // Permission check: DM channels always allow history; space channels check READ_MESSAGE_HISTORY
  const channelPerms = useSpaceStore((s) => s.channelPermissions.get(channelId));
  // Undefined until the ready that lists the channel: not refused, and loadMessages waits for that ready.
  const isDm = useIsDmChannel(channelId);
  const canReadHistory = isDm !== false || hasPermissionBit(channelPerms, PermissionBits.READ_MESSAGE_HISTORY);

  // Channel-specific DM record (if applicable). Passed to SystemMessage so it
  // can resolve actor display names from the channel roster — needed for
  // events that don't embed the actor (name_changed, icon_changed, owner_changed).
  const currentDm = useSpaceStore((s) => isDm ? s.dmChannels.find(d => d.id === channelId) : undefined);

  // Pending bubble interleaving — synthetic MessageWithUser-shaped objects
  // representing optimistic sends. `Message.tsx` branches on the
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
  }, [messages, pendingBubbles, messagesById, channelId, currentUser, isDm]);

  useEffect(() => {
    if (canReadHistory) {
      loadMessages(channelId);
    }
  }, [channelId, loadMessages, canReadHistory]);

  // Track the last message ID so the ack re-fires when a temp message is replaced by its server-confirmed ID
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]?.id ?? '' : '';

  // The channel is read once the view is held at the newest message: the
  // anchor is the bottom and the cache is not a window short of the present.
  useEffect(() => {
    if (messages.length > 0 && isAtBottom && !isDetached) {
      clearTimeout(ackTimerRef.current);
      ackTimerRef.current = setTimeout(() => ackChannel(channelId), 200);
    }
    return () => clearTimeout(ackTimerRef.current);
  }, [channelId, messages.length, lastMessageId, isAtBottom, isDetached, ackChannel]);

  // Channel open and close. Opening picks the target the view will take once
  // the channel's rows are there; closing (a channel switch or an unmount)
  // saves the anchor, so a remount or a later visit comes back to it.
  useLayoutEffect(() => {
    const prevId = prevChannelIdRef.current;
    prevChannelIdRef.current = channelId;

    openedChannelRef.current = null;
    appliedScrollTopRef.current = null;
    appliedGeometryRef.current = null;
    anchorLoadInFlightRef.current = false;
    jumpSeqRef.current += 1;
    const { scrollPositions, readStates } = useChatStore.getState();
    openTargetRef.current = resolveOpenTarget(scrollPositions.get(channelId), readStates.get(channelId));
    setUnreadMarker(null);
    // Nothing reads the anchor before the channel opens; the open sets it.
    anchorRef.current = BOTTOM_ANCHOR;
    const opensAtBottom = openTargetRef.current.kind === 'bottom';
    setIsAtBottom(opensAtBottom);
    setIsNearBottom(opensAtBottom);

    if (prevId !== channelId) {
      // Belt-and-suspenders: clear any in-flight pagination flag from the outgoing
      // channel. `handleScroll`'s try/finally normally clears it when the await
      // resolves; if the network hangs and it never resolves, the new channel would
      // inherit the flag and render a phantom pagination skeleton.
      setIsLoadingMore(false);
    }

    // Arm the clamp-scroll suppression flag. See `suppressNextLoadMoreRef`.
    suppressNextLoadMoreRef.current = true;
    if (suppressNextLoadMoreTimerRef.current) {
      clearTimeout(suppressNextLoadMoreTimerRef.current);
    }
    suppressNextLoadMoreTimerRef.current = setTimeout(() => {
      suppressNextLoadMoreRef.current = false;
      suppressNextLoadMoreTimerRef.current = null;
    }, 250);

    return () => {
      if (openedChannelRef.current === channelId) {
        saveScrollPosition(channelId, anchorRef.current);
      }
    };
  }, [channelId, saveScrollPosition]);

  const isOwnMessage = useCallback(
    (message: MessageWithUser) => isSelf(message.user, useAuthStore.getState().user),
    [],
  );

  /**
   * Hold the first unread row below the viewport top, with its divider. When
   * everything unread fits on screen the view is at the bottom anyway: hold
   * the bottom, so the list keeps following and the channel is marked read.
   */
  const anchorAtUnread = useCallback((messageId: string) => {
    const container = containerRef.current;
    if (!container) return;
    setUnreadMarker({ channelId, messageId });
    setAnchor({ kind: 'message', messageId, offsetPx: UNREAD_ROW_OFFSET_PX });
    applyAnchor();
    if (container.scrollHeight - container.scrollTop - container.clientHeight < AT_BOTTOM_THRESHOLD_PX) {
      setAnchor(BOTTOM_ANCHOR);
      applyAnchor();
    }
  }, [channelId, setAnchor, applyAnchor]);

  /**
   * The unread messages start before the loaded page: load the window around
   * the read message on the channel's origin and open there. If that message
   * is gone or the load fails, open at the latest message.
   */
  const openAtUnreadWindow = useCallback(async (lastReadId: string) => {
    const seq = ++jumpSeqRef.current;
    const requestChannelId = channelId;
    const isCurrent = () => jumpSeqRef.current === seq && currentChannelIdRef.current === requestChannelId;
    // Hold the read message meanwhile: nothing follows the bottom or acks.
    setAnchor({ kind: 'message', messageId: lastReadId, offsetPx: 0 });
    anchorLoadInFlightRef.current = true;
    let result: LoadAroundResult;
    try {
      result = await loadMessagesAround(requestChannelId, lastReadId);
    } finally {
      if (jumpSeqRef.current === seq) anchorLoadInFlightRef.current = false;
    }
    if (!isCurrent()) return;
    await nextFrame();
    if (!isCurrent()) return;
    const rows = useChatStore.getState().messages.get(requestChannelId) ?? [];
    const first = result === 'loaded' ? firstUnreadMessageId(rows, lastReadId, isOwnMessage) : null;
    if (first) {
      anchorAtUnread(first);
      return;
    }
    setAnchor(BOTTOM_ANCHOR);
    applyAnchor();
  }, [channelId, setAnchor, loadMessagesAround, isOwnMessage, anchorAtUnread, applyAnchor]);

  /** Take the open target once the channel's rows are rendered. */
  const openChannel = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    openedChannelRef.current = channelId;
    const target = openTargetRef.current;
    if (target.kind === 'message') {
      setAnchor(target);
      if (findRow(container, target.messageId)) applyAnchor();
      else void restoreAnchor(target);
      return;
    }
    if (target.kind === 'unread') {
      const state = useChatStore.getState();
      const rows = state.messages.get(channelId) ?? [];
      const hasOlder = state.hasMore.get(channelId) ?? true;
      if (!pageReachesReadPosition(rows, target.lastReadId, hasOlder)) {
        void openAtUnreadWindow(target.lastReadId);
        return;
      }
      const first = firstUnreadMessageId(rows, target.lastReadId, isOwnMessage);
      if (first) {
        anchorAtUnread(first);
        return;
      }
    }
    setAnchor(BOTTOM_ANCHOR);
    applyAnchor();
  }, [channelId, setAnchor, applyAnchor, restoreAnchor, openAtUnreadWindow, isOwnMessage, anchorAtUnread]);

  // Mark Unread on a message of the open channel moves the divider to the
  // first unread message after it. Read positions otherwise only move forward.
  const readPosition = useChatStore((s) => s.readStates.get(channelId));
  const lastReadPositionRef = useRef<{ channelId: string; id: string | undefined }>({ channelId, id: readPosition });
  useEffect(() => {
    const previous = lastReadPositionRef.current;
    lastReadPositionRef.current = { channelId, id: readPosition };
    if (previous.channelId !== channelId || readPosition === undefined || previous.id === undefined) return;
    if (!/^\d+$/.test(readPosition) || !/^\d+$/.test(previous.id) || BigInt(readPosition) >= BigInt(previous.id)) return;
    const rows = useChatStore.getState().messages.get(channelId) ?? [];
    const first = firstUnreadMessageId(rows, readPosition, isOwnMessage);
    setUnreadMarker(first ? { channelId, messageId: first } : null);
  }, [channelId, readPosition, isOwnMessage]);

  // The rows changed. Before the channel is open, this is the moment to open
  // it. After, the anchor holds the view: new rows below a view at the bottom
  // are followed with a smooth scroll, and anything else (older rows loaded
  // above, a cache replaced under the view, a jump's window) is re-anchored
  // before paint.
  useLayoutEffect(() => {
    const prev = renderedIdsRef.current;
    const ids = interleavedMessages.map((m) => m.id);
    renderedIdsRef.current = { channelId, ids };
    if (ids.length === 0) return;
    const container = containerRef.current;
    if (!container) return;

    if (openedChannelRef.current !== channelId) {
      openChannel();
      return;
    }

    const anchor = anchorRef.current;
    if (anchor.kind === 'message' && !findRow(container, anchor.messageId)) {
      if (anchorLoadInFlightRef.current) return;
      // Outside the rows now loaded, the anchored row was dropped with the
      // cache (a reload, a replaced window): load it back. Inside them, it was
      // deleted: hold what is on screen now.
      if (idWithinRows(anchor.messageId, ids)) deriveAnchorFromLayout();
      else void restoreAnchor(anchor);
      return;
    }
    const sameChannel = prev.channelId === channelId;
    const appended = sameChannel
      && sharesAnyId(prev.ids, ids)
      && ids.length > prev.ids.length
      && ids[ids.length - 1] !== prev.ids[prev.ids.length - 1];
    if (anchor.kind === 'bottom' && appended) {
      // New messages arrived while at the bottom — smooth scroll to them.
      beginSmoothScrollIntent('bottom');
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    applyAnchor();
  }, [interleavedMessages, channelId, openChannel, restoreAnchor, deriveAnchorFromLayout, beginSmoothScrollIntent, applyAnchor]);

  // Every size change re-applies the anchor: the content (rows laying out,
  // embeds loading, and the composer clearance, which is the content's
  // bottom padding and so only visible in its border box) and the scroll
  // viewport itself (the mobile keyboard, window resizes).
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const content = contentRef.current;
    const container = containerRef.current;
    if (!content || !container) return;

    const observer = new ResizeObserver(() => {
      if (openedChannelRef.current !== currentChannelIdRef.current) return;
      applyAnchor();
    });
    observer.observe(content, { box: 'border-box' });
    observer.observe(container);
    return () => observer.disconnect();
  }, [hasMessages, channelId, applyAnchor]);

  // Re-apply the anchor when any image/media inside the list finishes loading.
  // The `load` event doesn't bubble, but capture-phase listeners on ancestors still fire.
  // This handles the case ResizeObserver misses due to its own layout-loop suppression.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const handleMediaLoad = () => {
      if (openedChannelRef.current !== currentChannelIdRef.current) return;
      applyAnchor();
    };

    content.addEventListener('load', handleMediaLoad, true);
    return () => content.removeEventListener('load', handleMediaLoad, true);
  }, [hasMessages, channelId, applyAnchor]);

  // `scrollend` listener (Chrome 114+, Safari 18+).
  // Fires once per smooth-scroll animation completion. When a 'bottom' intent is in
  // flight, do a final defensive pin: layout may have grown between the smooth-scroll
  // command and its terminal frame (lazy-loaded media, late embeds), and the smooth
  // animation will have stopped at the originally computed target. For browsers without
  // scrollend, the timeout fallback armed in `beginSmoothScrollIntent` does the same.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof window === 'undefined' || !('onscrollend' in window)) return;

    const handleScrollEnd = () => {
      const intent = smoothScrollIntentRef.current;
      if (intent === 'bottom') {
        finalizeBottomSmoothScroll();
      } else if (intent === 'message') {
        // No pin (the target is not the bottom), but clear the intent so the anchor is
        // applied again and the next bottom-bound smooth scroll's suppression works.
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

  // ─── Jump to message ─────────────────────────────────────────────────────
  // One path for every jump: search results (the `jumpToMessageId` prop) and
  // reply previews (through MessageJumpContext). See docs/systems/message-list.md,
  // "Jump to message".

  // The anchor is set from where the jump will land, before the list moves:
  // a far jump holds the row (messages arriving afterwards do not pull the
  // view back); a jump that lands near the bottom keeps following. A target
  // already on screen near the bottom may not move the list at all, and no
  // scroll event follows, so the anchor cannot wait for one.
  // Returns the row it scrolled to, or null when the row is not rendered.
  const scrollToRenderedMessage = useCallback((messageId: string): HTMLElement | null => {
    const container = containerRef.current;
    const el = container ? findRow(container, messageId) : null;
    if (!container || !el) return null;
    cancelBottomPinning();
    const destination = centredScrollTop(container, el);
    const distanceFromBottom = container.scrollHeight - container.clientHeight - destination;
    setAnchor(distanceFromBottom < AT_BOTTOM_THRESHOLD_PX
      ? BOTTOM_ANCHOR
      : { kind: 'message', messageId, offsetPx: rowOffset(container, el) - (destination - container.scrollTop) });
    setIsNearBottom(distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX);
    beginSmoothScrollIntent('message');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashMessage(el);
    return el;
  }, [cancelBottomPinning, setAnchor, beginSmoothScrollIntent]);

  const jumpToMessage = useCallback(async (messageId: string): Promise<void> => {
    const seq = ++jumpSeqRef.current;
    const requestChannelId = channelId;
    const isCurrent = () => jumpSeqRef.current === seq && currentChannelIdRef.current === requestChannelId;
    // A jump is where the channel opens, if it has not opened yet.
    openedChannelRef.current = requestChannelId;
    // Focus follows the jump only if nobody moved it meanwhile: a jump that
    // waits on the network must not pull focus out of the composer the user
    // clicked into while it loaded.
    const focusAtStart = document.activeElement;
    const land = (): boolean => {
      const el = isMessageLoaded(requestChannelId, messageId) ? scrollToRenderedMessage(messageId) : null;
      if (!el) return false;
      const active = document.activeElement;
      if (active === focusAtStart || active === null || active === document.body) focusJumpTarget(el);
      return true;
    };

    if (land()) return;

    // Not loaded: replace the cache with the window around the target on the
    // channel's origin. Anchor to the target first, so the window lays out
    // around it instead of being followed to its bottom.
    cancelBottomPinning();
    const container = containerRef.current;
    setAnchor({ kind: 'message', messageId, offsetPx: container ? Math.max(0, (container.clientHeight - ROW_HEIGHT_ESTIMATE_PX) / 2) : 0 });
    anchorLoadInFlightRef.current = true;
    let result: LoadAroundResult;
    try {
      result = await loadMessagesAround(requestChannelId, messageId);
    } finally {
      if (jumpSeqRef.current === seq) anchorLoadInFlightRef.current = false;
    }
    if (!isCurrent()) return;

    if (result === 'loaded') {
      // Two frames: React commits the new window, then lays it out.
      await nextFrame();
      await nextFrame();
      if (!isCurrent()) return;
      if (land()) return;
    }

    deriveAnchorFromLayout();
    addToast(
      result === 'failed' ? t('chat:list.jump.failed') : t('chat:list.jump.unavailable'),
      'info',
      4000,
    );
  }, [channelId, scrollToRenderedMessage, cancelBottomPinning, setAnchor, loadMessagesAround, deriveAnchorFromLayout, addToast, t]);

  // Rows get a fire-and-forget handle; the jump reports its own failures.
  const requestJump = useCallback((messageId: string) => {
    void jumpToMessage(messageId);
  }, [jumpToMessage]);

  // A jump requested from outside the list (search result). Each request is
  // taken once: a parent that re-renders before clearing it (or passes a new
  // callback each render) must not start the load again.
  const handledJumpRequestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jumpToMessageId) {
      handledJumpRequestRef.current = null;
      return;
    }
    if (handledJumpRequestRef.current === jumpToMessageId) return;
    handledJumpRequestRef.current = jumpToMessageId;
    onJumpHandled?.();
    requestJump(jumpToMessageId);
  }, [jumpToMessageId, onJumpHandled, requestJump]);

  // Jump to Present. After a jump the cache can be a window that stops short
  // of the newest message (`detachedChannels`); scrolling to its bottom would
  // not be the present, so reload the newest page first and pin to it.
  const jumpToPresent = useCallback(async () => {
    const seq = ++jumpSeqRef.current;
    const requestChannelId = channelId;
    const isCurrent = () => jumpSeqRef.current === seq && currentChannelIdRef.current === requestChannelId;
    anchorLoadInFlightRef.current = false;
    if (!useChatStore.getState().detachedChannels.has(channelId)) {
      setAnchor(BOTTOM_ANCHOR);
      beginSmoothScrollIntent('bottom');
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    // The fresh page is laid out at the bottom as it arrives.
    cancelBottomPinning();
    setAnchor(BOTTOM_ANCHOR);
    const loaded = await loadMessages(requestChannelId, true);
    if (!isCurrent()) return;
    if (!loaded) {
      // The window is still the cache. Its bottom is not the present, so
      // stay where the user is, take the anchor from the layout, and say so.
      deriveAnchorFromLayout();
      addToast(t('chat:list.jump.presentFailed'), 'info', 4000);
      return;
    }
    requestAnimationFrame(() => {
      if (!isCurrent()) return;
      setAnchor(BOTTOM_ANCHOR);
      applyAnchor();
    });
  }, [channelId, setAnchor, beginSmoothScrollIntent, cancelBottomPinning, loadMessages, deriveAnchorFromLayout, applyAnchor, addToast, t]);

  const handleScroll = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    // Before the channel has opened there is nothing to hold: the first
    // events are the browser clamping the previous channel's offset.
    if (openedChannelRef.current !== channelId) return;

    // The list's own scroll, or one caused by a layout change since the list
    // last measured (the browser clamping the offset when content shrank):
    // hold the anchor. See docs/systems/message-list.md, "Anchoring model".
    const geometry = appliedGeometryRef.current;
    const geometryChanged = !geometry
      || geometry.scrollHeight !== container.scrollHeight
      || geometry.clientHeight !== container.clientHeight;
    if (container.scrollTop === appliedScrollTopRef.current || geometryChanged) {
      applyAnchor();
      return;
    }

    // The user moved the view. An event at the list's last offset from here
    // on is a coincidence, not the list's own.
    appliedScrollTopRef.current = null;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;

    // While a smooth scroll we started animates toward the bottom, its frames
    // report large distances. Keep the anchor at the bottom through them, so
    // media that finishes loading mid-animation is still followed, unless the
    // user has wheeled well away (a deliberate gesture overriding the animation).
    const intent = smoothScrollIntentRef.current;
    const holdingBottom = intent === 'bottom'
      && performance.now() < smoothScrollDeadlineRef.current
      && distanceFromBottom < SMOOTH_SCROLL_USER_INTENT_THRESHOLD;
    if (!holdingBottom) setAnchor(anchorFromLayout(container));
    recordGeometry(container);

    // Load more when scrolled to top. The rows loaded above the view are held
    // in place by the anchor (the layout effect re-applies it before paint).
    // Capture the channelId so a channel switch that races the await is detected;
    // the try/finally guarantees `setIsLoadingMore(false)` runs even if the load
    // throws. The channel-switch reset is the safety net for an await that never
    // resolves.
    // Consume the post-channel-switch suppression flag. The first scroll event
    // after a channel change is almost always the browser-clamp event and must
    // NOT be treated as a user scroll-to-top.
    let suppressLoadMore = false;
    if (suppressNextLoadMoreRef.current) {
      suppressNextLoadMoreRef.current = false;
      if (suppressNextLoadMoreTimerRef.current) {
        clearTimeout(suppressNextLoadMoreTimerRef.current);
        suppressNextLoadMoreTimerRef.current = null;
      }
      suppressLoadMore = true;
    }

    // scrollTop >= 0 guards against iOS Safari rubber-band overscroll producing
    // briefly-negative scrollTop values, which would otherwise satisfy the
    // upper bound and fire a spurious load during a rubber-band gesture.
    if (
      !suppressLoadMore &&
      container.scrollTop >= 0 &&
      container.scrollTop < PAGINATION_SLOT_HEIGHT_PX + 50 &&
      hasMore &&
      !isLoadingMore
    ) {
      setIsLoadingMore(true);
      try {
        await loadMoreMessages(channelId);
      } finally {
        setIsLoadingMore(false);
      }
    }
  }, [channelId, hasMore, isLoadingMore, loadMoreMessages, applyAnchor, setAnchor, anchorFromLayout, recordGeometry]);

  if (!canReadHistory) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-txt-tertiary text-[14px]">{t('chat:list.noHistoryPermission')}</span>
      </div>
    );
  }

  // The initial-load skeleton is rendered as an absolutely-positioned overlay
  // (NOT an early return) so that the scroll container below — and its
  // `containerRef` / `contentRef` — stay mounted across the loading transition.
  // Auto-scroll effects (initial snap, ResizeObserver, load-handler, scrollend)
  // are keyed on `[messages.length, channelId]` / `[hasMessages, channelId]`,
  // and each commits its only re-fire signal during the load window. If the
  // refs were null at that moment (which they are if the skeleton replaces the
  // container via early-return), every effect bails on its null guard and never
  // re-attaches once the skeleton clears, leaving the user scrolled to the top.
  // See docs/systems/message-list.md "ContainerRef invariant".

  return (
    <MessageJumpContext.Provider value={requestJump}>
    <div className="flex-1 relative min-h-0">
      <div
        ref={containerRef}
        className="h-full overflow-y-auto overflow-x-hidden no-scrollbar"
        onScroll={handleScroll}
      >
        {hasMore && (
          <div style={{ height: PAGINATION_SLOT_HEIGHT_PX }}>
            {showPaginationSkeleton && (
              <div className="px-4 pt-4" role="status" aria-label={t('chat:list.loadingOlder')}>
                {Array.from({ length: 3 }, (_, i) => (
                  <div
                    key={i}
                    className={`flex gap-3 ${i < 2 ? 'mb-5' : ''}`}
                    style={{ animationDelay: `${i * 0.15}s` }}
                  >
                    <div className="skeleton skeleton-circle w-10 h-10 flex-shrink-0" style={{ animationDelay: `${i * 0.15}s` }} />
                    <div className="flex-1 space-y-2 pt-1">
                      <div className="skeleton skeleton-bar" style={{ width: `${22 + (i * 9) % 18}%`, animationDelay: `${i * 0.15}s` }} />
                      <div className="skeleton skeleton-bar h-2.5" style={{ width: `${55 + (i * 11) % 35}%`, animationDelay: `${i * 0.15}s` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!hasMore && <WelcomeHeader channelId={channelId} />}

        <div
          ref={contentRef}
          className="pt-4"
          style={{ paddingBottom: 'var(--composer-clearance, 80px)' }}
        >
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
                {unreadMarker?.channelId === channelId && unreadMarker.messageId === msg.id && (
                  <UnreadDivider label={t('chat:list.unread.label')} description={t('chat:list.unread.divider')} />
                )}
                {msg.type === 'system' ? (
                  <SystemMessage message={msg} dm={currentDm ?? null} />
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

      {showInitialSkeleton && (
        <div
          className="absolute inset-0 z-10 bg-surface-chat flex flex-col justify-end px-4 pb-6 pointer-events-none"
          role="status"
          aria-label={t('chat:list.loading')}
        >
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
      )}

      {(!isNearBottom || isDetached) && messages.length > 0 && (
        <button
          onClick={() => { void jumpToPresent(); }}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-[120] glass-bubble px-4 py-2 flex items-center gap-2 rounded-full text-txt-secondary hover:text-txt-primary transition-all animate-fade-in cursor-pointer"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
          </svg>
          <span className="text-[13px] font-medium">{t('chat:list.jumpToPresent')}</span>
        </button>
      )}
    </div>
    </MessageJumpContext.Provider>
  );
}

/**
 * Where the unread messages start. A separator with its own name, so a
 * screen reader moving through the list hears it; the visible label is short.
 */
function UnreadDivider({ label, description }: { label: string; description: string }) {
  return (
    <div
      role="separator"
      aria-label={description}
      className="flex items-center gap-2 pl-5 pr-4 my-2 select-none pointer-events-none"
    >
      <div className="flex-1 h-px bg-accent-rose/50" />
      <span className="rounded-full bg-accent-rose/15 px-2 py-[1px] text-[11px] font-bold leading-4 text-accent-rose">
        {label}
      </span>
    </div>
  );
}

function WelcomeHeader({ channelId }: { channelId: string }) {
  const { t } = useTranslation(['chat', 'common']);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const authUser = useAuthStore((s) => s.user);
  const removeFriend = useSocialStore((s) => s.removeFriend);
  const friends = useSocialStore((s) => s.friends);
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const openModal = useUIStore((s) => s.openModal);
  const isDm = useIsDmChannel(channelId);
  const navigate = useNavigate();

  if (isDm) {
    const dm = dmChannels.find(d => d.id === channelId);
    if (!dm) return null; // DM data not yet loaded (WebSocket ready pending)
    const otherMembers = dm.members.filter(m => !isSelf(m, authUser));
    const isGroupDm = !!dm.ownerId;

    if (isGroupDm) {
      const groupName = formatDmHeaderName(dm, authUser);
      const ownerMember = dm.members.find(m => m.id === dm.ownerId);
      const ownerName = ownerMember?.displayName ?? ownerMember?.username ?? t('common:states.unknown');
      const hasFederated = dm.members.some(m => m.homeInstance);

      const handleLeaveGroup = async () => {
        try {
          await api.dm.leave(channelId);
          navigate('/channels/@me');
        } catch (err) {
          console.error('Failed to leave group:', err);
        }
      };

      const handleOpenSettings = () => {
        openModal('groupDmSettings', { dmChannelId: channelId, initialTab: 'overview' });
      };

      const handleOwnerClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        if (!ownerMember) return;
        openUserProfile(ownerMember, e.currentTarget.getBoundingClientRect(), 'bottom');
      };

      return (
        <div className="px-4 pt-8 pb-4">
          <div className="mb-2">
            <AvatarStack members={otherMembers} size={80} border="chat" iconUrl={dm.icon} />
          </div>
          <h3 className="text-[32px] leading-10 font-bold text-txt-primary mt-2">{groupName}</h3>
          <p className="text-txt-secondary text-[14px] mt-1">
            {t('chat:list.welcome.group.intro')}
          </p>
          <p className="text-xs text-txt-tertiary mt-1">
            <Trans
              t={t}
              i18nKey="chat:list.welcome.group.owner"
              values={{ name: ownerName }}
              components={{
                owner: ownerMember ? (
                  <button
                    type="button"
                    onClick={handleOwnerClick}
                    className="font-bold text-txt-secondary hover:text-txt-primary hover:underline transition-colors"
                  />
                ) : (
                  <strong />
                ),
              }}
            />
          </p>
          {hasFederated && (
            <p className="text-xs text-txt-tertiary mt-1">
              {t('chat:list.welcome.group.federatedNotice')}
            </p>
          )}
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={handleOpenSettings}
              className="px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-[14px] font-medium rounded-[3px] transition-colors"
            >
              {t('chat:list.welcome.group.openSettings')}
            </button>
            <button
              onClick={handleLeaveGroup}
              className="px-4 py-1.5 bg-surface-elevated hover:bg-interactive-hover text-[14px] font-medium text-txt-primary rounded-[3px] transition-colors"
            >
              {t('chat:list.welcome.group.leave')}
            </button>
          </div>
          <div className="mt-6 border-b border-interactive-muted" />
        </div>
      );
    }

    // 1-on-1 DM welcome header
    const otherUser = otherMembers[0];
    const { baseName } = parseFederatedUsername(otherUser?.username ?? '');
    const displayName = otherUser?.displayName ?? (baseName || t('chat:list.welcome.dm.fallbackName'));
    const mentionName = otherUser?.displayName ?? baseName;
    const isFriend = otherUser ? friends.some(f => f.id === otherUser.id) : false;

    return (
      <div className="px-4 pt-8 pb-4">
        <div className="mb-2">
          <ProfileAvatar src={otherUser?.avatar} name={displayName} size={80} user={otherUser ?? undefined} />
        </div>
        <h3 className="text-[32px] leading-10 font-bold text-txt-primary">{displayName}</h3>
        <p className="text-txt-secondary text-[14px] mt-1">
          <Trans
            t={t}
            i18nKey="chat:list.welcome.dm.intro"
            values={{ name: mentionName }}
            components={{ strong: <strong /> }}
          />
        </p>
        {otherUser?.homeInstance && (
          <p className="text-xs text-txt-tertiary mt-1">
            {t('chat:list.welcome.dm.federatedNotice')}
          </p>
        )}
        {isFriend && otherUser && (
          <div className="mt-4">
            <button
              onClick={() => removeFriend(otherUser.id)}
              className="px-4 py-1.5 bg-surface-elevated hover:bg-surface-elevated text-[14px] font-medium text-txt-primary rounded-[3px] transition-colors"
            >
              {t('chat:list.welcome.dm.removeFriend')}
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
      <h3 className="text-[32px] leading-10 font-bold text-txt-primary">{t('chat:list.welcome.channel.title')}</h3>
      <p className="text-txt-secondary text-[16px] mt-2">{t('chat:list.welcome.channel.description')}</p>
      <div className="mt-6 border-b border-interactive-muted" />
    </div>
  );
}
