import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';
export function MemberSidebar() {
    const members = useServerStore((s) => s.members);
    const memberListOpen = useUIStore((s) => s.memberListOpen);
    const openUserProfile = useUIStore((s) => s.openUserProfile);
    if (!memberListOpen)
        return null;
    const onlineMembers = members.filter(m => m.user.status !== 'offline');
    const offlineMembers = members.filter(m => m.user.status === 'offline');
    const roleColors = {
        owner: 'text-discord-red',
        admin: 'text-discord-blurple',
        member: 'text-discord-text-primary',
    };
    const getMemberColor = (member) => {
        if (member.roles && member.roles.length > 0) {
            // Return the color of the first role (already sorted by position)
            return { color: member.roles[0].color };
        }
        return undefined;
    };
    const handleMemberClick = (e, user) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        openUserProfile(user, {
            top: Math.min(rect.top, window.innerHeight - 450),
            left: rect.left - 316, // Open to the left of member sidebar
        });
    };
    return (_jsx("div", { className: "w-60 bg-discord-bg-members flex-shrink-0 overflow-y-auto select-none no-scrollbar", children: _jsxs("div", { className: "p-3", children: [onlineMembers.length > 0 && (_jsxs("div", { className: "mb-4", children: [_jsxs("h3", { className: "text-xs font-semibold text-discord-text-muted uppercase tracking-wide px-2 mb-1", children: ["Online \u2014 ", onlineMembers.length] }), onlineMembers.map((member) => {
                            const displayName = member.user.displayName ?? member.user.username;
                            return (_jsxs("div", { onClick: (e) => handleMemberClick(e, member.user), className: "flex items-center gap-3 px-2 py-1.5 rounded-[4px] hover:bg-discord-modifier-hover cursor-pointer group transition-colors", children: [_jsx(Avatar, { src: member.user.avatar, name: displayName, size: 32, status: member.user.status }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: `text-[15px] font-medium truncate ${!getMemberColor(member) ? (roleColors[member.role] ?? 'text-discord-text-primary') : ''}`, style: getMemberColor(member), children: displayName }), member.user.customStatus && (_jsx("div", { className: "text-[12px] text-discord-text-muted truncate", children: member.user.customStatus }))] })] }, member.userId));
                        })] })), offlineMembers.length > 0 && (_jsxs("div", { children: [_jsxs("h3", { className: "text-xs font-semibold text-discord-text-muted uppercase tracking-wide px-2 mb-1", children: ["Offline \u2014 ", offlineMembers.length] }), offlineMembers.map((member) => {
                            const displayName = member.user.displayName ?? member.user.username;
                            return (_jsxs("div", { onClick: (e) => handleMemberClick(e, member.user), className: "flex items-center gap-3 px-2 py-1.5 rounded-[4px] hover:bg-discord-modifier-hover cursor-pointer group transition-colors", children: [_jsx(Avatar, { src: member.user.avatar, name: displayName, size: 32, status: "offline", className: "opacity-60" }), _jsx("div", { className: "flex-1 min-w-0", children: _jsx("div", { className: "text-[15px] font-medium truncate text-discord-text-muted", children: displayName }) })] }, member.userId));
                        })] }))] }) }));
}
