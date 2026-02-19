import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
export function RegisterPage() {
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const register = useAuthStore((s) => s.register);
    const isLoading = useAuthStore((s) => s.isLoading);
    const navigate = useNavigate();
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!username.trim()) {
            setError('Username is required');
            return;
        }
        if (username.trim().length < 3 || username.trim().length > 32) {
            setError('Username must be between 3 and 32 characters');
            return;
        }
        if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
            setError('Username can only contain letters, numbers, and underscores');
            return;
        }
        if (!password) {
            setError('Password is required');
            return;
        }
        if (password.length < 6) {
            setError('Password must be at least 6 characters');
            return;
        }
        try {
            await register(username.trim(), password, displayName.trim() || undefined);
            navigate('/channels/@me');
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Registration failed');
        }
    };
    return (_jsxs("div", { className: "min-h-screen flex items-center justify-center bg-[#080a0b] relative", children: [_jsx("div", { className: "absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(88,101,242,0.06)_0%,transparent_50%)]" }), _jsxs("div", { className: "w-full max-w-[480px] bg-discord-bg-surface rounded-md p-8 shadow-elevation-high relative z-10", children: [_jsx("div", { className: "text-center mb-6", children: _jsx("h1", { className: "text-2xl font-bold text-discord-text-primary", children: "Create an account" }) }), _jsxs("form", { onSubmit: handleSubmit, children: [error && (_jsx("div", { className: "mb-4 p-3 bg-discord-red/10 border border-discord-red/30 rounded text-discord-text-danger text-sm", children: error })), _jsxs("div", { className: "mb-5", children: [_jsxs("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: ["Username ", _jsx("span", { className: "text-discord-red", children: "*" })] }), _jsx("input", { type: "text", value: username, onChange: (e) => setUsername(e.target.value), className: "w-full px-3 py-2.5 bg-discord-bg-tertiary border-none rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple transition-all", autoFocus: true, autoComplete: "username" })] }), _jsxs("div", { className: "mb-5", children: [_jsx("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: "Display Name" }), _jsx("input", { type: "text", value: displayName, onChange: (e) => setDisplayName(e.target.value), className: "w-full px-3 py-2.5 bg-discord-bg-tertiary border-none rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple transition-all", autoComplete: "name" })] }), _jsxs("div", { className: "mb-5", children: [_jsxs("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: ["Password ", _jsx("span", { className: "text-discord-red", children: "*" })] }), _jsx("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), className: "w-full px-3 py-2.5 bg-discord-bg-tertiary border-none rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple transition-all", autoComplete: "new-password" })] }), _jsx("button", { type: "submit", disabled: isLoading, className: "w-full py-2.5 bg-discord-blurple hover:bg-discord-blurple-hover text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed", children: isLoading ? 'Creating account...' : 'Continue' }), _jsxs("p", { className: "mt-3 text-sm text-discord-text-muted", children: ["Already have an account?", ' ', _jsx(Link, { to: "/login", className: "text-discord-text-link hover:underline", children: "Log In" })] })] })] })] }));
}
