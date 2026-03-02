import React, { useState } from 'react';
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

  const handleSubmit = async (e: React.FormEvent) => {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,108,246,0.06)_0%,transparent_50%)]" />
      <div className="w-full max-w-[480px] bg-surface-elevated rounded-md p-8 shadow-elevation-high relative z-10">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-txt-primary">Create an account</h1>
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="mb-4 p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
              {error}
            </div>
          )}

          <div className="mb-5">
            <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
              Username <span className="text-txt-danger">*</span>
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-input border-none rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary transition-all"
              autoFocus
              autoComplete="username"
            />
          </div>

          <div className="mb-5">
            <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-input border-none rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary transition-all"
              autoComplete="name"
            />
          </div>

          <div className="mb-5">
            <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
              Password <span className="text-txt-danger">*</span>
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-input border-none rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary transition-all"
              autoComplete="new-password"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Creating account...' : 'Continue'}
          </button>

          <p className="mt-3 text-sm text-txt-tertiary">
            Already have an account?{' '}
            <Link to="/login" className="text-accent-primary hover:underline">
              Log In
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
