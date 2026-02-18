import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useCallback } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { wsSend } from '../../hooks/useWebSocket';
import { api } from '../../api/client';
export function MessageInput({ channelId, channelName }) {
    const [content, setContent] = useState('');
    const [files, setFiles] = useState([]);
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef(null);
    const textareaRef = useRef(null);
    const sendMessage = useChatStore((s) => s.sendMessage);
    const typingTimeoutRef = useRef();
    const handleTyping = useCallback(() => {
        if (typingTimeoutRef.current)
            return;
        wsSend({ type: 'typing_start', channelId });
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
    return (_jsx("div", { className: "px-4 pb-6", children: _jsxs("div", { className: "bg-discord-bg-input rounded-lg", onDrop: handleDrop, onDragOver: handleDragOver, children: [files.length > 0 && (_jsx("div", { className: "p-2 border-b border-discord-bg-tertiary flex flex-wrap gap-2", children: files.map((file, i) => (_jsxs("div", { className: "relative group bg-discord-bg-secondary rounded p-2 max-w-[200px]", children: [file.type.startsWith('image/') ? (_jsx("img", { src: URL.createObjectURL(file), alt: file.name, className: "max-h-[100px] rounded object-cover" })) : (_jsxs("div", { className: "flex items-center gap-2 text-sm text-discord-text-secondary", children: [_jsx("svg", { className: "w-5 h-5", fill: "none", viewBox: "0 0 24 24", stroke: "currentColor", children: _jsx("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, d: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" }) }), _jsx("span", { className: "truncate", children: file.name })] })), _jsx("button", { onClick: () => removeFile(i), className: "absolute -top-1 -right-1 w-5 h-5 bg-discord-red rounded-full flex items-center justify-center text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity", children: "\u2715" })] }, i))) })), _jsxs("div", { className: "flex items-end", children: [_jsx("button", { onClick: () => fileInputRef.current?.click(), className: "p-3 text-discord-text-muted hover:text-discord-text-primary transition-colors", title: "Attach file", children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" }) }) }), _jsx("input", { ref: fileInputRef, type: "file", multiple: true, className: "hidden", onChange: (e) => {
                                const selected = Array.from(e.target.files ?? []);
                                if (selected.length > 0) {
                                    setFiles((prev) => [...prev, ...selected]);
                                }
                                e.target.value = '';
                            } }), _jsx("textarea", { ref: textareaRef, value: content, onChange: handleChange, onKeyDown: handleKeyDown, onPaste: handlePaste, placeholder: `Message #${channelName}`, className: "flex-1 py-3 bg-transparent text-discord-text-primary placeholder-discord-text-muted outline-none resize-none text-sm leading-[1.375rem] max-h-[300px]", rows: 1, disabled: isUploading }), isUploading && (_jsx("div", { className: "p-3 text-discord-text-muted", children: _jsxs("svg", { className: "w-5 h-5 animate-spin", viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" })] }) }))] })] }) }));
}
