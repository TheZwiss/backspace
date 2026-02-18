import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { api } from '../../api/client';
export function NewDmModal() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [isSearching, setIsSearching] = useState(false);
    const [error, setError] = useState('');
    const activeModal = useUIStore((s) => s.activeModal);
    const closeModal = useUIStore((s) => s.closeModal);
    const addDmChannel = useServerStore((s) => s.addDmChannel);
    const navigate = useNavigate();
    const inputRef = useRef(null);
    const searchTimer = useRef();
    const isOpen = activeModal === 'newDm';
    useEffect(() => {
        if (isOpen) {
            setQuery('');
            setResults([]);
            setError('');
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [isOpen]);
    const handleSearch = (value) => {
        setQuery(value);
        setError('');
        if (searchTimer.current) {
            clearTimeout(searchTimer.current);
        }
        if (value.trim().length < 2) {
            setResults([]);
            return;
        }
        searchTimer.current = setTimeout(async () => {
            setIsSearching(true);
            try {
                const users = await api.social.search(value.trim());
                setResults(users);
            }
            catch {
                setResults([]);
            }
            finally {
                setIsSearching(false);
            }
        }, 300);
    };
    const handleSelectUser = async (user) => {
        setError('');
        try {
            const channel = await api.dm.create({ userId: user.id });
            addDmChannel(channel);
            closeModal();
            useUIStore.getState().setShowDms(true);
            navigate(`/channels/@me/${channel.id}`);
        }
        catch (err) {
            setError(err.message || 'Failed to create DM');
        }
    };
    return (_jsx(Modal, { isOpen: isOpen, onClose: closeModal, title: "New Direct Message", children: _jsxs("div", { className: "space-y-3", children: [_jsx("input", { ref: inputRef, type: "text", value: query, onChange: (e) => handleSearch(e.target.value), placeholder: "Search for a user...", className: "w-full px-3 py-2 bg-discord-bg-tertiary text-discord-text-primary placeholder-discord-text-muted/60 rounded-[4px] text-[14px] outline-none focus:ring-1 focus:ring-discord-blurple" }), error && _jsx("p", { className: "text-discord-red text-[13px]", children: error }), _jsxs("div", { className: "max-h-[300px] overflow-y-auto space-y-[2px]", children: [isSearching && _jsx("div", { className: "py-4 text-center text-discord-text-muted text-[14px]", children: "Searching..." }), !isSearching && query.trim().length >= 2 && results.length === 0 && _jsx("div", { className: "py-4 text-center text-discord-text-muted text-[14px]", children: "No users found" }), results.map((user) => (_jsx("button", { onClick: () => handleSelectUser(user), className: "w-full flex items-center gap-3 px-3 py-2 rounded-[4px] hover:bg-discord-modifier-hover transition-colors text-left", children: _jsxs("div", { className: "flex items-center gap-3 flex-1 min-w-0", children: [_jsx(Avatar, { src: user.avatar, name: user.displayName ?? user.username, size: 36, status: user.status }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: "text-[14px] font-medium text-discord-text-primary truncate", children: user.displayName ?? user.username }), _jsxs("div", { className: "text-[12px] text-discord-text-muted truncate", children: ["@", user.username] })] })] }) }, user.id)))] })] }) }));
}
