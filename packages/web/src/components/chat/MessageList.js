import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Message } from './Message';
import { useChatStore } from '../../stores/chatStore';
import { useServerStore, isDmChannel } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { Avatar } from '../ui/Avatar';
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
    const ackChannel = useChatStore((s) => s.ackChannel);
    const bottomRef = useRef(null);
    const containerRef = useRef(null);
    const [isNearBottom, setIsNearBottom] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const prevMessagesLength = useRef(0);
    const ackTimerRef = useRef();
    useEffect(() => {
        loadMessages(channelId);
    }, [channelId, loadMessages]);
    // Ack channel when messages load or when new messages arrive while near bottom
    useEffect(() => {
        if (messages.length > 0 && isNearBottom) {
            clearTimeout(ackTimerRef.current);
            ackTimerRef.current = setTimeout(() => ackChannel(channelId), 200);
        }
        return () => clearTimeout(ackTimerRef.current);
    }, [channelId, messages.length, isNearBottom, ackChannel]);
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
    return (_jsxs("div", { ref: containerRef, className: "flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin", onScroll: handleScroll, children: [isLoadingMore && (_jsx("div", { className: "py-4", children: _jsx(LoadingSpinner, { size: 24 }) })), !hasMore && _jsx(WelcomeHeader, { channelId: channelId }), _jsx("div", { className: "pb-6", children: messages.map((msg, i) => {
                    const prevMsg = messages[i - 1];
                    const showDate = shouldShowDateDivider(prevMsg, msg);
                    const isFirstInGroup = !prevMsg || showDate || !isSameGroup(prevMsg, msg);
                    return (_jsxs(React.Fragment, { children: [showDate && (_jsxs("div", { className: "flex items-center px-4 my-6 select-none pointer-events-none", children: [_jsx("div", { className: "flex-1 h-[1px] bg-discord-modifier-accent" }), _jsx("span", { className: "px-2 text-[12px] font-bold text-discord-text-muted leading-tight", children: formatDateDivider(msg.createdAt) }), _jsx("div", { className: "flex-1 h-[1px] bg-discord-modifier-accent" })] })), _jsx(Message, { message: msg, isCompact: !isFirstInGroup, isFirstInGroup: isFirstInGroup })] }, msg.id));
                }) }), _jsx("div", { ref: bottomRef })] }));
}
function WelcomeHeader({ channelId }) {
    const dmChannels = useServerStore((s) => s.dmChannels);
    const authUser = useAuthStore((s) => s.user);
    const removeFriend = useSocialStore((s) => s.removeFriend);
    const friends = useSocialStore((s) => s.friends);
    const isDm = isDmChannel(channelId);
    if (isDm) {
        const dm = dmChannels.find(d => d.id === channelId);
        const otherUser = dm?.members.find(m => m.id !== authUser?.id);
        const displayName = otherUser?.displayName ?? otherUser?.username ?? 'Unknown';
        const username = otherUser?.username ?? 'unknown';
        const isFriend = otherUser ? friends.some(f => f.id === otherUser.id) : false;
        return (_jsxs("div", { className: "px-4 pt-8 pb-4", children: [_jsx("div", { className: "mb-2", children: _jsx(Avatar, { src: otherUser?.avatar, name: displayName, size: 80 }) }), _jsx("h3", { className: "text-[32px] leading-10 font-bold text-discord-text-primary", children: displayName }), _jsxs("p", { className: "text-discord-text-secondary text-[14px] mt-1", children: ["This is the beginning of your direct message history with ", _jsxs("strong", { children: ["@", username] }), "."] }), isFriend && otherUser && (_jsx("div", { className: "mt-4", children: _jsx("button", { onClick: () => removeFriend(otherUser.id), className: "px-4 py-1.5 bg-discord-bg-accent hover:bg-discord-bg-surface-higher text-[14px] font-medium text-discord-text-primary rounded-[3px] transition-colors", children: "Remove Friend" }) })), _jsx("div", { className: "mt-6 border-b border-discord-modifier-accent" })] }));
    }
    return (_jsxs("div", { className: "px-4 pt-8 pb-4", children: [_jsx("div", { className: "w-[68px] h-[68px] rounded-full bg-discord-bg-accent flex items-center justify-center mb-4 text-white", children: _jsx("svg", { width: "42", height: "42", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z" }) }) }), _jsx("h3", { className: "text-[32px] leading-10 font-bold text-discord-text-primary", children: "Welcome to the channel!" }), _jsx("p", { className: "text-discord-text-secondary text-[16px] mt-2", children: "This is the start of the conversation." }), _jsx("div", { className: "mt-6 border-b border-discord-modifier-accent" })] }));
}
