import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useCallback } from 'react';
export function Modal({ isOpen, onClose, title, children, maxWidth = 'max-w-md' }) {
    const handleKeyDown = useCallback((e) => {
        if (e.key === 'Escape') {
            onClose();
        }
    }, [onClose]);
    useEffect(() => {
        if (isOpen) {
            document.addEventListener('keydown', handleKeyDown);
            return () => document.removeEventListener('keydown', handleKeyDown);
        }
    }, [isOpen, handleKeyDown]);
    if (!isOpen)
        return null;
    return (_jsxs("div", { className: "fixed inset-0 z-50 flex items-center justify-center animate-fade-in", children: [_jsx("div", { className: "absolute inset-0 bg-black/70", onClick: onClose }), _jsxs("div", { className: `relative ${maxWidth} w-full mx-4 bg-discord-bg-primary rounded-lg shadow-xl animate-slide-up`, children: [title && (_jsxs("div", { className: "flex items-center justify-between px-4 pt-4", children: [_jsx("h2", { className: "text-xl font-bold text-discord-text-primary", children: title }), _jsx("button", { onClick: onClose, className: "text-discord-text-muted hover:text-discord-text-primary transition-colors p-1", children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" }) }) })] })), _jsx("div", { className: "p-4", children: children })] })] }));
}
