import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { Avatar } from '../ui/Avatar';
export function UserSettingsModal() {
    const activeModal = useUIStore((s) => s.activeModal);
    const closeModal = useUIStore((s) => s.closeModal);
    const user = useAuthStore((s) => s.user);
    const updateProfile = useAuthStore((s) => s.updateProfile);
    const logout = useAuthStore((s) => s.logout);
    const [displayName, setDisplayName] = useState(user?.displayName ?? '');
    const [customStatus, setCustomStatus] = useState(user?.customStatus ?? '');
    const [status, setStatus] = useState(user?.status ?? 'online');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const isOpen = activeModal === 'userSettings';
    const handleSave = async () => {
        setError('');
        setSuccess('');
        setIsLoading(true);
        try {
            await updateProfile({
                displayName: displayName.trim() || undefined,
                customStatus: customStatus.trim() || undefined,
                status: status,
            });
            setSuccess('Profile updated!');
            setTimeout(() => setSuccess(''), 2000);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update profile');
        }
        finally {
            setIsLoading(false);
        }
    };
    const handleLogout = () => {
        logout();
        closeModal();
    };
    if (!user)
        return null;
    return (_jsx(Modal, { isOpen: isOpen, onClose: closeModal, title: "User Settings", maxWidth: "max-w-lg", children: _jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center gap-4 p-4 bg-discord-bg-secondary rounded-lg", children: [_jsx(Avatar, { src: user.avatar, name: user.displayName ?? user.username, size: 64, status: user.status }), _jsxs("div", { children: [_jsx("div", { className: "font-bold text-lg", children: user.displayName ?? user.username }), _jsxs("div", { className: "text-discord-text-muted text-sm", children: ["@", user.username] }), user.customStatus && (_jsx("div", { className: "text-discord-text-secondary text-sm mt-1", children: user.customStatus }))] })] }), error && (_jsx("div", { className: "p-2 bg-discord-red/10 border border-discord-red/30 rounded text-discord-text-danger text-sm", children: error })), success && (_jsx("div", { className: "p-2 bg-discord-green/10 border border-discord-green/30 rounded text-discord-text-positive text-sm", children: success })), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: "Status" }), _jsxs("select", { value: status, onChange: (e) => setStatus(e.target.value), className: "w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple appearance-none", children: [_jsx("option", { value: "online", children: "Online" }), _jsx("option", { value: "idle", children: "Idle" }), _jsx("option", { value: "dnd", children: "Do Not Disturb" })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: "Display Name" }), _jsx("input", { type: "text", value: displayName, onChange: (e) => setDisplayName(e.target.value), className: "w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple" })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: "Custom Status" }), _jsx("input", { type: "text", value: customStatus, onChange: (e) => setCustomStatus(e.target.value), className: "w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple", placeholder: "What are you up to?" })] }), _jsxs("div", { className: "flex items-center justify-between pt-2", children: [_jsx("button", { onClick: handleLogout, className: "px-4 py-2 text-sm text-discord-red hover:bg-discord-red/10 rounded transition-colors", children: "Log Out" }), _jsx("button", { onClick: handleSave, disabled: isLoading, className: "px-4 py-2 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-sm font-medium rounded transition-colors disabled:opacity-50", children: isLoading ? 'Saving...' : 'Save Changes' })] })] }) }));
}
