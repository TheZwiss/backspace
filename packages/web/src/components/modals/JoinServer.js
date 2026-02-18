import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { useNavigate, useParams } from 'react-router-dom';
export function JoinServerModal() {
    const { inviteCode: urlInviteCode } = useParams();
    const [inviteCode, setInviteCode] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const activeModal = useUIStore((s) => s.activeModal);
    const closeModal = useUIStore((s) => s.closeModal);
    const loadServers = useServerStore((s) => s.loadServers);
    const navigate = useNavigate();
    const isOpen = activeModal === 'joinServer';
    useEffect(() => {
        if (isOpen && urlInviteCode) {
            setInviteCode(urlInviteCode);
        }
    }, [isOpen, urlInviteCode]);
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!inviteCode.trim()) {
            setError('Invite code is required');
            return;
        }
        setIsLoading(true);
        try {
            const token = localStorage.getItem('opencord_token');
            const response = await fetch('/api/servers/join', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({ inviteCode: inviteCode.trim() }),
            });
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to join server');
            }
            const server = await response.json();
            await loadServers();
            closeModal();
            setInviteCode('');
            navigate(`/channels/${server.id}`);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to join server');
        }
        finally {
            setIsLoading(false);
        }
    };
    return (_jsx(Modal, { isOpen: isOpen, onClose: closeModal, title: "Join a Server", children: _jsxs("form", { onSubmit: handleSubmit, children: [_jsx("p", { className: "text-discord-text-secondary text-sm mb-4", children: "Enter an invite code to join an existing server." }), error && (_jsx("div", { className: "mb-3 p-2 bg-discord-red/10 border border-discord-red/30 rounded text-discord-red text-sm", children: error })), _jsxs("div", { className: "mb-4", children: [_jsx("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: "Invite Code" }), _jsx("input", { type: "text", value: inviteCode, onChange: (e) => setInviteCode(e.target.value), className: "w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple", placeholder: "e.g. abc123", autoFocus: true })] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { type: "button", onClick: closeModal, className: "px-4 py-2 text-sm text-discord-text-secondary hover:text-discord-text-primary transition-colors", children: "Cancel" }), _jsx("button", { type: "submit", disabled: isLoading, className: "px-4 py-2 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-sm font-medium rounded transition-colors disabled:opacity-50", children: isLoading ? 'Joining...' : 'Join Server' })] })] }) }));
}
