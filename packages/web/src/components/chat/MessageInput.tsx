import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { isDmChannel, getChannelOrigin, useSpaceStore } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { MentionPopover } from './MentionPopover';
import { TypingIndicator } from './TypingIndicator';
import { InputPopover, type InputPopoverTab } from './InputPopover';
import { AttachmentProgress } from './AttachmentProgress';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { MAX_MESSAGE_LENGTH, type MemberWithUser } from '@backspace/shared';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useComposerStore } from '../../stores/composerStore';
import { useTransferStore, type Transfer } from '../../stores/transferStore';
import { usePendingMessageStore } from '../../stores/pendingMessageStore';
import { putHandle, supportsFsHandles, supportsDnDHandles } from '../../utils/idbHandles';
import { useVisualViewportInset } from '../../hooks/useVisualViewportInset';

interface MessageInputProps {
  channelId: string;
  channelName: string;
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

export function MessageInput({ channelId, channelName }: MessageInputProps) {
  // Composer state lives in composerStore (per-channel, persisted)
  const composerState = useComposerStore((s) => s.states.get(channelId)) ?? {
    draftText: '',
    replyTo: null,
    stagedTransferIds: [] as string[],
  };
  const setDraft = useComposerStore((s) => s.setDraft);
  const composerSetReplyTo = useComposerStore((s) => s.setReplyTo);
  const attachToComposer = useComposerStore((s) => s.attach);
  const removeStaged = useComposerStore((s) => s.removeStaged);
  const clearComposer = useComposerStore((s) => s.clear);

  // Transfer state — subscribe to the whole map so progress/state updates re-render
  const transfers = useTransferStore((s) => s.transfers);
  const startUpload = useTransferStore((s) => s.startUpload);
  const pauseUpload = useTransferStore((s) => s.pauseUpload);
  const resumeUpload = useTransferStore((s) => s.resumeUpload);
  const abortUpload = useTransferStore((s) => s.abortUpload);

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
  const chatReplyTo = useChatStore((s) => s.replyTo);
  const chatSetReplyTo = useChatStore((s) => s.setReplyTo);
  const members = useSpaceStore((s) => s.members);

  const addToast = useUIStore((s) => s.addToast);
  const appendBubble = usePendingMessageStore((s) => s.append);

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Feature flags
  const gifEnabled = useSettingsStore((s) => s.gifEnabled);

  // Permission gating: DM channels always allow sending; space channels check SEND_MESSAGES
  const channelPerms = useSpaceStore((s) => s.channelPermissions.get(channelId));
  const isDm = isDmChannel(channelId);
  const canSendMessages = isDm || hasPermissionBit(channelPerms, PermissionBits.SEND_MESSAGES);
  const canAttachFiles = isDm || hasPermissionBit(channelPerms, PermissionBits.ATTACH_FILES);

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

  // Close popover on channel change
  useEffect(() => {
    setActivePopover(null);
    setMentionState(null);
  }, [channelId]);

  // Sync chatStore.replyTo into composerStore so reload restores it.
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
    for (const t of stagedTransfers) {
      if (t.state === 'failed' && !toastedFailuresRef.current.has(t.id)) {
        toastedFailuresRef.current.add(t.id);
        const msg = t.error?.message ?? 'Upload failed';
        addToast(`Failed to upload ${t.file.name}: ${msg}`, 'warning');
      }
    }
  }, [stagedTransfers, addToast]);

  // Filter members for the mention popover (used for keyboard nav clamping)
  const filteredMembers = useMemo(() => {
    if (!mentionState) return [];
    const q = mentionState.query.toLowerCase();
    return members
      .filter((m) => {
        const name = (m.user.displayName ?? m.user.username).toLowerCase();
        const username = m.user.username.toLowerCase();
        return name.includes(q) || username.includes(q);
      })
      .slice(0, 8);
  }, [members, mentionState]);

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
        const msg = err instanceof Error ? err.message : 'Upload failed';
        addToast(`Failed to upload ${file.name}: ${msg}`, 'warning');
      }
    },
    [channelId, startUpload, attachToComposer, addToast],
  );

  const removeStagedTransfer = useCallback(
    (transferId: string) => {
      // Revoke any in-session image preview URL.
      const previewUrl = previewUrlsRef.current.get(transferId);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrlsRef.current.delete(transferId);
      }

      const t = useTransferStore.getState().transfers.get(transferId);
      if (t?.state === 'completed') {
        // Fully-uploaded attachment with a finalized DB row. Server-side bytes
        // get cleaned by the unlinked-attachment janitor (1h grace).
        useTransferStore.getState().remove(transferId);
      } else if (t && t.state !== 'aborted') {
        // active/paused/queued/failed: abortUpload tears down any live tus
        // instance AND sends DELETE for orphaned server-side .tus sessions.
        // Then drop the transfer + free the retained File reference.
        abortUpload(transferId);
        useTransferStore.getState().remove(transferId);
      } else {
        // Already 'aborted' (server already cleaned); just drop the record.
        useTransferStore.getState().remove(transferId);
      }
      removeStaged(channelId, transferId);
    },
    [abortUpload, removeStaged, channelId],
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
    const trimmed = draftText.trim();
    if (!trimmed && stagedTransfers.length === 0) return;
    if (isOverLimit) return;

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
      // Text-only path — preserve the legacy optimistic-message flow
      try {
        await sendMessage(channelId, trimmed);
        // Clear draft + reply for this channel
        clearComposer(channelId);
        chatSetReplyTo(null);
        // Reset textarea height + focus
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          textareaRef.current.focus();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to send message';
        addToast(msg, 'warning');
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
    chatSetReplyTo(null);

    // Reset textarea height + focus
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  };

  const selectMention = useCallback(
    (member: MemberWithUser) => {
      if (!mentionState) return;
      const textarea = textareaRef.current;
      const cursorPos = textarea?.selectionStart ?? draftText.length;
      const before = draftText.slice(0, mentionState.startIndex);
      const after = draftText.slice(cursorPos);
      const insertion = `<@${member.userId}> `;
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
    if (mentionState && filteredMembers.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionState((prev) =>
          prev ? { ...prev, selectedIndex: Math.min(prev.selectedIndex + 1, filteredMembers.length - 1) } : null,
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
        const selected = filteredMembers[mentionState.selectedIndex];
        if (selected) selectMention(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionState(null);
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
      void sendMessage(channelId, url);
    },
    [channelId, sendMessage],
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
  // - Desktop: `bottom: 12px` (the historical `md:bottom-3` constant).
  // - Mobile, keyboard closed: `bottom: env(safe-area-inset-bottom) + 6px`
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
  // `md:left-3 md:right-3` on desktop (the historical 12 px inset).
  //
  // `z-[110]` keeps the bubble above any in-chat overlays (mention popover,
  // staged-attachment tiles) but below modals (`z-[300]+`).
  const isMobile = useUIStore((s) => s.isMobile);
  const { keyboardOpen } = useVisualViewportInset();
  const composerStyle: React.CSSProperties | undefined = isMobile
    ? { bottom: keyboardOpen ? '0px' : 'calc(env(safe-area-inset-bottom) + 6px)' }
    : undefined;
  const composerClass =
    'absolute left-2 right-2 z-[110] glass-bubble rounded-[14px]' +
    ' md:left-3 md:right-3 md:bottom-3';

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
  useEffect(() => {
    if (!composerEl) return;
    const target = composerEl.parentElement;
    if (!target) return;
    const el = composerEl;

    const sync = () => {
      // Total clearance = composer height + bottom offset + 12 px gap.
      // We measure the bubble's visual height (including replyTo banner +
      // staged-attachment tiles + textarea autosize) plus the distance from
      // the parent's bottom edge to the bubble's bottom edge (which folds
      // in `env(safe-area-inset-bottom) + 6` on mobile or `12 px` on
      // desktop, whichever the composer's `bottom` resolves to).
      const composerRect = el.getBoundingClientRect();
      const parentRect = target.getBoundingClientRect();
      const bottomOffset = Math.max(0, parentRect.bottom - composerRect.bottom);
      const clearance = Math.round(composerRect.height + bottomOffset + 12);
      target.style.setProperty('--composer-clearance', `${clearance}px`);
    };

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
    const onVv = () => sync();
    if (vv) {
      vv.addEventListener('resize', onVv);
      vv.addEventListener('scroll', onVv);
    }

    return () => {
      ro.disconnect();
      if (vv) {
        vv.removeEventListener('resize', onVv);
        vv.removeEventListener('scroll', onVv);
      }
      target.style.removeProperty('--composer-clearance');
    };
    // Re-arm the observer / listeners when keyboard transitions or the
    // composer's content materially changes — the dependency list is the
    // set of inputs that can change the bubble's height or its bottom
    // offset between renders. The ResizeObserver itself is what catches
    // continuous textarea-autosize growth; these deps just ensure we're
    // attached to the live element after a remount.
  }, [composerEl, isMobile, keyboardOpen, chatReplyTo, stagedTransfers.length]);

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
          <span className="text-txt-tertiary text-[14px]">
            You do not have permission to send messages in this channel
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
            <span className="opacity-60">Replying to</span>
            <span className="font-bold">
              {chatReplyTo.user.displayName ?? chatReplyTo.user.username}
            </span>
          </div>
          <button
            onClick={() => chatSetReplyTo(null)}
            className="text-txt-tertiary hover:text-txt-primary transition-colors"
            aria-label="Cancel reply"
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
        {mentionState && filteredMembers.length > 0 && (
          <MentionPopover
            query={mentionState.query}
            selectedIndex={mentionState.selectedIndex}
            onSelect={selectMention}
            anchorRef={inputContainerRef}
          />
        )}

        {/* Staged transfer tiles */}
        {stagedTransfers.length > 0 && (
          <div className="p-4 flex flex-wrap gap-4 bg-surface-channel/30">
            {stagedTransfers.map((t) => {
              const isImage = t.file.mimetype.startsWith('image/');
              const isFinal = t.state === 'completed';
              const showOverlay = t.state !== 'completed';
              const previewUrl = previewUrlsRef.current.get(t.id);
              return (
                <div
                  key={t.id}
                  className="relative group bg-surface-channel rounded-lg p-2 max-w-[200px] shadow-elevation-low border border-border-hard overflow-hidden"
                >
                  {isImage ? (
                    <div className="w-[150px] h-[150px] bg-surface-input/40 rounded flex items-center justify-center text-txt-tertiary overflow-hidden">
                      {previewUrl ? (
                        <img
                          src={previewUrl}
                          alt={t.file.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <svg className="w-10 h-10 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-txt-secondary py-4 px-2">
                      <svg className="w-8 h-8 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                        />
                      </svg>
                      <span className="truncate max-w-[120px] font-medium">{t.file.name}</span>
                    </div>
                  )}

                  {/* Overlay: progress / paused / failed indicator (driven by AttachmentProgress) */}
                  {showOverlay && (
                    <AttachmentProgress
                      loaded={t.progress.loaded}
                      total={t.progress.total}
                      state={t.state}
                      filename={t.file.name}
                      size="tile"
                      onPause={t.state === 'active' ? () => pauseUpload(t.id) : undefined}
                      onResume={t.state === 'paused' ? () => void resumeUpload(t.id) : undefined}
                      onAbort={() => removeStagedTransfer(t.id)}
                    />
                  )}

                  {/* Final-state remove button (top-right rose chip) — only when completed */}
                  {isFinal && (
                    <button
                      onClick={() => removeStagedTransfer(t.id)}
                      className="absolute -top-2 -right-2 w-7 h-7 bg-accent-rose hover:bg-accent-rose/80 shadow-elevation-high rounded-lg flex items-center justify-center text-white transition-colors z-10"
                      aria-label="Remove attachment"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M5 2a1 1 0 011-1h4a1 1 0 011 1v1h3a1 1 0 110 2h-.08L13 14a2 2 0 01-2 2H5a2 2 0 01-2-2L2.08 5H2a1 1 0 110-2h3V2zm2 0v1h2V2H7z" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-1 md:gap-0 pl-2 md:pl-[10px] pr-2 md:pr-1">
          {/* File attach button */}
          {canAttachFiles && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-10 h-10 md:w-[34px] md:h-[34px] flex items-center justify-center rounded-[6px] text-txt-tertiary hover:text-txt-secondary transition-colors flex-shrink-0"
              title="Attach file"
              aria-label="Attach file"
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
            placeholder={`Message ${channelName.startsWith('@') ? channelName : `#${channelName}`}`}
            className="input-embedded flex-1 py-[10px] px-1 resize-none text-[15px] leading-[1.375rem] max-h-[50vh] scrollbar-thin"
            rows={1}
          />

          {/* Active-upload indicator */}
          {anyActiveOrQueued && (
            <div className="p-3 text-txt-tertiary" title="Uploading…" aria-label="Uploading">
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
              title="Remove or retry the failed attachment to send"
            >
              {failedCount} failed
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
              className={`w-10 h-10 md:w-[34px] md:h-[34px] flex items-center justify-center rounded-[6px] transition-colors flex-shrink-0 ${
                activePopover === 'gif' ? 'text-accent-primary' : 'text-txt-tertiary hover:text-txt-secondary'
              }`}
              title="GIF"
              aria-label="GIF picker"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h15A2.5 2.5 0 0 1 22 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5v-13ZM5.1 14V10h3.2v1.2H6.5v.6h1.6v1.1H6.5V14H5.1Zm4.5 0V10h1.4v4H9.6Zm2.5 0V10h3.2v1.2h-1.8v.5h1.6v1h-1.6V14h-1.4Z" />
              </svg>
            </button>
          )}

          {/* Emoji button */}
          <button
            onClick={() => togglePopover('emoji')}
            className={`w-10 h-10 md:w-[34px] md:h-[34px] flex items-center justify-center rounded-[6px] transition-colors flex-shrink-0 ${
              activePopover === 'emoji' ? 'text-accent-primary' : 'text-txt-tertiary hover:text-txt-secondary'
            }`}
            title="Emoji"
            aria-label="Emoji picker"
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
              className="w-10 h-10 md:w-[34px] md:h-[34px] flex items-center justify-center rounded-[6px] bg-accent-primary hover:bg-accent-primary-hover text-white transition-all duration-150 flex-shrink-0 disabled:opacity-50"
              aria-label="Send message"
              title="Send"
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
