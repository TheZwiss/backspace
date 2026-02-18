import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';
export function MemberSidebar() {
    const members = useServerStore((s) => s.members);
    const memberListOpen = useUIStore((s) => s.memberListOpen);
    if (!memberListOpen)
        return null;
    const onlineMembers = members.filter(m => m.user.status !== 'offline');
    const offlineMembers = members.filter(m => m.user.status === 'offline');
    const roleColors = {
        owner: 'text-discord-red',
        admin: 'text-discord-blurple',
        member: 'text-discord-text-primary',
    };
    return (_jsx("div", { className: "w-60 bg-discord-bg-members flex-shrink-0 overflow-y-auto", children: _jsxs("div", { className: "p-3", children: [onlineMembers.length > 0 && (_jsxs("div", { className: "mb-4", children: [_jsxs("h3", { className: "text-xs font-semibold text-discord-text-muted uppercase tracking-wide px-2 mb-1", children: ["Online \u2014 ", onlineMembers.length] }), onlineMembers.map((member) => {
                            const displayName = member.user.displayName ?? member.user.username;
                            return (_jsxs("div", { className: "flex items-center gap-3 px-2 py-1.5 rounded hover:bg-discord-bg-hover cursor-pointer group", children: [_jsx(Avatar, { src: member.user.avatar, name: displayName, size: 32, status: member.user.status }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: `text-sm font-medium truncate ${roleColors[member.role] ?? 'text-discord-text-primary'}`, children: displayName }), member.user.customStatus && (_jsx("div", { className: "text-xs text-discord-text-muted truncate", children: member.user.customStatus }))] })] }, member.userId));
                        })] })), offlineMembers.length > 0 && (_jsxs("div", { children: [_jsxs("h3", { className: "text-xs font-semibold text-discord-text-muted uppercase tracking-wide px-2 mb-1", children: ["Offline \u2014 ", offlineMembers.length] }), offlineMembers.map((member) => {
                            const displayName = member.user.displayName ?? member.user.username;
                            return (_jsxs("div", { className: "flex items-center gap-3 px-2 py-1.5 rounded hover:bg-discord-bg-hover cursor-pointer group opacity-50", children: [_jsx(Avatar, { src: member.user.avatar, name: displayName, size: 32, status: "offline" }), _jsx("div", { className: "flex-1 min-w-0", children: _jsx("div", { className: "text-sm font-medium truncate text-discord-text-muted", children: displayName }) })] }, member.userId));
                        })] }))] }) }));
}
