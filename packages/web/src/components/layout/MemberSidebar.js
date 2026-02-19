import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';
const ROLE_ORDER = { owner: 0, admin: 1, member: 2 };
const ROLE_LABELS = { owner: 'OWNER', admin: 'ADMIN', member: 'MEMBER' };
export function MemberSidebar() {
    const members = useServerStore((s) => s.members);
    const memberListOpen = useUIStore((s) => s.memberListOpen);
    const openUserProfile = useUIStore((s) => s.openUserProfile);
    const { roleGroups, offlineMembers } = useMemo(() => {
        const online = members.filter(m => m.user.status !== 'offline');
        const offline = members.filter(m => m.user.status === 'offline');
        // Group online members by role
        const groups = new Map();
        for (const m of online) {
            const role = m.role || 'member';
            if (!groups.has(role))
                groups.set(role, []);
            groups.get(role).push(m);
        }
        // Sort groups by role hierarchy
        const sorted = [...groups.entries()].sort((a, b) => (ROLE_ORDER[a[0]] ?? 99) - (ROLE_ORDER[b[0]] ?? 99));
        return { roleGroups: sorted, offlineMembers: offline };
    }, [members]);
    if (!memberListOpen)
        return null;
    const roleColors = {
        owner: 'text-discord-red',
        admin: 'text-discord-blurple',
        member: 'text-discord-text-primary',
    };
    const getMemberColor = (member) => {
        if (member.roles && member.roles.length > 0) {
            return { color: member.roles[0].color };
        }
        return undefined;
    };
    const handleMemberClick = (e, user) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        openUserProfile(user, {
            top: Math.min(rect.top, window.innerHeight - 450),
            left: rect.left - 316,
        });
    };
    const renderMember = (member, isOffline = false) => {
        const displayName = member.user.displayName ?? member.user.username;
        return (_jsxs("div", { onClick: (e) => handleMemberClick(e, member.user), className: "flex items-center gap-3 px-2 py-1.5 rounded-[4px] hover:bg-discord-modifier-hover cursor-pointer group transition-colors", children: [_jsx(Avatar, { src: member.user.avatar, name: displayName, size: 32, status: isOffline ? 'offline' : member.user.status, className: isOffline ? 'opacity-60' : undefined }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: `text-[15px] font-medium truncate ${isOffline ? 'text-discord-text-muted' : (!getMemberColor(member) ? (roleColors[member.role] ?? 'text-discord-text-primary') : '')}`, style: isOffline ? undefined : getMemberColor(member), children: displayName }), !isOffline && member.user.customStatus && (_jsx("div", { className: "text-[12px] text-discord-text-muted truncate", children: member.user.customStatus }))] })] }, member.userId));
    };
    return (_jsx("div", { className: "w-60 bg-discord-bg-members flex-shrink-0 overflow-y-auto select-none no-scrollbar", children: _jsxs("div", { className: "p-3", children: [roleGroups.map(([role, groupMembers]) => (_jsxs("div", { className: "mb-4", children: [_jsxs("h3", { className: "text-[12px] font-bold text-discord-text-muted uppercase tracking-wider px-2 mb-1", children: [ROLE_LABELS[role] ?? role.toUpperCase(), " \u2014 ", groupMembers.length] }), groupMembers.map((m) => renderMember(m))] }, role))), offlineMembers.length > 0 && (_jsxs("div", { children: [_jsxs("h3", { className: "text-[12px] font-bold text-discord-text-muted uppercase tracking-wider px-2 mb-1", children: ["OFFLINE \u2014 ", offlineMembers.length] }), offlineMembers.map((m) => renderMember(m, true))] }))] }) }));
}
