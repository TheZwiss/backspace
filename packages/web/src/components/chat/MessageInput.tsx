import { useMentionComposer } from './useMentionComposer';
import { useComposerMention } from './useComposerMention';
import { MentionTextarea } from './MentionTextarea';
import { layoutRect } from '../../platform/interfaceScale';
import React, { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chatStore';
import { isDmChannel, useIsDmChannel, getChannelOrigin, useSpaceStore } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { MentionPopover } from './MentionPopover';
import { CommandOptionPopover, CommandPopover, CommandSubcommandPopover, CommandValuePopover, type CommandValueCandidate } from './CommandPopover';
import { placeCaret } from './placeCaret';
import { TypingIndicator } from './TypingIndicator';
import { InputPopover, type InputPopoverTab } from './InputPopover';
import { StagedTransferTiles } from './StagedTransferTiles';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { MAX_MESSAGE_LENGTH } from '@backspace/shared';
import type { BotCommandListing, BotCommandOption } from '@backspace/shared';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useComposerStore } from '../../stores/composerStore';
import { useTransferStore, type Transfer } from '../../stores/transferStore';
import { usePendingMessageStore } from '../../stores/pendingMessageStore';
import { putHandle, supportsFsHandles, supportsDnDHandles } from '../../utils/idbHandles';
import { useVisualViewportInset } from '../../hooks/useVisualViewportInset';
import { useAuthStore } from '../../stores/authStore';
import { selfIdentityOf, spaceMemberName } from '../../utils/identity';
import { findLastOwnEditableMessage } from './messageEditing';
import { getApiForOrigin } from '../../utils/crossStoreResolvers';
import { describeError } from '../../i18n/errors';
import { HttpError } from '../../api/client';
import {
  argumentFrames,
  commandPath,
  commandRows,
  draftCommandName,
  headDraft,
  spaceArguments,
  parseCommandArgs,
  remainingOptions,
  subcommandMatches,
  suggestOptions,
  suggestSubcommand,
  suggestValue,
  type CommandArgContext,
  type CommandRow,
  type OptionSuggest,
  type SubcommandSuggest,
  type ValueSuggest,
} from '../../utils/commandArgs';
import { filterMentionCandidates, useChannelMentionCandidates } from '../../utils/channelUser';

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

interface CommandState {
  query: string;
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
  const removeStaged = useComposerStore((s) => s.removeStaged);
  const clearComposer = useComposerStore((s) => s.clear);

  // Transfer state — subscribe to the whole map so progress/state updates re-render
  const transfers = useTransferStore((s) => s.transfers);
  const startUpload = useTransferStore((s) => s.startUpload);
  const abortUpload = useTransferStore((s) => s.abortUpload);

  // UI-only state stays local
  const [activePopover, setActivePopover] = useState<InputPopoverTab | null>(null);
  // Slash commands of the bots in this chat, loaded the first time the composer starts with "/".
  const [commandState, setCommandState] = useState<CommandState | null>(null);
  const [chatCommands, setChatCommands] = useState<BotCommandListing[] | null>(null);
  const pickedCommandRef = useRef<BotCommandListing | null>(null);
  const [optionSuggest, setOptionSuggest] = useState<OptionSuggest | null>(null);
  // The value popover of a user, role, channel or boolean option being typed.
  const [valueSuggest, setValueSuggest] = useState<ValueSuggest | null>(null);
  // The subcommand popover: the next step of a command's path (`/music queue add`).
  const [subcommandSuggest, setSubcommandSuggest] = useState<SubcommandSuggest | null>(null);
  const commandsRequestRef = useRef<Promise<BotCommandListing[]> | null>(null);
  // True while an Enter that invokes a slash command is on its way: a second Enter must not invoke it again.
  const commandSubmitRef = useRef(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useComposerMention(channelId, textareaRef);
  const mentionAnchorRef = useRef<HTMLSpanElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  // Note: this ref is intentionally typed `HTMLDivElement | null` (mutable
  // ref shape) rather than the more restrictive `RefObject<HTMLDivElement>`
  // because we assign to `.current` from a callback ref below — the
  // callback ref bridges the imperative `popoverAnchorRef` consumers
  // (InputPopover anchoring) and the state-backed
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
  const { mentionState, setMentionState, mentionMatches, mentionModel, modelFor,
    selectMention, handleMentionKey, updateMention } = useMentionComposer({ channelId, draftText, textareaRef });

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
  }, [channelId, setMentionState]);

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

  // New chat, new command list.
  useEffect(() => {
    setChatCommands(null);
    setCommandState(null);
    setOptionSuggest(null);
    setValueSuggest(null);
    setSubcommandSuggest(null);
    commandsRequestRef.current = null;
    pickedCommandRef.current = null;
  }, [channelId]);

  // The commands of the bots in this chat, shared by every caller. `fresh` asks the
  // server again (a bot may have registered, changed or lost commands, or joined or
  // left the chat): the shown list stays until the answer arrives, and the newest
  // request wins.
  const loadChatCommands = useCallback((fresh = false): Promise<BotCommandListing[]> => {
    const existing = commandsRequestRef.current;
    if (existing && !fresh) return existing;
    const request: Promise<BotCommandListing[]> = getApiForOrigin(getChannelOrigin(channelId)).commands
      .forChat(isDm ? { dmChannelId: channelId } : { channelId })
      .then((res) => res.commands)
      .catch(() => [] as BotCommandListing[])
      .then((commands) => {
        if (commandsRequestRef.current === request) setChatCommands(commands);
        return commands;
      });
    commandsRequestRef.current = request;
    return request;
  }, [channelId, isDm]);

  // A command pasted before the list arrived is spaced once it does, as if typed
  // now. A layout effect, so the new text is written before the caret is put back.
  useLayoutEffect(() => {
    if (!chatCommands) return;
    const draft = useComposerStore.getState().get(channelId).draftText;
    const name = draftCommandName(draft);
    const command = name === null ? undefined : chatCommands.find((c) => c.name === name);
    if (!command) return;
    const textarea = textareaRef.current;
    const model = modelFor(draft);
    const caret = textarea ? model.toWire(textarea.selectionStart) : draft.length;
    const spaced = spaceArguments(draft, command, caret);
    if (spaced.text === draft) return;
    setDraft(channelId, spaced.text);
    if (textarea && document.activeElement === textarea) placeCaret(textareaRef, modelFor(spaced.text).toDisplay(spaced.caret));
  }, [chatCommands, channelId, modelFor, setDraft]);

  // The option popover's rows: the options of the typed command not written yet, required first.
  const optionMatches = useMemo(() => {
    if (!optionSuggest || draftCommandName(draftText) !== optionSuggest.command.name) return [];
    return remainingOptions(optionSuggest.command, draftText)
      .filter((o) => o.name.startsWith(optionSuggest.query))
      .slice(0, 10);
  }, [optionSuggest, draftText]);

  const selectOption = useCallback(
    (option: BotCommandOption) => {
      if (!optionSuggest) return;
      // The composer's spacing gives the argument's capsule room around it.
      const written = draftText.slice(0, optionSuggest.startIndex) + option.name + ':';
      const { text } = spaceArguments(written, optionSuggest.command, written.length);
      setDraft(channelId, text);
      setOptionSuggest(null);
      // The option's values are offered straight away when it has any to offer.
      setValueSuggest(chatCommands ? suggestValue(text, chatCommands, optionSuggest.command) : null);
      // The draft holds mention tokens; the textarea shows names.
      const caret = modelFor(text).toDisplay(text.length);
      placeCaret(textareaRef, caret, true);
    },
    [optionSuggest, draftText, setDraft, channelId, chatCommands, modelFor],
  );

  // What a typed user, role or channel value may name: the chat's people, and its space's roles and channels.
  const chatPeople = useChannelMentionCandidates(channelId);
  const chatSpaceId = useSpaceStore((s) => s.channelToSpaceMap.get(channelId));
  const spaceRoles = useSpaceStore((s) => s.roles);
  const spaceChannels = useSpaceStore((s) => s.channels);
  const chatRoles = useMemo(
    () => (chatSpaceId === undefined ? [] : spaceRoles.filter((r) => r.spaceId === chatSpaceId)),
    [chatSpaceId, spaceRoles],
  );
  const commandContext = useMemo<CommandArgContext>(() => ({
    users: chatPeople.map((c) => ({
      id: c.userId,
      names: [c.user.username, c.user.displayName ?? '', c.member?.nickname ?? ''].filter((n) => n.length > 0),
    })),
    roles: chatRoles,
    channels: chatSpaceId === undefined ? [] : spaceChannels.filter((c) => c.spaceId === chatSpaceId),
  }), [chatPeople, chatRoles, chatSpaceId, spaceChannels]);

  /**
   * The toast for a refused invocation. A value the server refused names its
   * option (`details.field` is `options.<name>`); the server's own reason is
   * English, so the option name is what is shown.
   */
  const describeCommandError = (err: unknown): string => {
    const field = err instanceof HttpError && err.code === 'validation_failed' ? err.details?.field : undefined;
    if (typeof field === 'string' && field.startsWith('options.')) {
      return t('chat:commands.invalidOption', { option: field.slice('options.'.length) });
    }
    if (field === 'subcommand') return t('chat:commands.subcommandRefused');
    return err instanceof Error ? describeError(err) : t('chat:commands.failed');
  };

  // The arguments of a command draft, drawn as boxes by the composer's mirror.
  const argumentBoxes = useMemo(() => {
    const head = /^\/([a-z0-9_-]+)\s/i.exec(draftText);
    if (!head || !chatCommands) return [];
    const name = head[1]!.toLowerCase();
    const picked = pickedCommandRef.current;
    const command = picked && picked.name === name ? picked : chatCommands.find((c) => c.name === name);
    if (!command) return [];
    const units = mentionModel.parts.filter((p) => p.mention).map((p) => ({ start: p.start, end: p.start + p.text.length }));
    return argumentFrames(mentionModel.text, command, units, commandContext);
  }, [draftText, chatCommands, mentionModel, commandContext]);

  // The value popover's rows.
  const valueMatches = useMemo((): CommandValueCandidate[] => {
    // Like the option popover, it follows the draft: once the command is gone, so is the list.
    if (!valueSuggest || draftCommandName(draftText) !== valueSuggest.command.name) return [];
    const { option, query } = valueSuggest;
    if (option.choices && option.choices.length > 0) {
      // The list shows a choice's name and writes it; the parser hands the bot its value.
      return option.choices
        .filter((c) => c.name.toLowerCase().includes(query) || String(c.value).toLowerCase().includes(query))
        .map((c) => ({
          key: String(c.value),
          label: c.name,
          detail: String(c.value) === c.name ? undefined : String(c.value),
          insert: /\s/.test(c.name) ? `"${c.name}"` : c.name,
        }));
    }
    if (option.type === 'boolean') {
      return ['true', 'false'].filter((v) => v.startsWith(query)).map((v) => ({ key: v, label: v, insert: v }));
    }
    if (option.type === 'user') {
      return filterMentionCandidates(chatPeople, query).map((c) => ({
        key: c.userId,
        label: spaceMemberName(c.member, c.user),
        detail: `@${c.user.username}`,
        insert: `<@${c.userId}>`,
      }));
    }
    if (option.type === 'role') {
      return chatRoles
        .filter((r) => r.name.toLowerCase().includes(query))
        .sort((a, b) => b.position - a.position)
        .slice(0, 25)
        .map((r) => ({ key: r.id, label: r.name, insert: `<@&${r.id}>` }));
    }
    return commandContext.channels
      .filter((c) => (!option.channelTypes || option.channelTypes.includes(c.type)) && c.name.toLowerCase().includes(query))
      .slice(0, 25)
      // A name with a space goes in quotes, or the value would end at the space.
      .map((c) => ({ key: c.id, label: `#${c.name}`, detail: c.type, insert: /\s/.test(c.name) ? `"#${c.name}"` : `#${c.name}` }));
  }, [valueSuggest, draftText, chatPeople, chatRoles, commandContext]);

  const selectValue = useCallback(
    (candidate: CommandValueCandidate) => {
      if (!valueSuggest) return;
      const text = draftText.slice(0, valueSuggest.startIndex) + candidate.insert;
      setDraft(channelId, text);
      // Nothing more is offered until a space is typed, so Enter right after a
      // picked value sends the command.
      setValueSuggest(null);
      setOptionSuggest(null);
      setSubcommandSuggest(null);
      const caret = modelFor(text).toDisplay(text.length);
      placeCaret(textareaRef, caret, true);
    },
    [valueSuggest, draftText, setDraft, channelId, modelFor],
  );

  // The command popover's rows: each command, or each subcommand of one (`/music queue add`).
  const commandMatches = useMemo(() => {
    if (!commandState || !chatCommands) return [];
    const q = commandState.query.toLowerCase();
    return chatCommands.filter((c) => c.name.includes(q)).flatMap(commandRows).slice(0, 25);
  }, [commandState, chatCommands]);

  /** Writes the head of a command or subcommand and its required options, and opens what comes next. */
  const writeHead = useCallback(
    (command: BotCommandListing, path: readonly string[], options: readonly BotCommandOption[]) => {
      pickedCommandRef.current = command;
      // Required options go into the text straight away, ready to be filled in.
      const { text, caret } = headDraft(command, path, options);
      setDraft(channelId, text);
      setCommandState(null);
      setSubcommandSuggest(null);
      // With required options the caret goes behind the first one; without, the optional ones are offered.
      const required = options.some((o) => o.required);
      setOptionSuggest(!required && chatCommands ? suggestOptions(text, chatCommands, command) : null);
      // A single required option of a picked type opens its value list at once.
      setValueSuggest(caret === text.length && chatCommands ? suggestValue(text, chatCommands, command) : null);
      placeCaret(textareaRef, caret, true);
    },
    [setDraft, channelId, chatCommands],
  );

  const selectCommand = useCallback(
    (row: CommandRow) => writeHead(row.command, row.path, row.options),
    [writeHead],
  );

  // The subcommand popover's rows: the next step of the path whose name starts with what is typed.
  const subcommandRows = useMemo(
    () => (subcommandSuggest ? subcommandMatches(subcommandSuggest, draftText).slice(0, 25) : []),
    [subcommandSuggest, draftText],
  );

  const selectSubcommand = useCallback(
    (step: BotCommandOption) => {
      if (!subcommandSuggest) return;
      const { command } = subcommandSuggest;
      const path = [...(commandPath(draftText, command)?.path ?? []), step.name];
      if (step.type === 'subcommand') {
        writeHead(command, path, step.options ?? []);
        return;
      }
      // A group: its subcommands are offered next.
      const text = ['/' + command.name, ...path].join(' ') + ' ';
      setDraft(channelId, text);
      setSubcommandSuggest(chatCommands ? suggestSubcommand(text, chatCommands, command) : null);
      placeCaret(textareaRef, text.length, true);
    },
    [subcommandSuggest, draftText, writeHead, setDraft, channelId, chatCommands],
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

    // A slash command of a bot in this chat: invoke it instead of posting the text.
    const commandHead = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
    if (commandHead && stagedTransfers.length === 0) {
      // An Enter while the previous one is still resolving or invoking this command does nothing.
      if (commandSubmitRef.current) return;
      commandSubmitRef.current = true;
      try {
        const name = commandHead[1]!.toLowerCase();
        const picked = pickedCommandRef.current;
        const find = (list: BotCommandListing[]): BotCommandListing | undefined =>
          (picked && picked.name === name ? picked : list.find((c) => c.name === name));
        // A pasted command may be sent before the list has loaded: wait for it.
        const command = find(chatCommands ?? await loadChatCommands());
        if (command) {
          // A command with subcommands is sent only with a path that reaches one.
          const head = commandPath(trimmed, command, true);
          if (!head?.options) {
            addToast(t('chat:commands.chooseSubcommand', { names: (head?.next ?? []).map((o) => o.name).join(', ') }), 'warning');
            return;
          }
          const parsed = parseCommandArgs({ options: head.options }, trimmed.slice(head.headEnd), commandContext);
          if (!parsed.ok) {
            addToast(t('chat:commands.extraText', { text: parsed.extra }), 'warning');
            return;
          }
          // Consume the draft before the request, as a message send does; put it back on failure.
          pickedCommandRef.current = null;
          clearComposer(channelId);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.focus();
          }
          try {
            await getApiForOrigin(getChannelOrigin(channelId)).commands.invoke({
              botId: command.botId,
              command: command.name,
              ...(head.path.length > 0 ? { subcommand: head.path } : {}),
              options: parsed.options,
              ...(isDm ? { dmChannelId: channelId } : { channelId }),
            });
          } catch (err) {
            const currentDraft = useComposerStore.getState().get(channelId).draftText;
            setDraft(channelId, submittedDraft + (currentDraft ? '\n' + currentDraft : ''));
            addToast(describeCommandError(err), 'warning');
          }
          return;
        }
      } finally {
        commandSubmitRef.current = false;
      }
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

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // IME confirmation must not select a candidate or send the message.
    if (e.nativeEvent.isComposing) return;
    // Value popover of a typed option: the same keys as the option popover.
    if (valueSuggest && valueMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setValueSuggest((prev) => (prev
          ? { ...prev, touched: true, selectedIndex: Math.min(prev.selectedIndex + 1, valueMatches.length - 1) }
          : null));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setValueSuggest((prev) => (prev
          ? { ...prev, touched: true, selectedIndex: Math.max(prev.selectedIndex - 1, 0) }
          : null));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && valueSuggest.touched)) {
        e.preventDefault();
        const selected = valueMatches[Math.min(valueSuggest.selectedIndex, valueMatches.length - 1)];
        if (selected) selectValue(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setValueSuggest(null);
        return;
      }
    }

    // Subcommand popover: the same keys as the option popover.
    if (subcommandSuggest && subcommandRows.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSubcommandSuggest((prev) => (prev
          ? { ...prev, touched: true, selectedIndex: Math.min(prev.selectedIndex + 1, subcommandRows.length - 1) }
          : null));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSubcommandSuggest((prev) => (prev
          ? { ...prev, touched: true, selectedIndex: Math.max(prev.selectedIndex - 1, 0) }
          : null));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && subcommandSuggest.touched)) {
        e.preventDefault();
        const selected = subcommandRows[Math.min(subcommandSuggest.selectedIndex, subcommandRows.length - 1)];
        if (selected) selectSubcommand(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSubcommandSuggest(null);
        return;
      }
    }

    // Option popover for the typed command: arrows move, Tab picks, Enter picks only after an arrow.
    if (optionSuggest && optionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setOptionSuggest((prev) => (prev
          ? { ...prev, touched: true, selectedIndex: Math.min(prev.selectedIndex + 1, optionMatches.length - 1) }
          : null));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setOptionSuggest((prev) => (prev
          ? { ...prev, touched: true, selectedIndex: Math.max(prev.selectedIndex - 1, 0) }
          : null));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && optionSuggest.touched)) {
        e.preventDefault();
        const selected = optionMatches[optionSuggest.selectedIndex];
        if (selected) selectOption(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setOptionSuggest(null);
        return;
      }
    }

    // Slash command popover keyboard navigation
    if (commandState && commandMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCommandState((prev) => (prev ? { ...prev, selectedIndex: Math.min(prev.selectedIndex + 1, commandMatches.length - 1) } : null));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCommandState((prev) => (prev ? { ...prev, selectedIndex: Math.max(prev.selectedIndex - 1, 0) } : null));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = commandMatches[commandState.selectedIndex];
        if (selected) selectCommand(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCommandState(null);
        return;
      }
    }

    if (handleMentionKey(e)) return;

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
    updateMention(e);
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;

    // A pasted or typed command is looked up as soon as the text starts with "/", and
    // asked for again at the start of every new command, so the list follows the bots.
    if (value.startsWith('/') && (chatCommands === null || !draftText.startsWith('/'))) {
      void loadChatCommands(chatCommands !== null);
    }

    // Detect a slash command: "/" at the very start of the message, no space typed yet.
    const commandMatch = /^\/([a-z0-9_-]*)$/i.exec(value.slice(0, cursorPos));
    if (commandMatch && cursorPos === value.length) {
      // The command list is loaded above, as soon as the text starts with "/".
      setCommandState({ query: commandMatch[1] ?? '', selectedIndex: 0 });
    } else {
      setCommandState(null);
    }

    // After "/name " the options of that command are offered, and the values of a
    // user, role, channel or boolean option (only while the caret is at the end).
    // Both read the draft as stored, mention tokens and all, so offsets match it.
    const updated = mentionModel.update(value, cursorPos);
    let wire = updated.value;
    let atEnd = cursorPos === value.length;

    // Typed or pasted arguments get the composer's spacing, as picked ones do,
    // so their capsules have room. Only text that grew is respaced: a deleted
    // space stays deleted, and an IME composition is left alone.
    const named = chatCommands ? draftCommandName(wire) : null;
    const picked = pickedCommandRef.current;
    const typedCommand = named === null ? undefined
      : picked && picked.name === named ? picked : chatCommands?.find((c) => c.name === named);
    if (typedCommand && value.length > mentionModel.text.length && !(e.nativeEvent as InputEvent).isComposing) {
      const spaced = spaceArguments(wire, typedCommand, updated.wireCursor);
      if (spaced.text !== wire || spaced.caret !== updated.wireCursor) {
        wire = spaced.text;
        atEnd = spaced.caret === wire.length;
        setDraft(channelId, wire);
        placeCaret(textareaRef, modelFor(wire).toDisplay(spaced.caret));
      }
    }

    // Names typed by hand are read against the chat, so a name of several words
    // stays one value. While a value is being typed only its list is offered.
    const commands = atEnd ? chatCommands : null;
    const values = commands ? suggestValue(wire, commands, pickedCommandRef.current, commandContext) : null;
    const steps = commands ? suggestSubcommand(wire, commands, pickedCommandRef.current) : null;
    setValueSuggest(values);
    setSubcommandSuggest(steps);
    setOptionSuggest(commands && !values && !steps ? suggestOptions(wire, commands, pickedCommandRef.current, commandContext) : null);


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
      // A selection that touches a mention replaces its whole token.
      const { value: newContent, wireCursor } = mentionModel.replace({
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        text: emoji.native,
      });
      setDraft(channelId, newContent);

      // Restore cursor position after the emoji
      const newCursorPos = modelFor(newContent).toDisplay(wireCursor);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.selectionStart = newCursorPos;
        textarea.selectionEnd = newCursorPos;
      });
    },
    [draftText, setDraft, channelId, mentionModel, modelFor],
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

  // Combined ref: keep `popoverAnchorRef` populated (InputPopover anchor +
  // scroll-into-view targets) AND notify the
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
        {/* Slash command popover */}
        {commandState && commandMatches.length > 0 && (
          <CommandPopover
            commands={commandMatches}
            selectedIndex={commandState.selectedIndex}
            onSelect={selectCommand}
            anchorRef={inputContainerRef}
            origin={getChannelOrigin(channelId)}
          />
        )}

        {/* Slash command subcommand popover */}
        {subcommandSuggest && subcommandRows.length > 0 && (
          <CommandSubcommandPopover
            steps={subcommandRows}
            selectedIndex={Math.min(subcommandSuggest.selectedIndex, subcommandRows.length - 1)}
            onSelect={selectSubcommand}
            anchorRef={inputContainerRef}
          />
        )}

        {/* Slash command option popover */}
        {optionSuggest && optionMatches.length > 0 && (
          <CommandOptionPopover
            options={optionMatches}
            selectedIndex={Math.min(optionSuggest.selectedIndex, optionMatches.length - 1)}
            onSelect={selectOption}
            anchorRef={inputContainerRef}
          />
        )}

        {/* Slash command value popover */}
        {valueSuggest && valueMatches.length > 0 && (
          <CommandValuePopover
            optionName={valueSuggest.option.name}
            candidates={valueMatches}
            selectedIndex={Math.min(valueSuggest.selectedIndex, valueMatches.length - 1)}
            onSelect={selectValue}
            anchorRef={inputContainerRef}
          />
        )}

        {/* Mention autocomplete popover */}
        {mentionState && mentionMatches.length > 0 && (
          <MentionPopover
            candidates={mentionMatches}
            selectedIndex={mentionState.selectedIndex}
            onSelect={selectMention}
            anchorRef={mentionAnchorRef}
          />
        )}

        <StagedTransferTiles
          stagedTransfers={stagedTransfers}
          previewUrls={previewUrlsRef.current}
          onRemove={removeStagedTransfer}
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
          <MentionTextarea
            textareaRef={textareaRef}
            mentionAnchorRef={mentionAnchorRef}
            mentionStart={mentionState?.startIndex}
            model={mentionModel}
            frames={argumentBoxes}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={canAttachFiles ? handlePaste : undefined}
            placeholder={
              placeholder ??
              (channelName.startsWith('@')
                ? t('chat:composer.placeholder.dm', { name: channelName.slice(1) })
                : t('chat:composer.placeholder.channel', { name: channelName }))
            }
            className="input-embedded relative block w-full py-[10px] px-1 resize-none text-[15px] leading-[1.375rem] max-h-[calc(50*var(--app-vh))] scrollbar-thin"
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
