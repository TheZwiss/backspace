import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { useNavigate } from 'react-router-dom';
export function CreateServerModal() {
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const createServer = useServerStore((s) => s.createServer);
    const activeModal = useUIStore((s) => s.activeModal);
    const closeModal = useUIStore((s) => s.closeModal);
    const navigate = useNavigate();
    const isOpen = activeModal === 'createServer';
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!name.trim()) {
            setError('Server name is required');
            return;
        }
        setIsLoading(true);
        try {
            const server = await createServer(name.trim());
            closeModal();
            setName('');
            navigate(`/channels/${server.id}`);
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create server');
        }
        finally {
            setIsLoading(false);
        }
    };
    return (_jsx(Modal, { isOpen: isOpen, onClose: closeModal, title: "Create a Server", children: _jsxs("form", { onSubmit: handleSubmit, children: [error && (_jsx("div", { className: "mb-3 p-2 bg-discord-red/10 border border-discord-red/30 rounded text-discord-text-danger text-sm", children: error })), _jsxs("div", { className: "mb-4", children: [_jsx("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: "Server Name" }), _jsx("input", { type: "text", value: name, onChange: (e) => setName(e.target.value), className: "w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple", placeholder: "My Awesome Server", autoFocus: true })] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { type: "button", onClick: closeModal, className: "px-4 py-2 text-sm text-discord-text-secondary hover:text-discord-text-primary transition-colors", children: "Cancel" }), _jsx("button", { type: "submit", disabled: isLoading, className: "px-4 py-2 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-sm font-medium rounded transition-colors disabled:opacity-50", children: isLoading ? 'Creating...' : 'Create' })] })] }) }));
}
