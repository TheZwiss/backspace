import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useNavigate } from 'react-router-dom';
import { Avatar } from '../ui/Avatar';
import { api } from '../../api/client';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
export function UserProfilePopout({ user, onClose, position }) {
    const navigate = useNavigate();
    const addDmChannel = useServerStore((s) => s.addDmChannel);
    const displayName = user.displayName ?? user.username;
    const handleSendMessage = async () => {
        try {
            const channel = await api.dm.create({ userId: user.id });
            addDmChannel(channel);
            useUIStore.getState().setShowDms(true);
            onClose();
            navigate(`/channels/@me/${channel.id}`);
        }
        catch (err) {
            console.error('Failed to create DM channel:', err);
        }
    };
    return (_jsxs("div", { className: "fixed z-50 w-[300px] bg-discord-bg-floating rounded-[8px] shadow-elevation-high overflow-hidden animate-fade-in select-none", style: position ? { top: position.top, left: position.left } : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }, children: [_jsx("div", { className: "h-[60px] bg-discord-blurple" }), _jsxs("div", { className: "px-4 pb-4 relative", children: [_jsx("div", { className: "absolute -top-8 left-4 rounded-full border-[6px] border-discord-bg-floating bg-discord-bg-floating", children: _jsx(Avatar, { src: user.avatar, name: displayName, size: 80, status: user.status }) }), _jsxs("div", { className: "mt-12 bg-discord-bg-tertiary rounded-[8px] p-3", children: [_jsx("div", { className: "text-[20px] font-bold text-discord-text-header leading-tight mb-1", children: displayName }), _jsxs("div", { className: "text-[14px] text-discord-text-normal font-medium mb-3", children: ["@", user.username] }), _jsx("div", { className: "w-full h-[1px] bg-discord-modifier-accent mb-3" }), _jsxs("div", { className: "mb-3", children: [_jsx("div", { className: "text-[12px] font-bold text-discord-text-header uppercase mb-1", children: "Opencord Member Since" }), _jsx("div", { className: "text-[12px] text-discord-text-normal font-medium", children: new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) })] }), user.customStatus && (_jsxs("div", { className: "mb-3", children: [_jsx("div", { className: "text-[12px] font-bold text-discord-text-header uppercase mb-1", children: "Status" }), _jsx("div", { className: "text-[14px] text-discord-text-normal", children: user.customStatus })] }))] })] }), _jsx("div", { className: "px-4 pb-4", children: _jsx("button", { onClick: handleSendMessage, className: "w-full py-2 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-[14px] font-medium rounded-[4px] transition-colors", children: "Send Message" }) })] }));
}
