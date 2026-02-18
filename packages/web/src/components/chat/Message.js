import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Avatar } from '../ui/Avatar';
import { ContextMenu } from '../ui/ContextMenu';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
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
    const isAuthor = currentUser?.id === message.userId;
    const memberRole = members.find(m => m.userId === currentUser?.id)?.role;
    const isAdminUser = memberRole === 'admin' || memberRole === 'owner';
    const canDelete = isAuthor || isAdminUser;
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
        if (member?.role === 'owner')
            return 'text-discord-red';
        if (member?.role === 'admin')
            return 'text-discord-blurple';
        return 'text-white';
    })();
    const content = (_jsxs("div", { className: `group relative flex px-4 py-0.5 hover:bg-discord-bg-hover/30 ${isFirstInGroup ? 'mt-4' : ''}`, onMouseEnter: () => setIsHovered(true), onMouseLeave: () => setIsHovered(false), children: [_jsx("div", { className: "w-[72px] flex-shrink-0 flex items-start justify-center", children: isFirstInGroup ? (_jsx(Avatar, { src: message.user.avatar, name: displayName, size: 40, className: "mt-0.5 cursor-pointer" })) : (_jsx("span", { className: `text-[11px] text-discord-text-muted opacity-0 group-hover:opacity-100 mt-1 select-none`, children: formatHoverTime(message.createdAt) })) }), _jsxs("div", { className: "flex-1 min-w-0", children: [isFirstInGroup && (_jsxs("div", { className: "flex items-baseline gap-2", children: [_jsx("span", { className: `font-medium cursor-pointer hover:underline ${roleColor}`, children: displayName }), _jsx("span", { className: "text-xs text-discord-text-muted", children: formatTime(message.createdAt) })] })), isEditing ? (_jsxs("div", { className: "mt-1", children: [_jsx("textarea", { value: editContent, onChange: (e) => setEditContent(e.target.value), onKeyDown: handleEditSubmit, className: "w-full p-2 bg-discord-bg-input rounded text-discord-text-primary outline-none resize-none text-sm", rows: 2, autoFocus: true }), _jsxs("p", { className: "text-xs text-discord-text-muted mt-1", children: ["escape to ", _jsx("button", { onClick: () => setIsEditing(false), className: "text-[#00aff4] hover:underline", children: "cancel" }), ' ', "\u2022 enter to ", _jsx("button", { onClick: () => {
                                            if (editContent.trim()) {
                                                editMessage(message.id, editContent.trim());
                                                setIsEditing(false);
                                            }
                                        }, className: "text-[#00aff4] hover:underline", children: "save" })] })] })) : (_jsxs(_Fragment, { children: [message.content && (_jsxs("div", { className: "text-discord-text-primary text-sm leading-[1.375rem] break-words", children: [_jsx(ReactMarkdown, { components: {
                                            p: ({ children }) => _jsx("span", { children: children }),
                                            a: ({ href, children }) => (_jsx("a", { href: href, target: "_blank", rel: "noopener noreferrer", className: "text-[#00aff4] hover:underline", children: children })),
                                            code: ({ children }) => (_jsx("code", { className: "px-1 py-0.5 bg-discord-bg-tertiary rounded text-sm font-mono", children: children })),
                                            pre: ({ children }) => (_jsx("pre", { className: "mt-1 p-3 bg-discord-bg-tertiary rounded text-sm font-mono overflow-x-auto", children: children })),
                                            strong: ({ children }) => _jsx("strong", { className: "font-bold", children: children }),
                                            em: ({ children }) => _jsx("em", { className: "italic", children: children }),
                                        }, children: message.content }), message.editedAt && (_jsx("span", { className: "text-[10px] text-discord-text-muted ml-1", children: "(edited)" }))] })), message.attachments.length > 0 && (_jsx("div", { className: "mt-1 space-y-1", children: message.attachments.map((att) => {
                                    const isImage = att.mimetype.startsWith('image/');
                                    if (isImage) {
                                        return (_jsx("div", { className: "max-w-[400px]", children: _jsx("img", { src: `/api/uploads/${att.filename}`, alt: att.originalName, className: "max-w-full max-h-[300px] rounded cursor-pointer hover:shadow-lg transition-shadow", onClick: () => openImagePreview(`/api/uploads/${att.filename}`), loading: "lazy" }) }, att.id));
                                    }
                                    return (_jsxs("a", { href: `/api/uploads/${att.filename}`, download: att.originalName, className: "flex items-center gap-2 p-3 bg-discord-bg-secondary rounded border border-discord-bg-tertiary hover:bg-discord-bg-hover transition-colors max-w-[400px]", children: [_jsx("svg", { className: "w-6 h-6 text-discord-text-muted flex-shrink-0", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, d: "M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" }) }), _jsxs("div", { className: "min-w-0", children: [_jsx("p", { className: "text-[#00aff4] text-sm truncate hover:underline", children: att.originalName }), _jsx("p", { className: "text-xs text-discord-text-muted", children: att.size < 1024 ? `${att.size} B` :
                                                            att.size < 1048576 ? `${(att.size / 1024).toFixed(1)} KB` :
                                                                `${(att.size / 1048576).toFixed(1)} MB` })] })] }, att.id));
                                }) }))] }))] }), isHovered && !isEditing && contextMenuItems.length > 0 && (_jsxs("div", { className: "absolute -top-3 right-4 flex items-center bg-discord-bg-secondary border border-discord-bg-tertiary rounded shadow-md", children: [isAuthor && (_jsx("button", { onClick: () => {
                            setEditContent(message.content ?? '');
                            setIsEditing(true);
                        }, className: "p-1.5 text-discord-text-muted hover:text-discord-text-primary transition-colors", title: "Edit", children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", children: _jsx("path", { d: "M13.293 1.293a1 1 0 011.414 1.414l-9 9a1 1 0 01-.39.242l-3 1a1 1 0 01-1.266-1.265l1-3a1 1 0 01.242-.391l9-9zM12 3l1 1-8 8-1.5.5.5-1.5L12 3z" }) }) })), canDelete && (_jsx("button", { onClick: () => deleteMessage(message.id), className: "p-1.5 text-discord-text-muted hover:text-discord-red transition-colors", title: "Delete", children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor", children: _jsx("path", { d: "M5 2a1 1 0 011-1h4a1 1 0 011 1v1h3a1 1 0 110 2h-.08L13 14a2 2 0 01-2 2H5a2 2 0 01-2-2L2.08 5H2a1 1 0 110-2h3V2zm2 0v1h2V2H7z" }) }) }))] }))] }));
    if (contextMenuItems.length > 0) {
        return _jsx(ContextMenu, { items: contextMenuItems, children: content });
    }
    return content;
}
