import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocialStore } from '../../stores/socialStore';
import { useServerStore } from '../../stores/serverStore';
import { Avatar } from '../ui/Avatar';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { api } from '../../api/client';
export function FriendsPage() {
    const [activeTab, setActiveTab] = useState('online');
    const [addUsername, setAddUsername] = useState('');
    const [addStatus, setAddStatus] = useState(null);
    const navigate = useNavigate();
    const addDmChannel = useServerStore((s) => s.addDmChannel);
    const { friends, requests, isLoading, loadFriends, loadRequests, sendFriendRequest, updateFriendRequest, cancelFriendRequest, removeFriend } = useSocialStore();
    useEffect(() => {
        loadFriends();
        loadRequests();
    }, [loadFriends, loadRequests]);
    const onlineFriends = friends.filter(f => f.status !== 'offline');
    const pendingIncoming = requests.filter(r => r.status === 'pending' && r.user?.id === r.fromId);
    const pendingOutgoing = requests.filter(r => r.status === 'pending' && r.user?.id === r.toId);
    const handleAddFriend = async (e) => {
        e.preventDefault();
        if (!addUsername.trim())
            return;
        try {
            await sendFriendRequest(addUsername.trim());
            setAddStatus({ type: 'success', message: `Success! Your friend request to ${addUsername} has been sent.` });
            setAddUsername('');
        }
        catch (err) {
            setAddStatus({ type: 'error', message: err.message });
        }
    };
    const handleOpenDm = async (friendId) => {
        try {
            const dmChannel = await api.dm.create({ userId: friendId });
            addDmChannel(dmChannel);
            navigate(`/channels/@me/${dmChannel.id}`);
        }
        catch (err) {
            console.error('Failed to open DM:', err);
        }
    };
    const renderTabContent = () => {
        if (isLoading && friends.length === 0 && requests.length === 0) {
            return (_jsx("div", { className: "flex-1 flex items-center justify-center", children: _jsx(LoadingSpinner, {}) }));
        }
        switch (activeTab) {
            case 'online':
                return (_jsxs("div", { className: "flex-1 overflow-y-auto p-4", children: [_jsxs("h2", { className: "text-xs font-bold text-discord-text-muted uppercase mb-4 tracking-wider px-2", children: ["Online \u2014 ", onlineFriends.length] }), onlineFriends.length === 0 ? (_jsxs("div", { className: "flex flex-col items-center justify-center h-full opacity-60", children: [_jsx("img", { src: "/friends-empty.svg", alt: "", className: "w-64 h-64 mb-4", onError: (e) => e.target.style.display = 'none' }), _jsx("p", { className: "text-discord-text-muted", children: "No one's around to play with Wumpus." })] })) : (onlineFriends.map(friend => (_jsx(FriendItem, { friend: friend, onRemove: () => removeFriend(friend.id), onDm: () => handleOpenDm(friend.id) }, friend.id))))] }));
            case 'all':
                return (_jsxs("div", { className: "flex-1 overflow-y-auto p-4", children: [_jsxs("h2", { className: "text-xs font-bold text-discord-text-muted uppercase mb-4 tracking-wider px-2", children: ["All Friends \u2014 ", friends.length] }), friends.length === 0 ? (_jsx("div", { className: "flex flex-col items-center justify-center h-full opacity-60", children: _jsx("p", { className: "text-discord-text-muted", children: "Wumpus is waiting on friends. You can add them!" }) })) : (friends.map(friend => (_jsx(FriendItem, { friend: friend, onRemove: () => removeFriend(friend.id), onDm: () => handleOpenDm(friend.id) }, friend.id))))] }));
            case 'pending':
                return (_jsxs("div", { className: "flex-1 overflow-y-auto p-4", children: [_jsxs("h2", { className: "text-xs font-bold text-discord-text-muted uppercase mb-4 tracking-wider px-2", children: ["Pending \u2014 ", pendingIncoming.length + pendingOutgoing.length] }), [...pendingIncoming, ...pendingOutgoing].length === 0 ? (_jsx("div", { className: "flex flex-col items-center justify-center h-full opacity-60", children: _jsx("p", { className: "text-discord-text-muted", children: "There are no pending friend requests. Here's Wumpus for now!" }) })) : (_jsxs(_Fragment, { children: [pendingIncoming.map(req => (_jsx(RequestItem, { request: req, type: "incoming", onAccept: () => updateFriendRequest(req.id, 'accepted'), onDecline: () => updateFriendRequest(req.id, 'declined') }, req.id))), pendingOutgoing.map(req => (_jsx(RequestItem, { request: req, type: "outgoing", onCancel: () => cancelFriendRequest(req.id) }, req.id)))] }))] }));
            case 'add':
                return (_jsxs("div", { className: "flex-1 p-8", children: [_jsx("h2", { className: "text-base font-bold text-discord-text-primary uppercase mb-2", children: "Add Friend" }), _jsx("p", { className: "text-sm text-discord-text-muted mb-4", children: "You can add friends with their Opencord username." }), _jsxs("form", { onSubmit: handleAddFriend, className: "relative mb-8", children: [_jsx("input", { type: "text", placeholder: "You can add a friend with their username", value: addUsername, onChange: (e) => setAddUsername(e.target.value), className: "w-full bg-discord-bg-tertiary text-discord-text-primary px-4 py-3 rounded-lg border border-transparent focus:border-discord-text-link outline-none transition-all placeholder:text-discord-text-muted/50" }), _jsx("button", { type: "submit", disabled: !addUsername.trim() || isLoading, className: "absolute right-2 top-1.5 px-4 py-1.5 bg-discord-blurple hover:bg-discord-blurple-hover disabled:opacity-50 disabled:bg-discord-blurple text-white text-sm font-medium rounded transition-colors", children: "Send Friend Request" })] }), addStatus && (_jsx("div", { className: `text-sm p-3 rounded-lg border ${addStatus.type === 'success' ? 'text-discord-text-positive border-discord-green/20 bg-discord-green/5' : 'text-discord-text-danger border-discord-red/20 bg-discord-red/5'}`, children: addStatus.message }))] }));
        }
    };
    return (_jsxs("div", { className: "flex-1 flex flex-col bg-discord-bg-primary h-full", children: [_jsxs("div", { className: "h-12 px-4 flex items-center shadow-header flex-shrink-0 z-10 bg-discord-bg-primary", children: [_jsxs("div", { className: "flex items-center gap-2 mr-4", children: [_jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted", children: _jsx("path", { d: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" }) }), _jsx("span", { className: "font-bold text-discord-text-primary", children: "Friends" })] }), _jsx("div", { className: "w-[1px] h-6 bg-discord-bg-accent mx-2" }), _jsxs("div", { className: "flex items-center gap-4 ml-2", children: [_jsx(TabButton, { active: activeTab === 'online', onClick: () => setActiveTab('online'), children: "Online" }), _jsx(TabButton, { active: activeTab === 'all', onClick: () => setActiveTab('all'), children: "All" }), _jsxs(TabButton, { active: activeTab === 'pending', onClick: () => setActiveTab('pending'), children: ["Pending", (pendingIncoming.length > 0) && (_jsx("span", { className: "ml-2 px-1.5 py-0.5 bg-discord-red text-white text-[10px] rounded-full leading-none", children: pendingIncoming.length }))] }), _jsx("button", { onClick: () => setActiveTab('add'), className: `px-2 py-0.5 rounded text-[14px] font-medium transition-all ${activeTab === 'add' ? 'text-discord-green bg-transparent' : 'bg-discord-green text-white hover:bg-discord-green/90'}`, children: "Add Friend" })] })] }), renderTabContent()] }));
}
function TabButton({ children, active, onClick }) {
    return (_jsx("button", { onClick: onClick, className: `px-2 py-0.5 rounded-[4px] text-[16px] font-medium transition-colors ${active ? 'bg-discord-modifier-selected text-white' : 'text-discord-text-muted hover:bg-discord-modifier-hover hover:text-discord-text-secondary'}`, children: children }));
}
function FriendItem({ friend, onRemove, onDm }) {
    return (_jsxs("div", { className: "flex items-center justify-between px-3 h-[62px] rounded-[8px] hover:bg-discord-modifier-hover group transition-colors border-t border-discord-modifier-accent mx-2", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Avatar, { src: friend.avatar, name: friend.displayName ?? friend.username, size: 32, status: friend.status }), _jsxs("div", { className: "flex flex-col leading-tight", children: [_jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "text-discord-text-primary font-semibold text-[15px]", children: friend.displayName ?? friend.username }), _jsxs("span", { className: "text-discord-text-muted text-[13px] opacity-0 group-hover:opacity-100 transition-opacity font-medium", children: ["@", friend.username] })] }), _jsx("span", { className: "text-[12px] text-discord-text-muted font-medium uppercase", children: friend.status })] })] }), _jsxs("div", { className: "flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity pr-2", children: [_jsx("button", { onClick: (e) => { e.stopPropagation(); onDm(); }, className: "w-9 h-9 flex items-center justify-center bg-discord-bg-tertiary rounded-full text-discord-text-muted hover:text-discord-text-primary transition-colors", title: "Message", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-5H6V7h12v2z" }) }) }), _jsx("button", { onClick: (e) => { e.stopPropagation(); onRemove(); }, className: "w-9 h-9 flex items-center justify-center bg-discord-bg-tertiary rounded-full text-discord-text-muted hover:text-discord-red transition-colors", title: "Remove Friend", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" }) }) })] })] }));
}
function RequestItem({ request, type, onAccept, onDecline, onCancel }) {
    const user = request.user;
    if (!user)
        return null;
    return (_jsxs("div", { className: "flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-discord-modifier-hover group transition-colors border-t border-discord-modifier-accent mx-2", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Avatar, { src: user.avatar, name: user.displayName ?? user.username, size: 32, status: user.status }), _jsxs("div", { className: "flex flex-col", children: [_jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx("span", { className: "text-discord-text-primary font-bold text-sm", children: user.displayName ?? user.username }), _jsxs("span", { className: "text-discord-text-muted text-xs", children: ["@", user.username] })] }), _jsx("span", { className: "text-xs text-discord-text-muted", children: type === 'incoming' ? 'Incoming Friend Request' : 'Outgoing Friend Request' })] })] }), _jsx("div", { className: "flex items-center gap-2", children: type === 'incoming' ? (_jsxs(_Fragment, { children: [_jsx("button", { onClick: () => onAccept?.(), className: "p-2 bg-discord-bg-tertiary rounded-full text-discord-green hover:bg-discord-green hover:text-white transition-all", title: "Accept", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" }) }) }), _jsx("button", { onClick: () => onDecline?.(), className: "p-2 bg-discord-bg-tertiary rounded-full text-discord-red hover:bg-discord-red hover:text-white transition-all", title: "Decline", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" }) }) })] })) : (_jsx("button", { onClick: () => onCancel?.(), className: "p-2 bg-discord-bg-tertiary rounded-full text-discord-text-muted hover:text-discord-red transition-all", title: "Cancel Request", children: _jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" }) }) })) })] }));
}
