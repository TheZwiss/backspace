import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Avatar } from '../ui/Avatar';
import { ContextMenu } from '../ui/ContextMenu';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { Embed } from './Embed';
function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday)
        return `Today at ${time}`;
    if (isYesterday)
        return `Yesterday at ${time}`;
    return `${date.toLocaleDateString()} ${time}`;
}
function formatHoverTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function Message({ message, isCompact, isFirstInGroup }) {
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(message.content ?? '');
    const [isHovered, setIsHovered] = useState(false);
    const currentUser = useAuthStore((s) => s.user);
    const editMessage = useChatStore((s) => s.editMessage);
    const deleteMessage = useChatStore((s) => s.deleteMessage);
    const members = useServerStore((s) => s.members);
    const openImagePreview = useUIStore((s) => s.openImagePreview);
    const openUserProfile = useUIStore((s) => s.openUserProfile);
    const isAuthor = currentUser?.id === message.userId;
    const memberRole = members.find(m => m.userId === currentUser?.id)?.role;
    const isAdminUser = memberRole === 'admin' || memberRole === 'owner';
    const canDelete = isAuthor || isAdminUser;
    const addReaction = useChatStore((s) => s.addReaction);
    const removeReaction = useChatStore((s) => s.removeReaction);
    const setReplyTo = useChatStore((s) => s.setReplyTo);
    const toggleReaction = (emoji) => {
        const hasReacted = message.reactions?.some(r => r.userId === currentUser?.id && r.emoji === emoji);
        if (hasReacted) {
            removeReaction(message.id, emoji);
        }
        else {
            addReaction(message.id, emoji);
        }
    };
    const reactionGroups = (message.reactions || []).reduce((acc, r) => {
        const group = acc[r.emoji] || { count: 0, me: false };
        group.count++;
        if (r.userId === currentUser?.id) {
            group.me = true;
        }
        acc[r.emoji] = group;
        return acc;
    }, {});
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const firstUrl = message.content?.match(urlRegex)?.[0];
    const handleUsernameClick = (e) => {
        if (!message.user)
            return;
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
            onClick: () => deleteMessage(message.id),
            danger: true,
        });
    }
    const handleEditSubmit = async (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (editContent.trim()) {
                await editMessage(message.id, editContent.trim());
                setIsEditing(false);
            }
        }
        if (e.key === 'Escape') {
            setIsEditing(false);
            setEditContent(message.content ?? '');
        }
    };
    const displayName = message.user.displayName ?? message.user.username;
    const roleColor = (() => {
        const member = members.find(m => m.userId === message.userId);
        if (member?.roles && member.roles.length > 0) {
            return { color: member.roles[0].color };
        }
        if (member?.role === 'owner')
            return { color: '#da373c' };
        if (member?.role === 'admin')
            return { color: '#5865f2' };
        return { color: '#dbdee1' };
    })();
    const replyRoleColor = (msg) => {
        const member = members.find(m => m.userId === msg.userId);
        if (member?.roles && member.roles.length > 0) {
            return { color: member.roles[0].color };
        }
        if (member?.role === 'owner')
            return { color: '#da373c' };
        if (member?.role === 'admin')
            return { color: '#5865f2' };
        return { color: '#dbdee1' };
    };
    const content = (_jsxs("div", { className: `group relative flex px-4 py-0.5 hover:bg-[#2e3035]/30 transition-colors ${isFirstInGroup || message.replyTo ? 'mt-[1.0625rem]' : ''}`, onMouseEnter: () => setIsHovered(true), onMouseLeave: () => setIsHovered(false), children: [message.replyTo && (_jsx("div", { className: "absolute left-[36px] top-[-14px] w-[33px] h-[22px] border-l-2 border-t-2 border-[#4e5058] rounded-tl-[6px] opacity-60" })), _jsx("div", { className: "w-[72px] flex-shrink-0 flex items-start justify-start pl-0.5", children: isFirstInGroup || message.replyTo ? (_jsx("div", { className: "mt-1", children: _jsx(Avatar, { src: message.user.avatar, name: displayName, size: 40, user: message.user, className: "hover:drop-shadow-md transition-all active:translate-y-[1px]" }) })) : (_jsx("span", { className: `text-[11px] text-discord-text-muted opacity-0 group-hover:opacity-100 mt-2 select-none w-full text-center leading-[1.375rem] font-medium`, children: formatHoverTime(message.createdAt) })) }), _jsxs("div", { className: "flex-1 min-w-0 pr-4", children: [message.replyTo && (_jsxs("div", { className: "flex items-center gap-1 mb-1 ml-[-4px] opacity-80 hover:opacity-100 cursor-pointer group/reply", children: [_jsx(Avatar, { src: message.replyTo.user.avatar, name: message.replyTo.user.username, size: 16 }), _jsx("span", { className: "text-[14px] font-bold text-discord-text-header hover:underline", style: message.replyTo ? replyRoleColor(message.replyTo) : undefined, children: message.replyTo.user.displayName ?? message.replyTo.user.username }), _jsx("span", { className: "text-[14px] text-discord-text-normal truncate max-w-[400px] hover:text-white", children: message.replyTo.content })] })), (isFirstInGroup || message.replyTo) && (_jsxs("div", { className: "flex items-baseline gap-2 mb-0.5", children: [_jsx("span", { onClick: handleUsernameClick, className: "font-bold cursor-pointer hover:underline text-[16px] leading-tight", style: roleColor, children: displayName }), _jsx("span", { className: "text-[12px] text-discord-text-muted leading-tight font-medium hover:cursor-default", children: formatTime(message.createdAt) })] })), isEditing ? (_jsxs("div", { className: "mt-1 w-full", children: [_jsx("textarea", { value: editContent, onChange: (e) => setEditContent(e.target.value), onKeyDown: handleEditSubmit, className: "w-full p-3 bg-discord-bg-input rounded-lg text-discord-text-primary outline-none resize-none text-[16px] leading-[1.375rem] shadow-inner", rows: 2, autoFocus: true }), _jsxs("p", { className: "text-[12px] text-discord-text-muted mt-1.5 ml-1", children: ["escape to ", _jsx("button", { onClick: () => setIsEditing(false), className: "text-discord-text-link hover:underline", children: "cancel" }), ' ', "\u2022 enter to ", _jsx("button", { onClick: () => {
                                            if (editContent.trim()) {
                                                editMessage(message.id, editContent.trim());
                                                setIsEditing(false);
                                            }
                                        }, className: "text-discord-text-link hover:underline", children: "save" })] })] })) : (_jsxs("div", { className: "flex flex-col gap-1", children: [message.content && (_jsxs("div", { className: "text-discord-text-normal text-[16px] leading-[1.375rem] break-words whitespace-pre-wrap selection:bg-discord-blurple/30", children: [_jsx(ReactMarkdown, { components: {
                                            p: ({ children }) => _jsx("span", { children: children }),
                                            a: ({ href, children }) => (_jsx("a", { href: href, target: "_blank", rel: "noopener noreferrer", className: "text-discord-text-link hover:underline", children: children })),
                                            code: ({ children }) => (_jsx("code", { className: "px-1 py-0.5 bg-discord-bg-tertiary rounded text-[14px] font-mono", children: children })),
                                            pre: ({ children }) => (_jsx("pre", { className: "mt-1 p-3 bg-discord-bg-tertiary border border-discord-bg-tertiary/50 rounded-md text-[14px] font-mono overflow-x-auto", children: children })),
                                            strong: ({ children }) => _jsx("strong", { className: "font-bold text-discord-text-primary", children: children }),
                                            em: ({ children }) => _jsx("em", { className: "italic", children: children }),
                                        }, children: message.content }), message.editedAt && (_jsx("span", { className: "text-[10px] text-discord-text-muted ml-1 select-none font-medium", children: "(edited)" }))] })), Object.keys(reactionGroups).length > 0 && (_jsx("div", { className: "flex flex-wrap gap-1 mt-1", children: Object.entries(reactionGroups).map(([emoji, { count, me }]) => (_jsxs("button", { onClick: () => toggleReaction(emoji), className: `flex items-center gap-1.5 px-1.5 py-0.5 rounded-[8px] text-[14px] font-medium border transition-colors ${me
                                        ? 'bg-discord-blurple/15 border-discord-blurple text-discord-blurple'
                                        : 'bg-discord-bg-secondary border-transparent text-discord-text-muted hover:border-discord-text-muted/30'}`, children: [_jsx("span", { children: emoji }), _jsx("span", { className: me ? 'text-discord-blurple' : 'text-discord-text-normal', children: count })] }, emoji))) })), !isEditing && firstUrl && _jsx(Embed, { url: firstUrl }), message.attachments.length > 0 && (_jsx("div", { className: "mt-1 grid gap-2", children: message.attachments.map((att) => {
                                    const isImage = att.mimetype.startsWith('image/');
                                    if (isImage) {
                                        return (_jsx("div", { className: "max-w-fit mt-1 rounded-lg overflow-hidden border border-discord-bg-tertiary/50 bg-discord-bg-tertiary/20", children: _jsx("img", { src: `/api/uploads/${att.filename}`, alt: att.originalName, className: "max-w-full max-h-[350px] object-contain cursor-pointer hover:brightness-95 transition-all", onClick: () => openImagePreview(`/api/uploads/${att.filename}`), loading: "lazy" }) }, att.id));
                                    }
                                    return (_jsxs("a", { href: `/api/uploads/${att.filename}`, download: att.originalName, className: "flex items-center gap-3 p-4 bg-discord-bg-secondary/50 rounded-lg border border-discord-bg-tertiary hover:bg-discord-bg-hover transition-all max-w-[400px] mt-1 group/att", children: [_jsx("div", { className: "p-2 bg-discord-bg-tertiary rounded text-discord-text-muted group-hover/att:text-discord-text-primary transition-colors", children: _jsx("svg", { className: "w-8 h-8", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 1.5, d: "M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" }) }) }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-discord-text-link text-[15px] font-medium truncate hover:underline", children: att.originalName }), _jsx("p", { className: "text-[12px] text-discord-text-muted font-medium", children: att.size < 1024 ? `${att.size} B` :
                                                            att.size < 1048576 ? `${(att.size / 1024).toFixed(1)} KB` :
                                                                `${(att.size / 1048576).toFixed(1)} MB` })] })] }, att.id));
                                }) }))] }))] }), isHovered && !isEditing && (_jsxs("div", { className: "absolute -top-[18px] right-4 flex items-center bg-discord-bg-primary border border-discord-bg-tertiary/50 rounded-[4px] shadow-elevation-low overflow-hidden z-10 h-8", children: [_jsx("div", { className: "flex items-center px-1 border-r border-discord-bg-tertiary/50 h-full", children: ['👍', '❤️', '😂', '😮'].map(emoji => (_jsx("button", { onClick: () => toggleReaction(emoji), className: "p-1 hover:bg-discord-modifier-hover rounded transition-colors text-[16px] leading-none", children: emoji }, emoji))) }), _jsx("button", { onClick: () => setReplyTo(message), className: "px-2 h-full text-discord-text-muted hover:text-discord-text-primary hover:bg-discord-modifier-hover transition-all flex items-center justify-center", title: "Reply", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M10 9V5L3 12L10 19V14.9C15 14.9 18.5 16.5 21 20C20 15 17 10 10 9Z" }) }) }), isAuthor && (_jsx("button", { onClick: () => {
                            setEditContent(message.content ?? '');
                            setIsEditing(true);
                        }, className: "px-2 h-full text-discord-text-muted hover:text-discord-text-primary hover:bg-discord-modifier-hover transition-all flex items-center justify-center", title: "Edit", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" }) }) })), canDelete && (_jsx("button", { onClick: () => deleteMessage(message.id), className: "px-2 h-full text-discord-text-muted hover:text-discord-red hover:bg-discord-modifier-hover transition-all flex items-center justify-center", title: "Delete", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" }) }) }))] }))] }));
    if (contextMenuItems.length > 0) {
        return _jsx(ContextMenu, { items: contextMenuItems, children: content });
    }
    return content;
}
