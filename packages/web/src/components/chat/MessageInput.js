import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useCallback } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { isDmChannel } from '../../stores/serverStore';
import { wsSend } from '../../hooks/useWebSocket';
import { api } from '../../api/client';
export function MessageInput({ channelId, channelName }) {
    const [content, setContent] = useState('');
    const [files, setFiles] = useState([]);
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef(null);
    const textareaRef = useRef(null);
    const sendMessage = useChatStore((s) => s.sendMessage);
    const replyTo = useChatStore((s) => s.replyTo);
    const setReplyTo = useChatStore((s) => s.setReplyTo);
    const typingTimeoutRef = useRef();
    const handleTyping = useCallback(() => {
        if (typingTimeoutRef.current)
            return;
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
        if (!trimmed && files.length === 0)
            return;
        setIsUploading(true);
        try {
            // Upload files first
            const attachmentIds = [];
            for (const file of files) {
                const attachment = await api.uploads.upload(file);
                attachmentIds.push(attachment.id);
            }
            await sendMessage(channelId, trimmed || '', attachmentIds.length > 0 ? attachmentIds : undefined);
            setContent('');
            setFiles([]);
            // Clear typing timeout
            if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current);
                typingTimeoutRef.current = undefined;
            }
        }
        catch (err) {
            console.error('Failed to send message:', err);
        }
        finally {
            setIsUploading(false);
        }
    };
    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };
    const handlePaste = (e) => {
        const items = e.clipboardData.items;
        const pastedFiles = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file)
                    pastedFiles.push(file);
            }
        }
        if (pastedFiles.length > 0) {
            setFiles((prev) => [...prev, ...pastedFiles]);
        }
    };
    const handleDrop = (e) => {
        e.preventDefault();
        const droppedFiles = Array.from(e.dataTransfer.files);
        if (droppedFiles.length > 0) {
            setFiles((prev) => [...prev, ...droppedFiles]);
        }
    };
    const handleDragOver = (e) => {
        e.preventDefault();
    };
    const removeFile = (index) => {
        setFiles((prev) => prev.filter((_, i) => i !== index));
    };
    const handleChange = (e) => {
        setContent(e.target.value);
        handleTyping();
        // Auto-resize textarea
        const textarea = e.target;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
    };
    return (_jsxs("div", { className: "px-4 pb-6 flex-shrink-0", children: [replyTo && (_jsxs("div", { className: "bg-discord-bg-hover rounded-t-lg px-4 py-2 flex items-center justify-between border-b border-discord-bg-tertiary/50", children: [_jsxs("div", { className: "flex items-center gap-1 text-[14px] text-discord-text-normal truncate", children: [_jsx("span", { className: "opacity-60", children: "Replying to" }), _jsx("span", { className: "font-bold", children: replyTo.user.displayName ?? replyTo.user.username })] }), _jsx("button", { onClick: () => setReplyTo(null), className: "text-discord-text-muted hover:text-discord-text-primary transition-colors", children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" }) }) })] })), _jsxs("div", { className: `bg-discord-bg-input ${replyTo ? 'rounded-b-lg' : 'rounded-lg'} overflow-hidden`, onDrop: handleDrop, onDragOver: handleDragOver, children: [files.length > 0 && (_jsx("div", { className: "p-4 flex flex-wrap gap-4 bg-discord-bg-secondary/30", children: files.map((file, i) => (_jsxs("div", { className: "relative group bg-discord-bg-secondary rounded-lg p-2 max-w-[200px] shadow-elevation-low border border-discord-bg-tertiary", children: [file.type.startsWith('image/') ? (_jsx("img", { src: URL.createObjectURL(file), alt: file.name, className: "max-h-[150px] rounded object-cover" })) : (_jsxs("div", { className: "flex items-center gap-2 text-sm text-discord-text-secondary py-4 px-2", children: [_jsx("svg", { className: "w-8 h-8 opacity-60", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, d: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" }) }), _jsx("span", { className: "truncate max-w-[120px] font-medium", children: file.name })] })), _jsx("button", { onClick: () => removeFile(i), className: "absolute -top-2 -right-2 w-7 h-7 bg-discord-red hover:bg-discord-red-hover shadow-elevation-high rounded-lg flex items-center justify-center text-white transition-colors z-10", children: _jsx("svg", { width: "14", height: "14", viewBox: "0 0 16 16", fill: "currentColor", children: _jsx("path", { d: "M5 2a1 1 0 011-1h4a1 1 0 011 1v1h3a1 1 0 110 2h-.08L13 14a2 2 0 01-2 2H5a2 2 0 01-2-2L2.08 5H2a1 1 0 110-2h3V2zm2 0v1h2V2H7z" }) }) })] }, i))) })), _jsxs("div", { className: "flex items-start px-1", children: [_jsx("button", { onClick: () => fileInputRef.current?.click(), className: "p-3 text-discord-text-muted hover:text-discord-text-secondary transition-colors sticky top-0", title: "Attach file", children: _jsx("div", { className: "bg-discord-text-muted/20 hover:bg-discord-text-muted/40 rounded-full p-0.5 transition-colors", children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" }) }) }) }), _jsx("input", { ref: fileInputRef, type: "file", multiple: true, className: "hidden", onChange: (e) => {
                                    const selected = Array.from(e.target.files ?? []);
                                    if (selected.length > 0) {
                                        setFiles((prev) => [...prev, ...selected]);
                                    }
                                    e.target.value = '';
                                } }), _jsx("textarea", { ref: textareaRef, value: content, onChange: handleChange, onKeyDown: handleKeyDown, onPaste: handlePaste, placeholder: `Message ${channelName.startsWith('@') ? channelName : `#${channelName}`}`, className: "flex-1 py-[11px] px-1 bg-transparent text-discord-text-primary placeholder-discord-text-muted/60 outline-none resize-none text-[15px] leading-[1.375rem] max-h-[50vh] scrollbar-thin", rows: 1, disabled: isUploading }), isUploading && (_jsx("div", { className: "p-3 text-discord-text-muted", children: _jsxs("svg", { className: "w-5 h-5 animate-spin", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] }) })), _jsx("button", { className: "p-3 text-discord-text-muted hover:text-discord-text-secondary transition-colors", children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5s.67 1.5 1.5 1.5zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" }) }) }), _jsx("button", { onClick: handleSubmit, disabled: !content.trim() && files.length === 0, className: "p-3 text-discord-text-muted hover:text-discord-text-primary transition-colors disabled:opacity-30 disabled:hover:text-discord-text-muted", children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" }) }) })] })] })] }));
}
