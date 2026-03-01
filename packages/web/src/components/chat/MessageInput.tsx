import React, { useState, useRef, useCallback, useMemo } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { isDmChannel, useServerStore } from '../../stores/serverStore';
import { wsSend } from '../../hooks/useWebSocket';
import { api } from '../../api/client';
import { MentionPopover } from './MentionPopover';
import type { MemberWithUser } from '@backspace/shared';

interface MessageInputProps {
  channelId: string;
  channelName: string;
}

interface MentionState {
  query: string;
  startIndex: number;
  selectedIndex: number;
}

export function MessageInput({ channelId, channelName }: MessageInputProps) {
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const replyTo = useChatStore((s) => s.replyTo);
  const setReplyTo = useChatStore((s) => s.setReplyTo);
  const members = useServerStore((s) => s.members);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Filter members for the mention popover
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
    const isDm = isDmChannel(channelId);
    if (isDm) {
      wsSend({ type: 'dm_typing_start', dmChannelId: channelId });
    } else {
      wsSend({ type: 'typing_start', channelId });
    }
    typingTimeoutRef.current = setTimeout(() => {
      typingTimeoutRef.current = undefined;
    }, 3000);
  }, [channelId]);

  const handleSubmit = async () => {
    const trimmed = content.trim();
    if (!trimmed && files.length === 0) return;

    setIsUploading(true);
    setMentionState(null);
    try {
      // Upload files first
      const attachmentIds: string[] = [];
      for (const file of files) {
        const attachment = await api.uploads.upload(file);
        attachmentIds.push(attachment.id);
      }

      await sendMessage(channelId, trimmed || '', attachmentIds.length > 0 ? attachmentIds : undefined);
      setContent('');
      setFiles([]);

      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      // Clear typing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = undefined;
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setIsUploading(false);
    }
  };

  const selectMention = useCallback((member: MemberWithUser) => {
    if (!mentionState) return;
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? content.length;
    const before = content.slice(0, mentionState.startIndex);
    const after = content.slice(cursorPos);
    const insertion = `<@${member.userId}> `;
    const newContent = before + insertion + after;
    setContent(newContent);
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
  }, [mentionState, content]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Mention popover keyboard navigation
    if (mentionState && filteredMembers.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionState((prev) =>
          prev ? { ...prev, selectedIndex: Math.min(prev.selectedIndex + 1, filteredMembers.length - 1) } : null
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionState((prev) =>
          prev ? { ...prev, selectedIndex: Math.max(prev.selectedIndex - 1, 0) } : null
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
      handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      setFiles((prev) => [...prev, ...pastedFiles]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      setFiles((prev) => [...prev, ...droppedFiles]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setContent(value);

    // Detect @mention trigger
    const textBeforeCursor = value.slice(0, cursorPos);
    const mentionMatch = textBeforeCursor.match(/@([^\s<]*)$/);

    if (mentionMatch) {
      const atIndex = cursorPos - mentionMatch[0].length;
      // Only trigger at word boundary: start of input, after space, or after newline
      const charBefore = atIndex > 0 ? value[atIndex - 1] : undefined;
      if (charBefore === undefined || charBefore === ' ' || charBefore === '\n') {
        setMentionState({
          query: mentionMatch[1]!,
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

  return (
    <div className="px-3 pb-3 flex-shrink-0 md:absolute md:bottom-3 md:left-3 md:right-3 md:z-[110] md:px-0 md:pb-0 md:glass-bubble md:rounded-[14px]">
      {replyTo && (
        <div className="bg-interactive-hover rounded-t-lg px-4 py-2 flex items-center justify-between border-b border-border-hard/50">
          <div className="flex items-center gap-1 text-[14px] text-txt-message truncate">
            <span className="opacity-60">Replying to</span>
            <span className="font-bold">{replyTo.user.displayName ?? replyTo.user.username}</span>
          </div>
          <button
            onClick={() => setReplyTo(null)}
            className="text-txt-tertiary hover:text-txt-primary transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button>
        </div>
      )}
      <div
        className={`relative bg-surface-input md:bg-transparent ${replyTo ? 'rounded-b-lg' : 'rounded-lg md:rounded-none'} overflow-visible`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {/* Mention autocomplete popover */}
        {mentionState && filteredMembers.length > 0 && (
          <MentionPopover
            query={mentionState.query}
            selectedIndex={mentionState.selectedIndex}
            onSelect={selectMention}
          />
        )}

        {/* File previews */}
        {files.length > 0 && (
          <div className="p-4 flex flex-wrap gap-4 bg-surface-channel/30">
            {files.map((file, i) => (
              <div key={i} className="relative group bg-surface-channel rounded-lg p-2 max-w-[200px] shadow-elevation-low border border-border-hard">
                {file.type.startsWith('image/') ? (
                  <img
                    src={URL.createObjectURL(file)}
                    alt={file.name}
                    className="max-h-[150px] rounded object-cover"
                  />
                ) : (
                  <div className="flex items-center gap-2 text-sm text-txt-secondary py-4 px-2">
                    <svg className="w-8 h-8 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="truncate max-w-[120px] font-medium">{file.name}</span>
                  </div>
                )}
                <button
                  onClick={() => removeFile(i)}
                  className="absolute -top-2 -right-2 w-7 h-7 bg-accent-rose hover:bg-accent-rose/80 shadow-elevation-high rounded-lg flex items-center justify-center text-white transition-colors z-10"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M5 2a1 1 0 011-1h4a1 1 0 011 1v1h3a1 1 0 110 2h-.08L13 14a2 2 0 01-2 2H5a2 2 0 01-2-2L2.08 5H2a1 1 0 110-2h3V2zm2 0v1h2V2H7z" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-start px-1">
          {/* File attach button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-3 text-txt-tertiary hover:text-txt-secondary transition-colors sticky top-0"
            title="Attach file"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const selected = Array.from(e.target.files ?? []);
              if (selected.length > 0) {
                setFiles((prev) => [...prev, ...selected]);
              }
              e.target.value = '';
            }}
          />

          {/* Text input */}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={`Message ${channelName.startsWith('@') ? channelName : `#${channelName}`}`}
            className="flex-1 py-[11px] px-1 bg-transparent text-txt-primary placeholder-txt-tertiary/60 outline-none resize-none text-[15px] leading-[1.375rem] max-h-[50vh] scrollbar-thin"
            rows={1}
            disabled={isUploading}
          />

          {/* Send indicator */}
          {isUploading && (
            <div className="p-3 text-txt-tertiary">
              <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          )}

          {/* GIF button */}
          <button className="p-2 text-txt-tertiary hover:text-txt-secondary transition-colors" title="GIF">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h15A2.5 2.5 0 0 1 22 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5v-13ZM5.1 14V10h3.2v1.2H6.5v.6h1.6v1.1H6.5V14H5.1Zm4.5 0V10h1.4v4H9.6Zm2.5 0V10h3.2v1.2h-1.8v.5h1.6v1h-1.6V14h-1.4Z" />
            </svg>
          </button>

          {/* Sticker button */}
          <button className="p-2 text-txt-tertiary hover:text-txt-secondary transition-colors" title="Stickers">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12.5 2C6.81 2 2 6.81 2 12.5S6.81 23 12.5 23c1.31 0 2.56-.25 3.73-.7l5.07-5.07c.45-1.17.7-2.42.7-3.73C22 7.81 17.19 2 12.5 2Zm0 19c-4.69 0-8.5-3.81-8.5-8.5S7.81 4 12.5 4 21 7.81 21 12.5c0 .89-.14 1.74-.4 2.54l-3.56 3.56c-.8.26-1.65.4-2.54.4ZM8 11.5c.83 0 1.5-.67 1.5-1.5S8.83 8.5 8 8.5 6.5 9.17 6.5 10s.67 1.5 1.5 1.5Zm6 0c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5-1.5.67-1.5 1.5.67 1.5 1.5 1.5Zm-1 3.5c-2.33 0-4.31-1.46-5.11-3.5h10.22c-.8 2.04-2.78 3.5-5.11 3.5Z" />
            </svg>
          </button>

          {/* Emoji button */}
          <button className="p-2 text-txt-tertiary hover:text-txt-secondary transition-colors" title="Emoji">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5s.67 1.5 1.5 1.5zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
