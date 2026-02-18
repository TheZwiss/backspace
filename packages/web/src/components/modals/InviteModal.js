import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
export function InviteModal() {
    const [inviteCode, setInviteCode] = useState('');
    const [copied, setCopied] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const activeModal = useUIStore((s) => s.activeModal);
    const closeModal = useUIStore((s) => s.closeModal);
    const generateInvite = useServerStore((s) => s.generateInvite);
    const currentServerId = useServerStore((s) => s.currentServerId);
    const isOpen = activeModal === 'invite';
    useEffect(() => {
        if (isOpen && currentServerId) {
            setIsLoading(true);
            generateInvite(currentServerId)
                .then(code => {
                setInviteCode(code);
                setIsLoading(false);
            })
                .catch(() => setIsLoading(false));
        }
    }, [isOpen, currentServerId, generateInvite]);
    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(inviteCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
        catch {
            // Fallback: select the text
            const input = document.querySelector('.invite-code-input');
            if (input) {
                input.select();
                document.execCommand('copy');
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }
        }
    };
    return (_jsxs(Modal, { isOpen: isOpen, onClose: closeModal, title: "Invite Friends", children: [_jsx("p", { className: "text-discord-text-secondary text-sm mb-4", children: "Share this invite code with friends to let them join your server." }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("input", { type: "text", value: isLoading ? 'Generating...' : inviteCode, readOnly: true, className: "invite-code-input flex-1 px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none font-mono text-sm" }), _jsx("button", { onClick: handleCopy, disabled: isLoading, className: `px-4 py-2 text-sm font-medium rounded transition-colors ${copied
                            ? 'bg-discord-green text-white'
                            : 'bg-discord-blurple hover:bg-discord-blurple-hover text-white'}`, children: copied ? 'Copied!' : 'Copy' })] })] }));
}
