import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
export function LoginPage() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const login = useAuthStore((s) => s.login);
    const isLoading = useAuthStore((s) => s.isLoading);
    const navigate = useNavigate();
    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!username.trim()) {
            setError('Username is required');
            return;
        }
        if (!password) {
            setError('Password is required');
            return;
        }
        try {
            await login(username.trim(), password);
            navigate('/channels/@me');
        }
        catch (err) {
            setError(err instanceof Error ? err.message : 'Login failed');
        }
    };
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-discord-bg-tertiary", children: _jsxs("div", { className: "w-full max-w-[480px] bg-discord-bg-primary rounded-md p-8 shadow-2xl", children: [_jsxs("div", { className: "text-center mb-6", children: [_jsx("h1", { className: "text-2xl font-bold text-discord-text-primary", children: "Welcome back!" }), _jsx("p", { className: "text-discord-text-muted mt-1", children: "We're so excited to see you again!" })] }), _jsxs("form", { onSubmit: handleSubmit, children: [error && (_jsx("div", { className: "mb-4 p-3 bg-discord-red/10 border border-discord-red/30 rounded text-discord-red text-sm", children: error })), _jsxs("div", { className: "mb-5", children: [_jsxs("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: ["Username ", _jsx("span", { className: "text-discord-red", children: "*" })] }), _jsx("input", { type: "text", value: username, onChange: (e) => setUsername(e.target.value), className: "w-full px-3 py-2.5 bg-discord-bg-tertiary border-none rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple transition-all", autoFocus: true, autoComplete: "username" })] }), _jsxs("div", { className: "mb-5", children: [_jsxs("label", { className: "block text-xs font-bold text-discord-text-secondary uppercase mb-2", children: ["Password ", _jsx("span", { className: "text-discord-red", children: "*" })] }), _jsx("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), className: "w-full px-3 py-2.5 bg-discord-bg-tertiary border-none rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple transition-all", autoComplete: "current-password" })] }), _jsx("button", { type: "submit", disabled: isLoading, className: "w-full py-2.5 bg-discord-blurple hover:bg-discord-blurple-hover text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed", children: isLoading ? 'Logging in...' : 'Log In' }), _jsxs("p", { className: "mt-3 text-sm text-discord-text-muted", children: ["Need an account?", ' ', _jsx(Link, { to: "/register", className: "text-[#00aff4] hover:underline", children: "Register" })] })] })] }) }));
}
