import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-discord-bg-tertiary">
      <div className="w-full max-w-[480px] bg-discord-bg-primary rounded-md p-8 shadow-2xl">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-discord-text-primary">Welcome back!</h1>
          <p className="text-discord-text-muted mt-1">We're so excited to see you again!</p>
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="mb-4 p-3 bg-discord-red/10 border border-discord-red/30 rounded text-discord-red text-sm">
              {error}
            </div>
          )}

          <div className="mb-5">
            <label className="block text-xs font-bold text-discord-text-secondary uppercase mb-2">
              Username <span className="text-discord-red">*</span>
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2.5 bg-discord-bg-tertiary border-none rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple transition-all"
              autoFocus
              autoComplete="username"
            />
          </div>

          <div className="mb-5">
            <label className="block text-xs font-bold text-discord-text-secondary uppercase mb-2">
              Password <span className="text-discord-red">*</span>
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 bg-discord-bg-tertiary border-none rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple transition-all"
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 bg-discord-blurple hover:bg-discord-blurple-hover text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Logging in...' : 'Log In'}
          </button>

          <p className="mt-3 text-sm text-discord-text-muted">
            Need an account?{' '}
            <Link to="/register" className="text-[#00aff4] hover:underline">
              Register
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
