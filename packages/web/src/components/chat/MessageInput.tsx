import { layoutRect } from '../../platform/interfaceScale';
import React, { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chatStore';
import { isDmChannel, useIsDmChannel, getChannelOrigin, useSpaceStore } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { MentionPopover } from './MentionPopover';
import { TypingIndicator } from './TypingIndicator';
import { InputPopover, type InputPopoverTab } from './InputPopover';
import { StagedTransferTiles } from './StagedTransferTiles';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { MAX_MESSAGE_LENGTH } from '@backspace/shared';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useComposerStore } from '../../stores/composerStore';
import { useTransferStore, type Transfer } from '../../stores/transferStore';
import { usePendingMessageStore } from '../../stores/pendingMessageStore';
import { putHandle, supportsFsHandles, supportsDnDHandles } from '../../utils/idbHandles';
import { useVisualViewportInset } from '../../hooks/useVisualViewportInset';
import { useAuthStore } from '../../stores/authStore';
import { selfIdentityOf } from '../../utils/identity';
import { findLastOwnEditableMessage } from './messageEditing';
import { describeError } from '../../i18n/errors';
import {
  filterMentionCandidates,
  useChannelMentionCandidates,
  type ChannelUser,
} from '../../utils/channelUser';

interface MessageInputProps {
  channelId: string;
  channelName: string;
  /**
   * Optional override for the textarea placeholder. When omitted the
   * placeholder is derived from `channelName` (`'Message @user'` for DMs,
   * `'Message #channel'` otherwise). DM call sites pass the resolved
   * placeholder directly so they can collapse the unreadable joined-names
   * form ("Message #Alice, Bob, Charlie, Dave") to "Message the group"
   * when the group has no `dm.name` set.
   */
  placeholder?: string;
}

interface MentionState {
  query: string;
  startIndex: number;
  selectedIndex: number;
}

// Default tus expiration window if a transfer doesn't yet have one (24h).
const DEFAULT_TUS_TTL_MS = 24 * 60 * 60 * 1000;

function makeFileHandleKey(): string {
  return `up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function MessageInput({ channelId, channelName, placeholder }: MessageInputProps) {
  const { t } = useTranslation(['chat', 'common']);
  // Composer state lives in composerStore (per-channel, persisted)
  const composerState = useComposerStore((s) => s.states.get(channelId)) ?? {
    draftText: '',
    replyTo: null,
    stagedTransferIds: [] as string[],
  };
  const setDraft = useComposerStore((s) => s.setDraft);
  const composerSetReplyTo = useComposerStore((s) => s.setReplyTo);
  const attachToComposer = useComposerStore((s) => s.attach);
  const clearComposer = useComposerStore((s) => s.clear);

  // Transfer state — subscribe to the whole map so progress/state updates re-render
  const transfers = useTransferStore((s) => s.transfers);
  const startUpload = useTransferStore((s) => s.startUpload);

  // UI-only state stays local
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [activePopover, setActivePopover] = useState<InputPopoverTab | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  // Note: this ref is intentionally typed `HTMLDivElement | null` (mutable
  // ref shape) rather than the more restrictive `RefObject<HTMLDivElement>`
  // because we assign to `.current` from a callback ref below — the
  // callback ref bridges the imperative `popoverAnchorRef` consumers
  // (InputPopover / mention-popover anchoring) and the state-backed
  // `composerEl` slot used by the clearance-measuring effect.
  const popoverAnchorRef = useRef<HTMLDivElement | null>(null);

  // Object URLs for current-session image previews. transferStore doesn't hold
  // the raw File, so previews only exist for files picked in this session
  // (after reload, persisted transfers fall back to the icon placeholder).
  const previewUrlsRef = useRef<Map<string, string>>(new Map());

  const sendMessage = useChatStore((s) => s.sendMessage);
  const returnToPresent = useChatStore((s) => s.returnToPresent);
  // This channel's reply only: reply state is per channel (#390).
  const chatReplyTo = useChatStore((s) => s.replyTargets.get(channelId) ?? null);
  const chatSetReplyTo = useChatStore((s) => s.setReplyTo);
  const editingMessageId = useChatStore((s) => s.editingMessageId);
  const setEditingMessage = useChatStore((s) => s.setEditingMessage);
  // Who can be mentioned here: this channel's people, with ids on its origin.
  const mentionCandidates = useChannelMentionCandidates(channelId);

  const addToast = useUIStore((s) => s.addToast);
  const appendBubble = usePendingMessageStore((s) => s.append);

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Feature flags
  const gifEnabled = useSettingsStore((s) => s.gifEnabled);

  // Permission gating: DM channels always allow sending; space channels check SEND_MESSAGES
  const channelPerms = useSpaceStore((s) => s.channelPermissions.get(channelId));
  // Undefined until the ready that lists the channel: nothing can be routed yet, so the composer stays locked.
  const isDm = useIsDmChannel(channelId);
  const canSendMessages = isDm === true || hasPermissionBit(channelPerms, PermissionBits.SEND_MESSAGES);
  const canAttachFiles = isDm === true || hasPermissionBit(channelPerms, PermissionBits.ATTACH_FILES);

  // Derive staged transfers from composerStore staged ids + transferStore map
  const stagedTransfers: Transfer[] = useMemo(() => {
    const out: Transfer[] = [];
    for (const tid of composerState.stagedTransferIds) {
      const t = transfers.get(tid);
      if (t) out.push(t);
    }
    return out;
  }, [composerState.stagedTransferIds, transfers]);

  const draftText = composerState.draftText;
  const remaining = MAX_MESSAGE_LENGTH - draftText.length;
  const isOverLimit = remaining < 0;

  // Auto-focus textarea on channel navigation
  useEffect(() => {
    textareaRef.current?.focus();
  }, [channelId]);

  // Auto-focus textarea when replying (chatStore is the live source of truth)
  useEffect(() => {
    if (chatReplyTo) {
      textareaRef.current?.focus();
    }
  }, [chatReplyTo]);

  // Return focus to the composer after inline editing is saved or cancelled.
  useEffect(() => {
    if (!editingMessageId) textareaRef.current?.focus();
  }, [editingMessageId]);

  // Close popover on channel change
  useEffect(() => {
    setActivePopover(null);
    setMentionState(null);
  }, [channelId]);

  // Sync this channel's chatStore reply target into composerStore so reload restores it.
  // chatStore holds the live MessageWithUser; composerStore stores a flat snapshot.
  //
  // First-mirror-per-channel guard: chatStore is not persisted, so on a fresh
  // mount `chatReplyTo` is always null. Without this guard the mirror would
  // clobber whatever replyTo was persisted in composerStore. Reverse hydration
  // (composer→chat on reload) is not yet implemented; deferred to a future pass
  // (it requires the original message to be present in chatStore.messages,
  // which may not be loaded at mount).
  const mirroredChannelsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const isFirstMirrorForChannel = !mirroredChannelsRef.current.has(channelId);
    mirroredChannelsRef.current.add(channelId);

    if (isFirstMirrorForChannel) {
      if (chatReplyTo) {
        composerSetReplyTo(channelId, {
          id: chatReplyTo.id,
          userId: chatReplyTo.userId,
          content: chatReplyTo.content ?? null,
        });
      }
      return;
    }
    // Already mirrored once for this channel — propagate updates including null.
    if (chatReplyTo) {
      composerSetReplyTo(channelId, {
        id: chatReplyTo.id,
        userId: chatReplyTo.userId,
        content: chatReplyTo.content ?? null,
      });
    } else {
      composerSetReplyTo(channelId, null);
    }
  }, [channelId, chatReplyTo, composerSetReplyTo]);

  // Surface permanent transfer failures as toasts (one toast per id, latched)
  const toastedFailuresRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const transfer of stagedTransfers) {
      if (transfer.state === 'failed' && !toastedFailuresRef.current.has(transfer.id)) {
        toastedFailuresRef.current.add(transfer.id);
        const reason = transfer.error?.message ?? t('chat:composer.uploadFailedReason');
        addToast(t('chat:composer.uploadFailed', { file: transfer.file.name, reason }), 'warning');
      }
    }
  }, [stagedTransfers, addToast, t]);

  // The popover's rows; keyboard navigation indexes the same list.
  const mentionMatches = useMemo(
    () => (mentionState ? filterMentionCandidates(mentionCandidates, mentionState.query) : []),
    [mentionCandidates, mentionState],
  );

  const handleTyping = useCallback(() => {
    if (typingTimeoutRef.current) return;
    const dm = isDmChannel(channelId);
    if (dm) {
      wsSend({ type: 'dm_typing_start', dmChannelId: channelId }, getChannelOrigin(channelId));
    } else {
      wsSend({ type: 'typing_start', channelId }, getChannelOrigin(channelId));
    }
    typingTimeoutRef.current = setTimeout(() => {
      typingTimeoutRef.current = undefined;
    }, 3000);
  }, [channelId]);

  /**
   * Eagerly upload a file and stage the resulting transfer in composerStore.
   * If a FileSystemFileHandle is provided (drag-drop via getAsFileSystemHandle,
   * or FS Access pick), it's persisted in IDB so the upload is resumable
   * across reload.
   */
  const enqueueFile = useCallback(
    async (
      input: { file: File; handle?: FileSystemFileHandle | undefined },
    ): Promise<void> => {
      const { file, handle } = input;
      let fileHandleId: string | undefined;
      if (handle && supportsFsHandles()) {
        try {
          fileHandleId = makeFileHandleKey();
          await putHandle(fileHandleId, handle);
        } catch (err) {
          // Persistence failed — proceed without resume capability.
          fileHandleId = undefined;
          const msg = err instanceof Error ? err.message : 'unknown error';
          console.warn('[MessageInput] putHandle failed:', msg);
        }
      }

      try {
        const id = await startUpload(file, {
          channelId,
          tray: true,
          origin: getChannelOrigin(channelId),
          fileHandleId,
        });
        attachToComposer(channelId, id);
        // Best-effort image preview for the current session. transferStore
        // doesn't retain the File, so this URL only exists in-memory.
        if (file.type.startsWith('image/')) {
          try {
            const url = URL.createObjectURL(file);
            previewUrlsRef.current.set(id, url);
          } catch {
            // ignore — preview is optional
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : t('chat:composer.uploadFailedReason');
        addToast(t('chat:composer.uploadFailed', { file: file.name, reason }), 'warning');
      }
    },
    [channelId, startUpload, attachToComposer, addToast, t],
  );

  // Revoke all preview object URLs on unmount.
  useEffect(() => {
    const map = previewUrlsRef.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  const handleSubmit = async (): Promise<void> => {
    // Read the live draft: another Enter may arrive before React re-renders.
    const composer = useComposerStore.getState().get(channelId);
    const submittedDraft = composer.draftText;
    const trimmed = submittedDraft.trim();
    if (!trimmed && composer.stagedTransferIds.length === 0) return;
    if (submittedDraft.length > MAX_MESSAGE_LENGTH) return;

    // Block submission when ANY staged transfer is in a non-shippable state
    // (failed/aborted) — those would prevent the bubble from ever resolving.
    const hasUnshippable = stagedTransfers.some(
      (t) => t.state === 'failed' || t.state === 'aborted',
    );
    if (hasUnshippable) return;

    setMentionState(null);
    setActivePopover(null);

    // Clear typing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = undefined;
    }

    if (stagedTransfers.length === 0) {
      // Consume the draft synchronously; network completion must not erase newer typing.
      clearComposer(channelId);
      try {
        const sending = sendMessage(channelId, trimmed);
        // Reset textarea height + focus
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          textareaRef.current.focus();
        }
        await sending;
      } catch (err) {
        // Keep both the failed text and anything typed while the request was pending.
        const currentDraft = useComposerStore.getState().get(channelId).draftText;
        setDraft(channelId, submittedDraft + (currentDraft ? '\n' + currentDraft : ''));
        addToast(describeError(err), 'warning');
      }
      return;
    }

    // Attachment path — stage a pending bubble. The orchestrator dispatches the
    // actual API call when every transfer reaches state='completed'.
    const clientId = crypto.randomUUID();
    const replyToId = chatReplyTo?.id ?? null;

    // tusExpiresAt: min across staged transfers, default to 24h from now if absent.
    const now = Date.now();
    const fallbackExpires = now + DEFAULT_TUS_TTL_MS;
    const expirations = stagedTransfers
      .map((t) => t.tusExpiresAt)
      .filter((x): x is number => typeof x === 'number' && x > 0);
    const tusExpiresAt = expirations.length > 0 ? Math.min(...expirations) : fallbackExpires;

    // As for a text send (chatStore.sendMessage): sending from a window of
    // older history goes back to the present, where the message will appear.
    void returnToPresent(channelId);
    appendBubble({
      clientId,
      channelId,
      content: trimmed,
      replyToId,
      transferIds: stagedTransfers.map((t) => t.id),
      createdAtLocal: now,
      state: 'sending',
      tusExpiresAt,
      retryCount: 0,
    });

    // Detach the staged transfers from the composer (they're now owned by the bubble)
    // and clear the draft + reply for this channel.
    clearComposer(channelId);
    chatSetReplyTo(channelId, null);

    // Reset textarea height + focus
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  };

  const selectMention = useCallback(
    (candidate: ChannelUser) => {
      if (!mentionState) return;
      const textarea = textareaRef.current;
      const cursorPos = textarea?.selectionStart ?? draftText.length;
      const before = draftText.slice(0, mentionState.startIndex);
      const after = draftText.slice(cursorPos);
      const insertion = `<@${candidate.userId}> `;
      const newContent = before + insertion + after;
      setDraft(channelId, newContent);
      setMentionState(null);

      // Restore cursor position after React re-renders
      const newCursorPos = before.length + insertion.length;
      requestAnimationFrame(() => {
        if (textarea) {
          textarea.focus();
          textarea.selectionStart = newCursorPos;
          textarea.selectionEnd = newCursorPos;
        }
      });
    },
    [mentionState, draftText, setDraft, channelId],
  );

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // Mention popover keyboard navigation
    if (mentionState && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionState((prev) =>
          prev ? { ...prev, selectedIndex: Math.min(prev.selectedIndex + 1, mentionMatches.length - 1) } : null,
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionState((prev) =>
          prev ? { ...prev, selectedIndex: Math.max(prev.selectedIndex - 1, 0) } : null,
        );
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = mentionMatches[mentionState.selectedIndex];
        if (selected) selectMention(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionState(null);
        return;
      }
    }

    const isPlainArrowUp = e.key === 'ArrowUp'
      && !e.altKey
      && !e.ctrlKey
      && !e.metaKey
      && !e.shiftKey
      && !e.nativeEvent.isComposing;
    const composerIsEmpty = draftText.length === 0
      && composerState.stagedTransferIds.length === 0
      && !chatReplyTo
      && !composerState.replyTo;

    if (isPlainArrowUp && composerIsEmpty && !editingMessageId) {
      // Read the list on demand: subscribing to it would re-render the composer
      // on every incoming message, and the shortcut only needs it at keypress time.
      const channelMessages = useChatStore.getState().messages.get(channelId) ?? [];
      const { user, myRowIds } = useAuthStore.getState();
      const message = findLastOwnEditableMessage(channelMessages, getChannelOrigin(channelId), selfIdentityOf(user, myRowIds));
      if (message) {
        e.preventDefault();
        setActivePopover(null);
        setEditingMessage(message.id);
        return;
      }
    }

    // Default: Enter to submit
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) void enqueueFile({ file });
      }
    }
  };

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const items = e.dataTransfer.items;
    const useDndHandles = supportsDnDHandles();

    if (useDndHandles && items && items.length > 0) {
      // Chrome/Edge: upgrade to FileSystemFileHandle for resume-across-reload.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || item.kind !== 'file') continue;
        // @ts-ignore — getAsFileSystemHandle is non-standard
        const maybeHandle: Promise<FileSystemHandle | null> | undefined = item.getAsFileSystemHandle?.();
        const file = item.getAsFile();
        if (maybeHandle) {
          void maybeHandle.then(async (handle) => {
            if (handle && handle.kind === 'file') {
              const fh = handle as FileSystemFileHandle;
              const handleAny = fh as unknown as { getFile?: () => Promise<File> };
              if (typeof handleAny.getFile === 'function') {
                try {
                  const f = await handleAny.getFile();
                  void enqueueFile({ file: f, handle: fh });
                  return;
                } catch {
                  // fall through to plain-file path
                }
              }
            }
            if (file) void enqueueFile({ file });
          });
        } else if (file) {
          void enqueueFile({ file });
        }
      }
      return;
    }

    // Fallback: plain Files list (Firefox/Safari)
    const droppedFiles = Array.from(e.dataTransfer.files);
    for (const file of droppedFiles) {
      void enqueueFile({ file });
    }
  };

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setDraft(channelId, value);

    // Detect @mention trigger
    const textBeforeCursor = value.slice(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/@([^\s<]*)$/);

    if (mentionMatch) {
      const atIndex = cursorPos - mentionMatch[0].length;
      // Only trigger at word boundary: start of input, after space, or after newline
      const charBefore = atIndex > 0 ? value[atIndex - 1] : undefined;
      if (charBefore === undefined || charBefore === ' ' || charBefore === '\n') {
        setMentionState({
          query: mentionMatch[1] ?? '',
          startIndex: atIndex,
          selectedIndex: 0,
        });
      } else {
        setMentionState(null);
      }
    } else {
      setMentionState(null);
    }

    handleTyping();

    // Auto-resize textarea
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
  };

  const handleEmojiSelect = useCallback(
    (emoji: { native: string }) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        setDraft(channelId, draftText + emoji.native);
        return;
      }
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = draftText.slice(0, start);
      const after = draftText.slice(end);
      const newContent = before + emoji.native + after;
      setDraft(channelId, newContent);

      // Restore cursor position after the emoji
      const newCursorPos = start + emoji.native.length;
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.selectionStart = newCursorPos;
        textarea.selectionEnd = newCursorPos;
      });
    },
    [draftText, setDraft, channelId],
  );

  const handleGifSelect = useCallback(
    (url: string) => {
      // GIF picks bypass the staged-transfer pipeline — they're remote URLs,
      // not local files, and ship as plain content.
      setActivePopover(null);
      void sendMessage(channelId, url).catch((error: unknown) => {
        addToast(describeError(error), 'warning');
      });
    },
    [channelId, sendMessage, addToast],
  );

  const togglePopover = useCallback((tab: InputPopoverTab) => {
    setActivePopover((prev) => (prev === tab ? null : tab));
  }, []);

  // anyActiveOrQueued: a visual indicator something is in flight; pending/paused
  // bubbles are still allowed to ship (orchestrator handles them).
  const anyActiveOrQueued = stagedTransfers.some(
    (t) => t.state === 'active' || t.state === 'queued',
  );
  const anyUnshippable = stagedTransfers.some(
    (t) => t.state === 'failed' || t.state === 'aborted',
  );
  const failedCount = stagedTransfers.filter((t) => t.state === 'failed').length;

  const canSend =
    (draftText.trim().length > 0 || stagedTransfers.length > 0) &&
    !isOverLimit &&
    !anyUnshippable;

  // Composer positioning model — IDENTICAL across desktop and mobile.
  // ─────────────────────────────────────────────────────────────────
  // The composer is a floating glass-bubble (`glass-bubble rounded-[14px]`)
  // pinned to the bottom of the chat region with `position: absolute`. The
  // MessageList sibling fills the entire chat area; the last messages scroll
  // *behind* the translucent bubble. MessageList content carries a dynamic
  // `paddingBottom` (CSS variable `--composer-clearance`, set by the
  // ResizeObserver effect below) so the last message clears the bubble's
  // top edge with a 12 px breathing gap regardless of bubble height.
  //
  // Vertical positioning differs only in the `bottom` value:
  // - Desktop: `bottom: 12px` (the historical `desktop:bottom-3` constant).
  // - Mobile, keyboard closed: `bottom: var(--safe-bottom) + 6px`
  //   so the bubble clears the iOS home indicator with a small breathing gap.
  // - Mobile, keyboard open: `bottom: 0`. `MobileShell` shrinks its container
  //   to `visualViewport.height` (see `MobileShell.tsx`), so the chat region's
  //   bottom edge already sits on the keyboard's top edge. The composer then
  //   lands flush with the keyboard regardless of how reliably
  //   `visualViewport` event delivery is on iOS PWA — the shell's height
  //   shrinking is the load-bearing mechanism, not the inset arithmetic
  //   here. This dodges the long-standing iOS-standalone bug where
  //   `visualViewport.resize` fires late or not at all when the soft
  //   keyboard opens. The hook's `focusin` polling fallback covers the
  //   remaining gap by re-reading `vv.height` for ~600 ms after a text
  //   input gains focus, even when no resize event ever lands.
  //
  // The horizontal inset is symmetric: `left-2 right-2` on mobile (matches
  // `MobileVoiceMiniBar`'s `mx-2` and the `MobileBottomNav` spacing tier);
  // `desktop:left-3 desktop:right-3` on desktop (the historical 12 px inset).
  //
  // `z-[110]` keeps the bubble above any in-chat overlays (mention popover,
  // staged-attachment tiles) but below modals (`z-[300]+`).
  const isMobile = useUIStore((s) => s.isMobile);
  const { keyboardOpen, textInputFocused } = useVisualViewportInset();
  // iOS PWA standalone shrinks the *layout viewport* itself for the keyboard
  // (interactive-widget=resizes-content / native standalone behavior), so
  // `vv.height` matches `innerHeight` and the height-delta-inferred
  // `keyboardOpen` stays false even though the keyboard IS up. Focus state is
  // the robust fallback: a text input being focused means the keyboard is up.
  // - keyboardOpen true (Android Chrome): MobileShell already shrunk to
  //   `vv.height`; composer at `bottom: 0` lands on the keyboard top.
  // - keyboardOpen false but textInputFocused true (iOS PWA): layout viewport
  //   already shrunk by iOS; composer at `bottom: 4px` lands ~4 px above the
  //   keyboard top — the tight visual gap the user wants.
  // - both false: composer 6 px above the home indicator, the rest state.
  const composerStyle: React.CSSProperties | undefined = isMobile
    ? {
        bottom: keyboardOpen
          ? '0px'
          : textInputFocused
            ? '4px'
            : 'calc(var(--safe-bottom) + 6px)',
      }
    : undefined;
  const composerClass =
    'absolute left-2 right-2 z-[110] glass-bubble rounded-[14px]' +
    ' desktop:left-3 desktop:right-3 desktop:bottom-3';

  // Dynamic message-list bottom padding ("composer clearance"):
  //
  // The composer is `position: absolute` and overlays the bottom of the
  // chat region. The MessageList scroll content needs enough bottom padding
  // that the last message can be scrolled fully into view above the bubble
  // with a visible gap — otherwise the last message sticks flush to the
  // bubble's top edge (the bug user reported on iOS PWA: a static `pb-20`
  // = 80 px is smaller than `composer-bottom-offset (env safe-area + 6) +
  // composer-height (~50–100 px depending on staged attachments / multi-
  // line text)` on iPhone).
  //
  // Strategy: a single CSS custom property `--composer-clearance` is
  // written to the nearest scrollable ancestor on every composer-size or
  // composer-bottom-offset change. `MessageList` reads that variable as
  // its content's `paddingBottom`, falling back to a static 80 px when
  // unset (e.g. when no composer is mounted, or before the first measure).
  // The 12 px constant below is the desired breathing-room gap between the
  // last message's bottom edge and the composer's top edge.
  //
  // Why a CSS variable on the parent rather than a global:
  //   - One MessageInput per chat region; the variable scopes to that
  //     region so multi-pane layouts (DM list + chat in a future split
  //     view, voice channel side-panel, etc.) don't cross-talk.
  //   - The MessageList content already lives inside the same parent
  //     subtree, so a CSS variable inheritance just works.
  // We track the live composer DOM element via a state-backed ref. A plain
  // ref isn't enough because the component renders different JSX when
  // `canSendMessages` flips (the early-return permission-denied path doesn't
  // attach the ref), and a useEffect on the ref's value would not re-fire on
  // those re-renders. Channel permissions arrive asynchronously, so the
  // initial mount renders the no-permission JSX first, then re-renders with
  // the full composer once permissions resolve — we need to (re-)attach the
  // ResizeObserver at that moment.
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null);
  // The clearance for the live composer element. The variable is written on
  // every change and removed only when the composer element goes away: the
  // message list holds its view against it, and a removal, even one undone in
  // the same task, lets the browser lay the list out at the 80 px fallback and
  // clamp its scroll offset, which leaves the newest messages under the
  // composer (issue #361, docs/systems/message-list.md "Bottom clearance").
  const syncClearance = useCallback((el: HTMLDivElement) => {
    const target = el.parentElement;
    if (!target) return;
    // Total clearance = composer height + bottom offset + 12 px gap.
    // We measure the bubble's visual height (including replyTo banner +
    // staged-attachment tiles + textarea autosize) plus the distance from
    // the parent's bottom edge to the bubble's bottom edge (which folds
    // in `var(--safe-bottom) + 6` on mobile or `12 px` on
    // desktop, whichever the composer's `bottom` resolves to).
    const composerRect = layoutRect(el.getBoundingClientRect());
    const parentRect = layoutRect(target.getBoundingClientRect());
    const bottomOffset = Math.max(0, parentRect.bottom - composerRect.bottom);
    const clearance = `${Math.round(composerRect.height + bottomOffset + 12)}px`;
    if (target.style.getPropertyValue('--composer-clearance') !== clearance) {
      target.style.setProperty('--composer-clearance', clearance);
    }
  }, []);

  // The region the variable was last written to. It is cleared only when the
  // composer leaves that region (another region, or unmount), never between
  // two elements of the same composer (the permission-denied bubble and the
  // full one swap when channel permissions resolve).
  const clearanceTargetRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!composerEl) return;
    const target = composerEl.parentElement;
    if (!target) return;
    const previousTarget = clearanceTargetRef.current;
    if (previousTarget && previousTarget !== target) previousTarget.style.removeProperty('--composer-clearance');
    clearanceTargetRef.current = target;
    const el = composerEl;
    const sync = () => syncClearance(el);

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    // Also re-sync when the parent itself resizes (keyboard open/close
    // collapses the chat region's height; MobileShell drives this via
    // visualViewport.height).
    ro.observe(target);

    // Re-sync on visual viewport changes — the parent's `getBoundingClientRect`
    // updates with the layout, but if `MobileShell`'s height attribute
    // updates between paints, we want a same-frame re-measure.
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', sync);
      vv.addEventListener('scroll', sync);
    }

    return () => {
      ro.disconnect();
      if (vv) {
        vv.removeEventListener('resize', sync);
        vv.removeEventListener('scroll', sync);
      }
    };
  }, [composerEl, syncClearance]);

  useLayoutEffect(() => () => {
    clearanceTargetRef.current?.style.removeProperty('--composer-clearance');
    clearanceTargetRef.current = null;
  }, []);

  // The composer's `bottom` style and its content (reply banner, staged
  // files) change between renders without necessarily resizing the element
  // or its parent, so the observers above may not fire. Re-measure after
  // each such render, before paint, without touching the observers.
  useLayoutEffect(() => {
    if (composerEl) syncClearance(composerEl);
  }, [composerEl, syncClearance, isMobile, keyboardOpen, textInputFocused, chatReplyTo, stagedTransfers.length]);

  // Combined ref: keep `popoverAnchorRef` populated (InputPopover / mention
  // popover anchor + scroll-into-view targets) AND notify the
  // `composerEl` state slot so the clearance-measuring effect can re-run
  // when the element materializes / changes between conditional render
  // branches.
  const setComposerRef = useCallback((node: HTMLDivElement | null) => {
    popoverAnchorRef.current = node;
    setComposerEl(node);
  }, []);

  if (!canSendMessages) {
    return (
      <div ref={setComposerRef} data-pip-obstacle="bottom" className={composerClass} style={composerStyle}>
        <div className="flex items-center justify-center py-[14px] px-4">
          {/* While the channel is unknown (before its ready) nothing is refused yet:
              the shell alone, a non-breaking space keeping its height. */}
          <span className="text-txt-tertiary text-[14px]">
            {isDm === undefined ? '\u00a0' : t('chat:composer.noPermission')}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setComposerRef}
      data-pip-obstacle="bottom"
      className={composerClass}
      style={composerStyle}
    >
      <TypingIndicator channelId={channelId} />

      {/* Input popover (emoji / gif) */}
      {activePopover && (
        <InputPopover
          activeTab={activePopover}
          onClose={() => setActivePopover(null)}
          onEmojiSelect={handleEmojiSelect}
          onGifSelect={handleGifSelect}
          anchorRef={popoverAnchorRef}
          gifEnabled={gifEnabled}
          onTabChange={setActivePopover}
        />
      )}

      {chatReplyTo && (
        <div className="bg-interactive-hover rounded-t-lg px-4 py-2 flex items-center justify-between border-b border-white/[0.06]">
          <div className="flex items-center gap-1 text-[14px] text-txt-message truncate">
            <span className="opacity-60">{t('chat:composer.replyingTo')}</span>
            <span className="font-bold">
              {chatReplyTo.user.displayName ?? chatReplyTo.user.username}
            </span>
          </div>
          <button
            onClick={() => chatSetReplyTo(channelId, null)}
            className="text-txt-tertiary hover:text-txt-primary transition-colors"
            aria-label={t('chat:composer.cancelReply')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button>
        </div>
      )}
      <div
        ref={inputContainerRef}
        className={`relative ${chatReplyTo ? 'rounded-b-lg' : ''} overflow-visible`}
        onDrop={canAttachFiles ? handleDrop : undefined}
        onDragOver={canAttachFiles ? handleDragOver : undefined}
      >
        {/* Mention autocomplete popover */}
        {mentionState && mentionMatches.length > 0 && (
          <MentionPopover
            candidates={mentionMatches}
            selectedIndex={mentionState.selectedIndex}
            onSelect={selectMention}
            anchorRef={inputContainerRef}
          />
        )}

        <StagedTransferTiles
          channelId={channelId}
          stagedTransfers={stagedTransfers}
          previewUrls={previewUrlsRef.current}
        />

        <div className="flex items-center gap-1 desktop:gap-0 pl-2 desktop:pl-[10px] pr-2 desktop:pr-1">
          {/* File attach button */}
          {canAttachFiles && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-10 h-10 desktop:w-[34px] desktop:h-[34px] flex items-center justify-center rounded-[6px] text-txt-tertiary hover:text-txt-secondary transition-colors flex-shrink-0"
              title={t('chat:composer.attachFile')}
              aria-label={t('chat:composer.attachFile')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
              </svg>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const selected = Array.from(e.target.files ?? []);
              for (const f of selected) {
                void enqueueFile({ file: f });
              }
              e.target.value = '';
            }}
          />

          {/* Text input */}
          <textarea
            ref={textareaRef}
            value={draftText}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={canAttachFiles ? handlePaste : undefined}
            placeholder={
              placeholder ??
              (channelName.startsWith('@')
                ? t('chat:composer.placeholder.dm', { name: channelName.slice(1) })
                : t('chat:composer.placeholder.channel', { name: channelName }))
            }
            className="input-embedded flex-1 py-[10px] px-1 resize-none text-[15px] leading-[1.375rem] max-h-[calc(50*var(--app-vh))] scrollbar-thin"
            rows={1}
          />

          {/* Active-upload indicator */}
          {anyActiveOrQueued && (
            <div className="p-3 text-txt-tertiary" title={t('chat:composer.uploading')} aria-label={t('chat:composer.uploadingLabel')}>
              <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          )}

          {/* Failed-upload hint (gates send button) */}
          {failedCount > 0 && (
            <span
              className="text-[12px] font-medium text-accent-rose px-1 flex-shrink-0"
              title={t('chat:composer.failedHint')}
            >
              {t('chat:composer.failedCount', { count: failedCount })}
            </span>
          )}

          {/* Character counter (shows when near or over limit) */}
          {draftText.length > MAX_MESSAGE_LENGTH - 200 && (
            <span
              className={`text-[12px] font-medium tabular-nums flex-shrink-0 px-1 ${isOverLimit ? 'text-accent-rose' : 'text-txt-tertiary'}`}
            >
              {remaining}
            </span>
          )}

          {/* GIF button */}
          {gifEnabled && (
            <button
              onClick={() => togglePopover('gif')}
              className={`w-10 h-10 desktop:w-[34px] desktop:h-[34px] flex items-center justify-center rounded-[6px] transition-colors flex-shrink-0 ${
                activePopover === 'gif' ? 'text-accent-primary' : 'text-txt-tertiary hover:text-txt-secondary'
              }`}
              title={t('chat:composer.gif')}
              aria-label={t('chat:composer.gifPicker')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h15A2.5 2.5 0 0 1 22 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5v-13ZM5.1 14V10h3.2v1.2H6.5v.6h1.6v1.1H6.5V14H5.1Zm4.5 0V10h1.4v4H9.6Zm2.5 0V10h3.2v1.2h-1.8v.5h1.6v1h-1.6V14h-1.4Z" />
              </svg>
            </button>
          )}

          {/* Emoji button */}
          <button
            onClick={() => togglePopover('emoji')}
            className={`w-10 h-10 desktop:w-[34px] desktop:h-[34px] flex items-center justify-center rounded-[6px] transition-colors flex-shrink-0 ${
              activePopover === 'emoji' ? 'text-accent-primary' : 'text-txt-tertiary hover:text-txt-secondary'
            }`}
            title={t('chat:composer.emoji')}
            aria-label={t('chat:composer.emojiPicker')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5s.67 1.5 1.5 1.5zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
            </svg>
          </button>

          {/* Send button — appears when there's content/attachments to send */}
          {canSend && (
            <button
              onClick={() => void handleSubmit()}
              disabled={anyUnshippable}
              className="w-10 h-10 desktop:w-[34px] desktop:h-[34px] flex items-center justify-center rounded-[6px] bg-accent-primary hover:bg-accent-primary-hover text-white transition-all duration-150 flex-shrink-0 disabled:opacity-50"
              aria-label={t('chat:composer.sendMessage')}
              title={t('chat:composer.send')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
