import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { RateLimitError } from '../../api/client';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [retryAfter, setRetryAfter] = useState(0);
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');

  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setInterval(() => {
      setRetryAfter((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAfter]);

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
      if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) {
        navigate(redirect);
      } else {
        navigate('/channels/@me');
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        setRetryAfter(err.retryAfter);
        setError('');
      } else {
        setError(err instanceof Error ? err.message : 'Login failed');
      }
    }
  };

  const isDisabled = isLoading || retryAfter > 0;

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,108,246,0.06)_0%,transparent_50%)]" />
      <div className="w-full max-w-[480px] bg-surface-elevated rounded-md p-8 shadow-elevation-high relative z-10">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-txt-primary">Welcome back!</h1>
          <p className="text-txt-tertiary mt-1">We're so excited to see you again!</p>
        </div>

        <form onSubmit={handleSubmit}>
          {retryAfter > 0 && (
            <div className="mb-4 p-3 bg-accent-amber/10 border border-accent-amber/30 rounded text-sm">
              <p className="font-medium text-accent-amber">Too many login attempts</p>
              <p className="text-txt-secondary mt-0.5">Try again in {retryAfter}s</p>
            </div>
          )}

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
              className="input-standard w-full py-2.5"
              autoFocus
              autoComplete="username"
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
              className="input-standard w-full py-2.5"
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            disabled={isDisabled}
            className="w-full py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {retryAfter > 0
              ? `Try again in ${retryAfter}s`
              : isLoading
                ? 'Logging in...'
                : 'Log In'}
          </button>

          <p className="mt-3 text-sm text-txt-tertiary">
            Need an account?{' '}
            <Link to={`/register${redirect ? `?redirect=${encodeURIComponent(redirect)}` : ''}`} className="text-accent-primary hover:underline">
              Register
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
