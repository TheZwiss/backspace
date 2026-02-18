import { create } from 'zustand';
import type { User } from '@opencord/shared';
import { api } from '../api/client';

interface AuthState {
  token: string | null;
  user: User | null;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, displayName?: string) => Promise<void>;
  logout: () => void;
  loadUser: () => Promise<void>;
  updateProfile: (data: { displayName?: string; avatar?: string; customStatus?: string }) => Promise<void>;
  setUser: (user: User) => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('opencord_token'),
  user: null,
  isLoading: false,
  error: null,

  login: async (username: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.auth.login({ username, password });
      localStorage.setItem('opencord_token', response.token);
      set({ token: response.token, user: response.user, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Login failed' });
      throw err;
    }
  },

  register: async (username: string, password: string, displayName?: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.auth.register({ username, password, displayName });
      localStorage.setItem('opencord_token', response.token);
      set({ token: response.token, user: response.user, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Registration failed' });
      throw err;
    }
  },

  logout: () => {
    localStorage.removeItem('opencord_token');
    set({ token: null, user: null });
  },

  loadUser: async () => {
    const token = get().token;
    if (!token) return;

    set({ isLoading: true });
    try {
      const user = await api.users.me();
      set({ user, isLoading: false });
    } catch {
      localStorage.removeItem('opencord_token');
      set({ token: null, user: null, isLoading: false });
    }
  },

  updateProfile: async (data) => {
    try {
      const user = await api.users.update(data);
      set({ user });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Update failed' });
      throw err;
    }
  },

  setUser: (user: User) => set({ user }),

  clearError: () => set({ error: null }),
}));
