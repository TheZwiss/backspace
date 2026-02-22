import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './components/auth/LoginPage';
import { RegisterPage } from './components/auth/RegisterPage';
import { AppLayout } from './components/layout/AppLayout';
import { useAuthStore } from './stores/authStore';
function ProtectedRoute({ children }) {
    const token = useAuthStore((s) => s.token);
    if (!token)
        return _jsx(Navigate, { to: "/login", replace: true });
    return _jsx(_Fragment, { children: children });
}
function AuthRedirect({ children }) {
    const token = useAuthStore((s) => s.token);
    if (token)
        return _jsx(Navigate, { to: "/channels/@me", replace: true });
    return _jsx(_Fragment, { children: children });
}
export function App() {
    return (_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(AuthRedirect, { children: _jsx(LoginPage, {}) }) }), _jsx(Route, { path: "/register", element: _jsx(AuthRedirect, { children: _jsx(RegisterPage, {}) }) }), _jsx(Route, { path: "/channels/:serverId/:channelId?", element: _jsx(ProtectedRoute, { children: _jsx(AppLayout, {}) }) }), _jsx(Route, { path: "/join/:inviteCode", element: _jsx(ProtectedRoute, { children: _jsx(AppLayout, {}) }) }), _jsx(Route, { path: "/", element: _jsx(Navigate, { to: "/channels/@me", replace: true }) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/channels/@me", replace: true }) })] }));
}
