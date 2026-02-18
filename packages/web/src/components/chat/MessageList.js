import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Message } from './Message';
import { useChatStore } from '../../stores/chatStore';
import { LoadingSpinner } from '../ui/LoadingSpinner';
const EMPTY_MESSAGES = [];
function isSameGroup(prev, curr) {
    if (prev.userId !== curr.userId)
        return false;
    const timeDiff = curr.createdAt - prev.createdAt;
    return timeDiff < 5 * 60 * 1000; // 5 minutes
}
function formatDateDivider(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
}
function shouldShowDateDivider(prev, curr) {
    if (!prev)
        return true;
    const prevDate = new Date(prev.createdAt).toDateString();
    const currDate = new Date(curr.createdAt).toDateString();
    return prevDate !== currDate;
}
export function MessageList({ channelId }) {
    const messages = useChatStore((s) => s.messages.get(channelId)) ?? EMPTY_MESSAGES;
    const loadMessages = useChatStore((s) => s.loadMessages);
    const loadMoreMessages = useChatStore((s) => s.loadMoreMessages);
    const isLoading = useChatStore((s) => s.isLoading);
    const hasMore = useChatStore((s) => s.hasMore.get(channelId) ?? true);
    const bottomRef = useRef(null);
    const containerRef = useRef(null);
    const [isNearBottom, setIsNearBottom] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const prevMessagesLength = useRef(0);
    useEffect(() => {
        loadMessages(channelId);
    }, [channelId, loadMessages]);
    // Auto-scroll to bottom on new messages (if near bottom)
    useEffect(() => {
        if (messages.length > prevMessagesLength.current && isNearBottom) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
        prevMessagesLength.current = messages.length;
    }, [messages.length, isNearBottom]);
    // Scroll to bottom on initial load
    useEffect(() => {
        if (messages.length > 0 && prevMessagesLength.current === 0) {
            bottomRef.current?.scrollIntoView();
        }
    }, [messages.length]);
    const handleScroll = useCallback(async () => {
        const container = containerRef.current;
        if (!container)
            return;
        // Check if near bottom
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        setIsNearBottom(distanceFromBottom < 100);
        // Load more when scrolled to top
        if (container.scrollTop < 50 && hasMore && !isLoadingMore) {
            setIsLoadingMore(true);
            const prevScrollHeight = container.scrollHeight;
            const loaded = await loadMoreMessages(channelId);
            if (loaded) {
                // Maintain scroll position
                requestAnimationFrame(() => {
                    container.scrollTop = container.scrollHeight - prevScrollHeight;
                });
            }
            setIsLoadingMore(false);
        }
    }, [channelId, hasMore, isLoadingMore, loadMoreMessages]);
    if (isLoading && messages.length === 0) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center", children: _jsx(LoadingSpinner, {}) }));
    }
    return (_jsxs("div", { ref: containerRef, className: "flex-1 overflow-y-auto overflow-x-hidden", onScroll: handleScroll, children: [isLoadingMore && (_jsx("div", { className: "py-4", children: _jsx(LoadingSpinner, { size: 24 }) })), !hasMore && (_jsxs("div", { className: "px-4 pt-6 pb-4", children: [_jsx("h3", { className: "text-2xl font-bold text-discord-text-primary", children: "Welcome to the channel!" }), _jsx("p", { className: "text-discord-text-muted text-sm mt-1", children: "This is the start of the conversation." }), _jsx("div", { className: "mt-4 border-b border-discord-bg-hover" })] })), _jsx("div", { className: "pb-6", children: messages.map((msg, i) => {
                    const prevMsg = messages[i - 1];
                    const showDate = shouldShowDateDivider(prevMsg, msg);
                    const isFirstInGroup = !prevMsg || showDate || !isSameGroup(prevMsg, msg);
                    return (_jsxs(React.Fragment, { children: [showDate && (_jsxs("div", { className: "flex items-center px-4 my-4", children: [_jsx("div", { className: "flex-1 border-t border-discord-bg-hover" }), _jsx("span", { className: "px-2 text-xs font-semibold text-discord-text-muted", children: formatDateDivider(msg.createdAt) }), _jsx("div", { className: "flex-1 border-t border-discord-bg-hover" })] })), _jsx(Message, { message: msg, isCompact: !isFirstInGroup, isFirstInGroup: isFirstInGroup })] }, msg.id));
                }) }), _jsx("div", { ref: bottomRef })] }));
}
