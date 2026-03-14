import React, { useState } from 'react';
import type { MessageWithUser } from '@backspace/shared';
import { MarkdownRenderer } from './MarkdownRenderer';
import { Avatar } from '../ui/Avatar';
import { ContextMenu } from '../ui/ContextMenu';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { Embed } from './Embed';
import { Username } from '../ui/Username';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { isSelf, resolveDisplayIdentity } from '../../utils/identity';

interface MessageProps {
  message: MessageWithUser;
  isCompact: boolean;
  isFirstInGroup: boolean;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
  return `${date.toLocaleDateString()} ${time}`;
}

function formatHoverTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function Message({ message, isCompact, isFirstInGroup }: MessageProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content ?? '');
  const [isHovered, setIsHovered] = useState(false);
  const currentUser = useAuthStore((s) => s.user);
  const editMessage = useChatStore((s) => s.editMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const members = useSpaceStore((s) => s.members);
  const openImagePreview = useUIStore((s) => s.openImagePreview);
  const openUserProfile = useUIStore((s) => s.openUserProfile);

  const channelKey = message.channelId || (message as any).dmChannelId;
  const isAuthor = isSelf(message.user, currentUser);
  const channelPermissions = useSpaceStore((s) => s.channelPermissions);
  const myChPerms = channelPermissions.get(message.channelId);
  const canManageMessages = hasPermissionBit(myChPerms, PermissionBits.MANAGE_MESSAGES);
  const canDelete = isAuthor || canManageMessages;
  const isDmMessage = !!(message as any).dmChannelId || !message.channelId;
  const canAddReactions = isDmMessage || hasPermissionBit(myChPerms, PermissionBits.ADD_REACTIONS);

  const addReaction = useChatStore((s) => s.addReaction);
  const removeReaction = useChatStore((s) => s.removeReaction);
  const setReplyTo = useChatStore((s) => s.setReplyTo);

  const isOwnReaction = (r: { userId: string; user?: { id: string; username: string; homeInstance?: string | null } | null }) =>
    r.user ? isSelf(r.user, currentUser) : r.userId === currentUser?.id;

  const toggleReaction = (emoji: string) => {
    const hasReacted = message.reactions?.some(r => isOwnReaction(r) && r.emoji === emoji);
    if (hasReacted) {
      removeReaction(message.id, emoji);
    } else if (canAddReactions) {
      addReaction(message.id, emoji);
    }
  };

  const reactionGroups = (message.reactions || []).reduce((acc, r) => {
    const group = acc[r.emoji] || { count: 0, me: false };
    group.count++;
    if (isOwnReaction(r)) {
      group.me = true;
    }
    acc[r.emoji] = group;
    return acc;
  }, {} as Record<string, { count: number; me: boolean }>);

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const firstUrl = message.content?.match(urlRegex)?.[0];

  const handleUsernameClick = (e: React.MouseEvent) => {
    if (!message.user) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    openUserProfile(message.user, {
      top: Math.min(rect.top, window.innerHeight - 450),
      left: rect.right + 16,
    });
  };

  const contextMenuItems = [];
  if (isAuthor) {
    contextMenuItems.push({
      label: 'Edit Message',
      onClick: () => {
        setEditContent(message.content ?? '');
        setIsEditing(true);
      },
    });
  }
  if (canDelete) {
    contextMenuItems.push({
      label: 'Delete Message',
      onClick: () => deleteMessage(message.id, channelKey),
      danger: true,
    });
  }

  const handleEditSubmit = async (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (editContent.trim()) {
        await editMessage(message.id, editContent.trim(), channelKey);
        setIsEditing(false);
      }
    }
    if (e.key === 'Escape') {
      setIsEditing(false);
      setEditContent(message.content ?? '');
    }
  };

  // Resolve display identity: replicated-self messages show home user's avatar/name
  const displayIdentity = resolveDisplayIdentity(message.user, currentUser);
  const displayName = displayIdentity.displayName ?? displayIdentity.username;

  const spaces = useSpaceStore((s) => s.spaces);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const ownerId = spaces.find(s => s.id === currentSpaceId)?.ownerId;

  const getMemberDisplayColor = (userId: string) => {
    const member = members.find(m => m.userId === userId);
    if (member?.roles && member.roles.length > 0) {
      const sorted = [...member.roles].sort((a, b) => b.position - a.position);
      return { color: sorted[0]!.color };
    }
    if (ownerId && userId === ownerId) return { color: '#fda4af' };
    return { color: '#d8d8de' };
  };

  const roleColor = getMemberDisplayColor(message.userId);

  const replyRoleColor = (msg: { userId: string }) => getMemberDisplayColor(msg.userId);

  // Self-mention highlighting
  const isMentioned = currentUser && message.content?.includes('<@' + currentUser.id + '>');

  const content = (
    <div
      id={`msg-${message.id}`}
      className={`group relative flex gap-4 px-5 py-[3px] transition-colors ${isFirstInGroup || message.replyTo ? 'mt-[1.0625rem]' : ''} ${
        isMentioned
          ? 'bg-accent-amber/10 border-l-2 border-l-accent-amber hover:bg-accent-amber/15'
          : 'hover:bg-[rgba(255,255,255,0.025)]'
      }`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Reply Line */}
      {message.replyTo && (
        <div className="absolute left-[40px] top-[-14px] w-[30px] h-[22px] border-l-2 border-t-2 border-interactive-muted rounded-tl-[6px] opacity-60" />
      )}

      {/* Avatar or timestamp column */}
      <div className="w-10 flex-shrink-0 flex items-start justify-start">
        {isFirstInGroup || message.replyTo ? (
          <div className="mt-0.5">
            <Avatar
              src={displayIdentity.avatar}
              name={displayName}
              size={40}
              user={displayIdentity}
              className="hover:drop-shadow-md transition-all active:translate-y-[1px]"
            />
          </div>
        ) : (
          <span className={`text-[11px] text-txt-tertiary opacity-0 group-hover:opacity-100 select-none w-full text-right whitespace-nowrap leading-[1.375rem]`}>
            {formatHoverTime(message.createdAt)}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {message.replyTo && (() => {
          const replyIdentity = resolveDisplayIdentity(message.replyTo.user, currentUser);
          const replyDisplayName = replyIdentity.displayName ?? replyIdentity.username;
          return (
            <div className="flex items-center gap-1 mb-1 ml-[-4px] opacity-80 hover:opacity-100 cursor-pointer group/reply">
              <Avatar src={replyIdentity.avatar} name={replyDisplayName} size={16} user={replyIdentity} />
              <Username
                username={replyDisplayName}
                className="text-[14px] font-bold text-txt-primary hover:underline"
                style={replyRoleColor(message.replyTo)}
              />
              <span className="text-[14px] text-txt-message truncate max-w-[400px] hover:text-txt-primary">
                {message.replyTo.content}
              </span>
            </div>
          );
        })()}

        {(isFirstInGroup || message.replyTo) && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span onClick={handleUsernameClick}>
              <Username
                username={displayName}
                className="font-semibold cursor-pointer hover:underline text-[15px] leading-tight"
                style={roleColor}
              />
            </span>
            <span className="text-[11px] text-txt-tertiary leading-tight hover:cursor-default">
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}

        {isEditing ? (
          <div className="mt-1 w-full">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleEditSubmit}
              className="input-standard w-full p-3 rounded-lg resize-none text-[15px] leading-[1.5] shadow-inner"
              rows={2}
              autoFocus
            />
            <p className="text-[12px] text-txt-tertiary mt-1.5 ml-1">
              escape to <button onClick={() => setIsEditing(false)} className="text-txt-link hover:underline">cancel</button>
              {' '}&bull; enter to <button onClick={() => {
                if (editContent.trim()) {
                  editMessage(message.id, editContent.trim(), channelKey);
                  setIsEditing(false);
                }
              }} className="text-txt-link hover:underline">save</button>
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {message.content && (
              <div className="text-txt-message text-[15px] leading-[1.5] break-words whitespace-pre-wrap selection:bg-accent-primary/30">
                <MarkdownRenderer content={message.content} />
                {message.editedAt && (
                  <span className="text-[10px] text-txt-tertiary ml-1 select-none font-medium">(edited)</span>
                )}
              </div>
            )}

            {/* Embeds */}
            {!isEditing && firstUrl && <Embed url={firstUrl} />}

            {/* Attachments */}
            {message.attachments && message.attachments.length > 0 && (
              <div className="mt-1 grid gap-2">
                {message.attachments.map((att) => {
                  const isImage = att.mimetype.startsWith('image/');
                  const attUrl = att.filename.startsWith('http') || att.filename.startsWith('/') ? att.filename : `/api/uploads/${att.filename}`;
                  const thumbUrl = att.thumbnailFilename
                    ? (att.thumbnailFilename.startsWith('http') || att.thumbnailFilename.startsWith('/') ? att.thumbnailFilename : `/api/uploads/${att.thumbnailFilename}`)
                    : null;
                  if (isImage) {
                    return (
                      <div key={att.id} className="max-w-fit mt-1 rounded-lg overflow-hidden border border-white/[0.06]">
                        <img
                          src={thumbUrl ?? attUrl}
                          alt={att.originalName}
                          className="max-w-full max-h-[350px] object-contain cursor-pointer hover:brightness-95 transition-all"
                          onClick={() => openImagePreview(attUrl)}
                          loading="lazy"
                        />
                      </div>
                    );
                  }
                  return (
                    <a
                      key={att.id}
                      href={attUrl}
                      download={att.originalName}
                      className="flex items-center gap-3 p-4 bg-surface-channel/50 rounded-lg border border-border-hard hover:bg-interactive-hover transition-all max-w-[400px] mt-1 group/att"
                    >
                      <div className="p-2 bg-surface-base rounded text-txt-tertiary group-hover/att:text-txt-primary transition-colors">
                        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <p className="text-txt-link text-[15px] font-medium truncate hover:underline">{att.originalName}</p>
                        <p className="text-[12px] text-txt-tertiary font-medium">
                          {att.size < 1024 ? `${att.size} B` :
                           att.size < 1048576 ? `${(att.size / 1024).toFixed(1)} KB` :
                           `${(att.size / 1048576).toFixed(1)} MB`}
                        </p>
                      </div>
                    </a>
                  );
                })}
              </div>
            )}

            {/* Reactions */}
            {Object.keys(reactionGroups).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {Object.entries(reactionGroups).map(([emoji, { count, me }]) => (
                  <button
                    key={emoji}
                    onClick={() => toggleReaction(emoji)}
                    className={`glass-pill flex items-center gap-1 rounded-[6px] cursor-pointer transition-all duration-[120ms] ease-out ${
                      me ? 'glass-pill-mine' : ''
                    }`}
                    style={{ padding: '2px 8px', fontSize: '13px', lineHeight: 1 }}
                  >
                    <span style={{ fontSize: '14px', lineHeight: 1 }}>{emoji}</span>
                    <span className={`font-semibold ${me ? 'text-accent-mint' : 'text-txt-secondary'}`} style={{ fontSize: '12px' }}>{count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action buttons on hover */}
      {isHovered && !isEditing && (
        <div className="absolute -top-[18px] right-4 flex items-center glass rounded-[10px] overflow-hidden z-10 h-8">
          {canAddReactions && (
            <div className="flex items-center px-1 border-r border-white/[0.06] h-full">
              {['👍', '❤️', '😂', '😮'].map(emoji => (
                <button
                  key={emoji}
                  onClick={() => toggleReaction(emoji)}
                  className="p-1 hover:bg-interactive-hover rounded transition-colors text-[16px] leading-none"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => setReplyTo(message)}
            className="px-2 h-full text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover transition-all flex items-center justify-center"
            title="Reply"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 9V5L3 12L10 19V14.9C15 14.9 18.5 16.5 21 20C20 15 17 10 10 9Z" />
            </svg>
          </button>
          {isAuthor && (
            <button
              onClick={() => {
                setEditContent(message.content ?? '');
                setIsEditing(true);
              }}
              className="px-2 h-full text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover transition-all flex items-center justify-center"
              title="Edit"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => deleteMessage(message.id, channelKey)}
              className="px-2 h-full text-txt-tertiary hover:text-txt-danger hover:bg-interactive-hover transition-all flex items-center justify-center"
              title="Delete"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );

  if (contextMenuItems.length > 0) {
    return <ContextMenu items={contextMenuItems}>{content}</ContextMenu>;
  }

  return content;
}
