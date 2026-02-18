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
    return (_jsx("div", { className: "h-[24px] px-4 flex items-center text-[12px] text-discord-text-header font-medium select-none pointer-events-none", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("div", { className: "flex gap-[2px] bg-discord-bg-accent/20 rounded-full px-2 py-1", children: [_jsx("div", { className: "w-[5px] h-[5px] bg-discord-text-normal rounded-full animate-bounce", style: { animationDelay: '0ms', animationDuration: '0.8s' } }), _jsx("div", { className: "w-[5px] h-[5px] bg-discord-text-normal rounded-full animate-bounce", style: { animationDelay: '150ms', animationDuration: '0.8s' } }), _jsx("div", { className: "w-[5px] h-[5px] bg-discord-text-normal rounded-full animate-bounce", style: { animationDelay: '300ms', animationDuration: '0.8s' } })] }), _jsx("span", { className: "truncate max-w-[400px]", children: _jsx("span", { className: "font-bold", children: text }) })] }) }));
}
