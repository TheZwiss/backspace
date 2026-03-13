import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useSpaceStore, NotConnectedError } from '../stores/spaceStore';
import { useInstanceStore, DifferentPasswordError } from '../stores/instanceStore';
import { api, createApiClient } from '../api/client';
import { parseInviteInput } from '../utils/inviteParser';
import { Avatar } from './ui/Avatar';
import type { InvitePreview } from '@backspace/shared';

type JoinPhase = 'preview' | 'connect' | 'fallback' | 'other-instance' | 'already-member';

export function JoinPage() {
  const { inviteCode: rawInviteCode } = useParams<{ inviteCode: string }>();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const loadUser = useAuthStore((s) => s.loadUser);
  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const logout = useAuthStore((s) => s.logout);
  const joinByCode = useSpaceStore((s) => s.joinByCode);
  const connectToRemote = useInstanceStore((s) => s.connectToRemote);
  const loginToRemote = useInstanceStore((s) => s.loginToRemote);

  // Hydrate auth store when token exists — useAuth() can't be used here because
  // it hard-redirects to /login when there's no token, and JoinPage is a public route.
  useEffect(() => {
    if (token && !user && !isAuthLoading) {
      loadUser();
    }
  }, [token, user, isAuthLoading, loadUser]);

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [isLoadingPreview, setIsLoadingPreview] = useState(true);

  const [phase, setPhase] = useState<JoinPhase>('preview');
  const [error, setError] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  // Federation connect state
  const [password, setPassword] = useState('');
  const [fallbackUsername, setFallbackUsername] = useState('');
  const [fallbackPassword, setFallbackPassword] = useState('');

  // Other instance state
  const [otherDomain, setOtherDomain] = useState('');

  // Parse the invite code from the URL
  const parsed = useMemo(() => {
    if (!rawInviteCode) return null;
    try {
      return parseInviteInput(rawInviteCode);
    } catch {
      return null;
    }
  }, [rawInviteCode]);

  // Fetch preview on mount
  useEffect(() => {
    if (!rawInviteCode) {
      setPreviewError('No invite code provided');
      setIsLoadingPreview(false);
      return;
    }

    if (!parsed) {
      setPreviewError('Invalid invite code');
      setIsLoadingPreview(false);
      return;
    }

    setIsLoadingPreview(true);
    setPreviewError('');

    const fetchPreview = async () => {
      try {
        let client;
        if (parsed.origin) {
          client = createApiClient(parsed.origin, () => null);
        } else {
          client = api;
        }
        const data = await client.spaces.invitePreview(parsed.code);
        setPreview(data);
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : 'Failed to load invite');
      } finally {
        setIsLoadingPreview(false);
      }
    };

    fetchPreview();
  }, [rawInviteCode, parsed]);

  // Join handler
  const handleJoin = async () => {
    if (!parsed) return;
    setError('');
    setIsJoining(true);
    try {
      const space = await joinByCode(parsed.code, parsed.origin || undefined);
      navigate(`/channels/${space.id}`);
    } catch (err) {
      if (err instanceof NotConnectedError) {
        setPhase('connect');
        setError('');
      } else {
        const msg = err instanceof Error ? err.message : 'Failed to join space';
        if (msg.toLowerCase().includes('already a member')) {
          setPhase('already-member');
          setError('');
        } else {
          setError(msg);
        }
      }
    } finally {
      setIsJoining(false);
    }
  };

  // Federation connect handler
  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsed?.origin) return;
    setError('');
    setIsJoining(true);
    try {
      await connectToRemote(parsed.origin, password, user?.displayName || undefined);
      const space = await joinByCode(parsed.code, parsed.origin);
      navigate(`/channels/${space.id}`);
    } catch (err) {
      if (err instanceof DifferentPasswordError) {
        setPhase('fallback');
        setFallbackUsername(err.remoteUsername);
        setFallbackPassword('');
        setError('');
      } else {
        const msg = err instanceof Error ? err.message : 'Failed to connect';
        if (msg.toLowerCase().includes('already a member')) {
          setPhase('already-member');
          setError('');
        } else {
          setError(msg);
        }
      }
    } finally {
      setIsJoining(false);
    }
  };

  // Fallback login handler
  const handleFallbackLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsed?.origin) return;
    setError('');
    setIsJoining(true);
    try {
      await loginToRemote(parsed.origin, fallbackUsername, fallbackPassword);
      const space = await joinByCode(parsed.code, parsed.origin);
      navigate(`/channels/${space.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to log in';
      if (msg.toLowerCase().includes('already a member')) {
        setPhase('already-member');
        setError('');
      } else {
        setError(msg);
      }
    } finally {
      setIsJoining(false);
    }
  };

  // Other instance redirect
  const handleOtherInstanceRedirect = (e: React.FormEvent) => {
    e.preventDefault();
    const domain = otherDomain.trim();
    if (!domain) return;

    // Build the qualified invite code: code@thisHost
    const thisHost = window.location.host;
    const code = parsed?.code || rawInviteCode || '';
    const qualifiedCode = `${code}@${thisHost}`;
    const targetUrl = `https://${domain}/join/${encodeURIComponent(qualifiedCode)}`;
    window.location.href = targetUrl;
  };

  let hostDisplay = '';
  try {
    if (parsed?.origin) hostDisplay = new URL(parsed.origin).host;
  } catch { /* ignore */ }

  const redirectParam = rawInviteCode ? `?redirect=/join/${encodeURIComponent(rawInviteCode)}` : '';

  // Loading state
  if (isLoadingPreview) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-base relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,108,246,0.06)_0%,transparent_50%)]" />
        <div className="text-center relative z-10">
          <svg className="animate-spin w-10 h-10 text-accent-primary mx-auto mb-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-txt-tertiary">Loading invite...</p>
        </div>
      </div>
    );
  }

  // Error state — invalid/expired invite
  if (previewError || !preview) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-base relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,108,246,0.06)_0%,transparent_50%)]" />
        <div className="w-full max-w-[420px] bg-surface-elevated rounded-md p-8 shadow-elevation-high relative z-10 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-accent-rose/10 flex items-center justify-center">
            <svg className="w-8 h-8 text-accent-rose" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-txt-primary mb-2">Invalid Invite</h1>
          <p className="text-txt-secondary text-sm mb-6">
            {previewError || 'This invite link is invalid or has expired.'}
          </p>
          {token ? (
            <button
              onClick={() => navigate('/channels/@me')}
              className="px-6 py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors"
            >
              Back to Backspace
            </button>
          ) : (
            <Link
              to="/login"
              className="inline-block px-6 py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors"
            >
              Log In
            </Link>
          )}
        </div>
      </div>
    );
  }

  // Main invite page
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-base relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(124,108,246,0.06)_0%,transparent_50%)]" />
      <div className="w-full max-w-[420px] bg-surface-elevated rounded-md p-8 shadow-elevation-high relative z-10">
        {/* Space preview */}
        <div className="text-center mb-6">
          <div className="flex justify-center mb-4">
            <Avatar
              src={preview.icon ? (parsed?.origin ? `${parsed.origin}/api/uploads/${preview.icon}` : preview.icon) : null}
              name={preview.spaceName}
              size={72}
              avatarColor={preview.avatarColor}
            />
          </div>
          <p className="text-xs text-txt-tertiary uppercase tracking-wide mb-1">You've been invited to join</p>
          <h1 className="text-2xl font-bold text-txt-primary">{preview.spaceName}</h1>
          {preview.description && (
            <p className="text-txt-secondary text-sm mt-2">{preview.description}</p>
          )}
          <div className="flex items-center justify-center gap-4 mt-3 text-xs text-txt-tertiary">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-txt-tertiary/40" />
              {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
            </span>
            <span>{preview.instanceName}</span>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
            {error}
          </div>
        )}

        {/* Phase: preview — main join UI */}
        {phase === 'preview' && (
          <>
            {token && user ? (
              /* Authenticated user — show identity card + join */
              <div className="space-y-3">
                <div className="flex items-center gap-3 bg-surface-input rounded-lg p-3">
                  <Avatar
                    src={user.avatar || null}
                    name={user.displayName || user.username}
                    size={40}
                    avatarColor={user.avatarColor}
                  />
                  <div className="min-w-0">
                    <p className="text-txt-primary font-medium text-sm truncate">{user.displayName || user.username}</p>
                    <p className="text-txt-tertiary text-xs truncate">@{user.username}</p>
                  </div>
                </div>
                <button
                  onClick={handleJoin}
                  disabled={isJoining}
                  className="w-full py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isJoining ? 'Joining...' : `Join as ${user.displayName || user.username}`}
                </button>
                <p className="text-center text-xs text-txt-tertiary">
                  Not you?{' '}
                  <button
                    type="button"
                    onClick={() => { logout(); navigate(`/login${redirectParam}`); }}
                    className="text-accent-primary hover:underline"
                  >
                    Log in
                  </button>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => { setPhase('other-instance'); setError(''); }}
                    className="text-accent-primary hover:underline"
                  >
                    I use another instance
                  </button>
                </p>
              </div>
            ) : token ? (
              /* Token exists but user still loading */
              <button
                disabled
                className="w-full py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Loading...
              </button>
            ) : (
              /* Unauthenticated user */
              <div className="space-y-3">
                <Link
                  to={`/login${redirectParam}`}
                  className="block w-full py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors text-center"
                >
                  Log in to join
                </Link>
                <Link
                  to={`/register${redirectParam}`}
                  className="block w-full py-2.5 bg-surface-input hover:bg-surface-input/80 text-txt-primary font-medium rounded transition-colors text-center"
                >
                  Create an account
                </Link>

                {/* Divider */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-border-subtle" />
                  <span className="text-xs text-txt-tertiary">or</span>
                  <div className="flex-1 h-px bg-border-subtle" />
                </div>

                <button
                  type="button"
                  onClick={() => { setPhase('other-instance'); setError(''); }}
                  className="block w-full py-2.5 bg-surface-input hover:bg-surface-input/80 text-txt-primary font-medium rounded transition-colors text-center"
                >
                  I use another instance
                </button>
              </div>
            )}
          </>
        )}

        {/* Phase: other-instance — domain input for federation redirect */}
        {phase === 'other-instance' && (
          <form onSubmit={handleOtherInstanceRedirect}>
            <label className="block text-xs font-bold text-txt-secondary uppercase mb-1.5">
              Your instance domain
            </label>
            <div className="flex gap-2 mb-1.5">
              <input
                type="text"
                value={otherDomain}
                onChange={(e) => setOtherDomain(e.target.value)}
                placeholder="e.g. my-instance.com"
                className="flex-1 px-3 py-2 bg-surface-input rounded text-txt-primary text-sm outline-none focus:ring-2 focus:ring-accent-primary"
                autoFocus
              />
              <button
                type="submit"
                disabled={!otherDomain.trim()}
                className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
              >
                Go
              </button>
            </div>
            <p className="text-xs text-txt-tertiary mb-4">
              You'll be redirected to your home instance to complete joining.
            </p>
            <button
              type="button"
              onClick={() => { setPhase('preview'); setOtherDomain(''); setError(''); }}
              className="px-4 py-2.5 text-txt-tertiary hover:text-txt-secondary text-sm transition-colors"
            >
              Back
            </button>
          </form>
        )}

        {/* Phase: connect — password prompt for federation */}
        {phase === 'connect' && (
          <form onSubmit={handleConnect}>
            {/* Identity card */}
            <div className="flex items-center gap-3 bg-surface-input rounded-lg p-3 mb-3">
              <Avatar
                src={user?.avatar || null}
                name={user?.displayName || user?.username || '?'}
                size={40}
                avatarColor={user?.avatarColor}
              />
              <div className="min-w-0">
                <p className="text-txt-primary font-medium text-sm truncate">{user?.displayName || user?.username}</p>
                <p className="text-txt-tertiary text-xs truncate">@{user?.username}</p>
              </div>
            </div>
            <p className="text-txt-tertiary text-xs mb-4">
              Connecting to <span className="text-txt-secondary font-medium">{hostDisplay}</span>
            </p>
            <div className="mb-4">
              <label className="block text-xs text-txt-tertiary mb-1">
                Enter your password to connect
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your account password"
                className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary text-sm outline-none focus:ring-2 focus:ring-accent-primary"
                disabled={isJoining}
                autoFocus
              />
              <p className="text-xs text-txt-tertiary mt-1">
                Your password is verified locally, then used to create or access your account on the remote instance.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setPhase('preview'); setPassword(''); setError(''); }}
                className="px-4 py-2.5 text-txt-tertiary hover:text-txt-secondary text-sm transition-colors"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={isJoining || !password}
                className="flex-1 py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isJoining ? 'Connecting...' : 'Connect & Join'}
              </button>
            </div>
          </form>
        )}

        {/* Phase: already-member — green success with auto-redirect */}
        {phase === 'already-member' && preview && (
          <AlreadyMemberCard spaceName={preview.spaceName} spaceId={preview.spaceId} navigate={navigate} />
        )}

        {/* Phase: fallback — different password on remote */}
        {phase === 'fallback' && (
          <form onSubmit={handleFallbackLogin}>
            <div className="mb-3 p-2 bg-accent-amber/10 border border-accent-amber/30 rounded text-xs text-accent-amber">
              An account already exists on {hostDisplay} with a different password. Enter the credentials you used on that instance.
            </div>
            <div className="mb-4 space-y-3">
              <div>
                <label className="block text-xs text-txt-tertiary mb-1">Username</label>
                <input
                  type="text"
                  value={fallbackUsername}
                  onChange={(e) => setFallbackUsername(e.target.value)}
                  placeholder="Your username on this instance"
                  className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary text-sm outline-none focus:ring-2 focus:ring-accent-primary"
                  disabled={isJoining}
                />
              </div>
              <div>
                <label className="block text-xs text-txt-tertiary mb-1">Password for this instance</label>
                <input
                  type="password"
                  value={fallbackPassword}
                  onChange={(e) => setFallbackPassword(e.target.value)}
                  placeholder="Password on the remote instance"
                  className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary text-sm outline-none focus:ring-2 focus:ring-accent-primary"
                  disabled={isJoining}
                  autoFocus
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setPhase('connect'); setFallbackPassword(''); setError(''); }}
                className="px-4 py-2.5 text-txt-tertiary hover:text-txt-secondary text-sm transition-colors"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={isJoining || !fallbackUsername || !fallbackPassword}
                className="flex-1 py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isJoining ? 'Logging in...' : 'Login & Join'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function AlreadyMemberCard({ spaceName, spaceId, navigate }: { spaceName: string; spaceId: string; navigate: (path: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => navigate(`/channels/${spaceId}`), 2000);
    return () => clearTimeout(timer);
  }, [spaceId, navigate]);

  return (
    <div className="text-center">
      <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-accent-mint/10 flex items-center justify-center">
        <svg className="w-6 h-6 text-accent-mint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <p className="text-txt-primary font-medium mb-1">You're already in {spaceName}!</p>
      <p className="text-txt-tertiary text-xs mb-4">Redirecting you now...</p>
      <button
        onClick={() => navigate(`/channels/${spaceId}`)}
        className="px-6 py-2.5 bg-accent-primary hover:bg-accent-primary/80 text-white font-medium rounded transition-colors"
      >
        Go to {spaceName}
      </button>
    </div>
  );
}
