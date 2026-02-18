import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { Avatar } from '../ui/Avatar';
import { api } from '../../api/client';
import { useNavigate } from 'react-router-dom';
export function ServerSettingsModal() {
    const activeModal = useUIStore((s) => s.activeModal);
    const closeModal = useUIStore((s) => s.closeModal);
    const currentServerId = useServerStore((s) => s.currentServerId);
    const servers = useServerStore((s) => s.servers);
    const members = useServerStore((s) => s.members);
    const updateServer = useServerStore((s) => s.updateServer);
    const deleteServer = useServerStore((s) => s.deleteServer);
    const loadServerDetail = useServerStore((s) => s.loadServerDetail);
    const currentUser = useAuthStore((s) => s.user);
    const navigate = useNavigate();
    const [tab, setTab] = useState('overview');
    const [serverName, setServerName] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const isOpen = activeModal === 'serverSettings';
    const server = servers.find(s => s.id === currentServerId);
    const isOwnerUser = server?.ownerId === currentUser?.id;
    React.useEffect(() => {
        if (server) {
            setServerName(server.name);
        }
    }, [server]);
    if (!server || !currentServerId)
        return null;
    const handleSave = async () => {
        setError('');
        setIsLoading(true);
        try {
            await updateServer(currentServerId, { name: serverName.trim() });
            setIsLoading(false);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update server');
            setIsLoading(false);
        }
    };
    const handleDelete = async () => {
        if (!confirmDelete) {
            setConfirmDelete(true);
            return;
        }
        try {
            await deleteServer(currentServerId);
            closeModal();
            navigate('/channels/@me');
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete server');
        }
    };
    const handleRoleChange = async (userId, role) => {
        try {
            await api.servers.updateMember(currentServerId, userId, { role });
            await loadServerDetail(currentServerId);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update role');
        }
    };
    const handleKick = async (userId) => {
        try {
            await api.servers.removeMember(currentServerId, userId);
            await loadServerDetail(currentServerId);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to kick member');
        }
    };
    return (_jsx(Modal, { isOpen: isOpen, onClose: closeModal, title: "Server Settings", maxWidth: "max-w-xl", children: _jsxs("div", { className: "flex gap-4", children: [_jsxs("div", { className: "w-32 flex-shrink-0 space-y-1", children: [_jsx("button", { onClick: () => setTab('overview'), className: `w-full text-left px-3 py-1.5 rounded text-sm ${tab === 'overview' ? 'bg-discord-bg-active text-white' : 'text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-bg-hover'}`, children: "Overview" }), _jsx("button", { onClick: () => setTab('members'), className: `w-full text-left px-3 py-1.5 rounded text-sm ${tab === 'members' ? 'bg-discord-bg-active text-white' : 'text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-bg-hover'}`, children: "Members" })] }), _jsxs("div", { className: "flex-1 min-w-0", children: [error && (_jsx("div", { className: "mb-3 p-2 bg-discord-red/10 border border-discord-red/30 rounded text-discord-red text-sm", children: error })), tab === 'overview' && (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: "Server Name" }), _jsx("input", { type: "text", value: serverName, onChange: (e) => setServerName(e.target.value), className: "w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple", disabled: !isOwnerUser })] }), isOwnerUser && (_jsxs(_Fragment, { children: [_jsx("button", { onClick: handleSave, disabled: isLoading, className: "px-4 py-2 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-sm font-medium rounded transition-colors disabled:opacity-50", children: isLoading ? 'Saving...' : 'Save Changes' }), _jsxs("div", { className: "pt-4 border-t border-discord-bg-tertiary", children: [_jsx("h3", { className: "text-sm font-bold text-discord-red mb-2", children: "Danger Zone" }), _jsx("button", { onClick: handleDelete, className: "px-4 py-2 bg-discord-red hover:bg-discord-red-hover text-white text-sm font-medium rounded transition-colors", children: confirmDelete ? 'Click again to confirm deletion' : 'Delete Server' })] })] }))] })), tab === 'members' && (_jsx("div", { className: "space-y-2 max-h-[400px] overflow-y-auto", children: members.map((member) => {
                                const displayName = member.user.displayName ?? member.user.username;
                                return (_jsxs("div", { className: "flex items-center justify-between p-2 rounded hover:bg-discord-bg-hover", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Avatar, { src: member.user.avatar, name: displayName, size: 32, status: member.user.status }), _jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: displayName }), _jsx("div", { className: "text-xs text-discord-text-muted capitalize", children: member.role })] })] }), isOwnerUser && member.userId !== currentUser?.id && (_jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("select", { value: member.role, onChange: (e) => handleRoleChange(member.userId, e.target.value), className: "px-2 py-1 bg-discord-bg-tertiary rounded text-xs text-discord-text-secondary outline-none", children: [_jsx("option", { value: "member", children: "Member" }), _jsx("option", { value: "admin", children: "Admin" })] }), _jsx("button", { onClick: () => handleKick(member.userId), className: "px-2 py-1 text-xs text-discord-red hover:bg-discord-red/10 rounded transition-colors", children: "Kick" })] }))] }, member.userId));
                            }) }))] })] }) }));
}
