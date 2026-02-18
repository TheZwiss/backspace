import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
export function TypingIndicator({ channelId }) {
    const typingUsersRaw = useChatStore((s) => s.typingUsers.get(channelId));
    const currentUserId = useAuthStore((s) => s.user?.id);
    // Filter out current user and expired entries
    const others = useMemo(() => {
        if (!typingUsersRaw || typingUsersRaw.length === 0)
            return [];
        const now = Date.now();
        return typingUsersRaw
            .filter(t => now - t.timestamp < 5000 && t.userId !== currentUserId);
    }, [typingUsersRaw, currentUserId]);
    if (others.length === 0)
        return null;
    let text = '';
    if (others.length === 1) {
        text = `${others[0].username} is typing`;
    }
    else if (others.length === 2) {
        text = `${others[0].username} and ${others[1].username} are typing`;
    }
    else {
        text = 'Several people are typing';
    }
    return (_jsx("div", { className: "h-6 px-4 flex items-center text-xs text-discord-text-muted", children: _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs("span", { className: "flex gap-0.5", children: [_jsx("span", { className: "w-1 h-1 bg-discord-text-muted rounded-full animate-bounce", style: { animationDelay: '0ms' } }), _jsx("span", { className: "w-1 h-1 bg-discord-text-muted rounded-full animate-bounce", style: { animationDelay: '150ms' } }), _jsx("span", { className: "w-1 h-1 bg-discord-text-muted rounded-full animate-bounce", style: { animationDelay: '300ms' } })] }), _jsx("span", { className: "font-medium", children: text }), _jsx("span", { children: "..." })] }) }));
}
