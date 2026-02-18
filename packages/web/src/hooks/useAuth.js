import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
export function useAuth() {
    const token = useAuthStore((s) => s.token);
    const user = useAuthStore((s) => s.user);
    const isLoading = useAuthStore((s) => s.isLoading);
    const loadUser = useAuthStore((s) => s.loadUser);
    const navigate = useNavigate();
    useEffect(() => {
        if (!token) {
            navigate('/login');
            return;
        }
        if (!user && !isLoading) {
            loadUser();
        }
    }, [token, user, isLoading, loadUser, navigate]);
    return { user, isLoading, isAuthenticated: !!token };
}
