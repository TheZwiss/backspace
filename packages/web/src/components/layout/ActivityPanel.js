import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo } from 'react';
import { useSocialStore } from '../../stores/socialStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';
export function ActivityPanel() {
    const friends = useSocialStore((s) => s.friends);
    const loadFriends = useSocialStore((s) => s.loadFriends);
    const memberListOpen = useUIStore((s) => s.memberListOpen);
    const openUserProfile = useUIStore((s) => s.openUserProfile);
    useEffect(() => {
        loadFriends();
    }, [loadFriends]);
    const { onlineFriends, offlineFriends } = useMemo(() => {
        const online = friends.filter(f => f.status !== 'offline');
        const offline = friends.filter(f => f.status === 'offline');
        return { onlineFriends: online, offlineFriends: offline };
    }, [friends]);
    if (!memberListOpen)
        return null;
    const handleFriendClick = (e, friend) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        openUserProfile({
            id: friend.id,
            username: friend.username,
            displayName: friend.displayName,
            avatar: friend.avatar,
            status: friend.status,
            customStatus: friend.customStatus,
            createdAt: friend.createdAt,
        }, {
            top: Math.min(rect.top, window.innerHeight - 450),
            left: rect.left - 316,
        });
    };
    const renderFriend = (friend, isOffline = false) => (_jsxs("div", { onClick: (e) => handleFriendClick(e, friend), className: "flex items-center gap-3 px-2 py-1.5 rounded-[4px] hover:bg-discord-modifier-hover cursor-pointer group transition-colors", children: [_jsx(Avatar, { src: friend.avatar, name: friend.displayName ?? friend.username, size: 32, status: isOffline ? 'offline' : friend.status, className: isOffline ? 'opacity-60' : undefined }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: `text-[15px] font-medium truncate ${isOffline ? 'text-discord-text-muted' : 'text-discord-text-primary'}`, children: friend.displayName ?? friend.username }), !isOffline && friend.customStatus && (_jsx("div", { className: "text-[12px] text-discord-text-muted truncate", children: friend.customStatus }))] })] }, friend.id));
    return (_jsx("div", { className: "w-60 bg-discord-bg-secondary flex-shrink-0 overflow-y-auto select-none no-scrollbar", children: _jsxs("div", { className: "p-3", children: [_jsx("h3", { className: "text-[20px] font-bold text-discord-text-header mb-4 px-2", children: "Active Now" }), onlineFriends.length === 0 && offlineFriends.length === 0 ? (_jsxs("div", { className: "text-center py-8", children: [_jsx("div", { className: "text-[16px] font-bold text-discord-text-header mb-1", children: "It's quiet for now..." }), _jsx("div", { className: "text-[14px] text-discord-text-muted max-w-[200px] mx-auto", children: "When a friend starts an activity\u2014like playing a game or hanging out on voice\u2014we'll show it here!" })] })) : (_jsxs(_Fragment, { children: [onlineFriends.length > 0 && (_jsxs("div", { className: "mb-4", children: [_jsxs("h3", { className: "text-[12px] font-bold text-discord-text-muted uppercase tracking-wider px-2 mb-1", children: ["ONLINE \u2014 ", onlineFriends.length] }), onlineFriends.map(f => renderFriend(f))] })), offlineFriends.length > 0 && (_jsxs("div", { children: [_jsxs("h3", { className: "text-[12px] font-bold text-discord-text-muted uppercase tracking-wider px-2 mb-1", children: ["OFFLINE \u2014 ", offlineFriends.length] }), offlineFriends.map(f => renderFriend(f, true))] }))] }))] }) }));
}
