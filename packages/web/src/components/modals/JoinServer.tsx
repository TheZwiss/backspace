import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore, NotConnectedError } from '../../stores/serverStore';
import { useInstanceStore, DifferentPasswordError } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';
import { useNavigate, useParams } from 'react-router-dom';
import { parseInviteInput } from '../../utils/inviteParser';

type JoinPhase = 'input' | 'connect' | 'fallback';

export function JoinServerModal() {
  const { inviteCode: urlInviteCode } = useParams<{ inviteCode?: string }>();
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [phase, setPhase] = useState<JoinPhase>('input');
  const [parsedCode, setParsedCode] = useState('');
  const [parsedOrigin, setParsedOrigin] = useState('');
  const [password, setPassword] = useState('');
  const [fallbackUsername, setFallbackUsername] = useState('');
  const [fallbackPassword, setFallbackPassword] = useState('');

  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const joinByCode = useServerStore((s) => s.joinByCode);
  const connectToRemote = useInstanceStore((s) => s.connectToRemote);
  const loginToRemote = useInstanceStore((s) => s.loginToRemote);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const isOpen = activeModal === 'joinServer';

  // Pre-fill from URL param and reset state on open/close
  useEffect(() => {
    if (isOpen) {
      if (urlInviteCode) setInviteCode(urlInviteCode);
    } else {
      // Reset all state when modal closes
      setInviteCode('');
      setError('');
      setPhase('input');
      setParsedCode('');
      setParsedOrigin('');
      setPassword('');
      setFallbackUsername('');
      setFallbackPassword('');
    }
  }, [isOpen, urlInviteCode]);

  const joinAndNavigate = async (code: string, origin?: string) => {
    const server = await joinByCode(code, origin || undefined);
    closeModal();
    navigate(`/channels/${server.id}`);
  };

  // Phase 1: Submit invite code/URL
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    let parsed: { code: string; origin?: string };
    try {
      parsed = parseInviteInput(inviteCode);
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    setParsedCode(parsed.code);
    setParsedOrigin(parsed.origin || '');

    setIsLoading(true);
    try {
      await joinAndNavigate(parsed.code, parsed.origin);
    } catch (err) {
      if (err instanceof NotConnectedError) {
        setPhase('connect');
        setError('');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to join server');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Phase 2: Connect to remote instance with password, then join
  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await connectToRemote(parsedOrigin, password, user?.displayName || undefined);
      await joinAndNavigate(parsedCode, parsedOrigin);
    } catch (err) {
      if (err instanceof DifferentPasswordError) {
        setPhase('fallback');
        setFallbackUsername(err.remoteUsername);
        setFallbackPassword('');
        setError('');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Phase 3: Fallback login with different credentials, then join
  const handleFallbackLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      await loginToRemote(parsedOrigin, fallbackUsername, fallbackPassword);
      await joinAndNavigate(parsedCode, parsedOrigin);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  let hostDisplay = '';
  try {
    if (parsedOrigin) hostDisplay = new URL(parsedOrigin).host;
  } catch { /* ignore */ }

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Join a Server">
      {/* Error display (shared across all phases) */}
      {error && (
        <div className="mb-3 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {error}
        </div>
      )}

      {/* Phase: input — enter invite code or URL */}
      {phase === 'input' && (
        <form onSubmit={handleSubmit}>
          <p className="text-txt-secondary text-sm mb-4">
            Enter an invite code or link to join a server.
          </p>
          <div className="mb-4">
            <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
              Invite Code or Link
            </label>
            <input
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary"
              placeholder="e.g. abc123 or https://instance.com/join/abc123"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeModal}
              className="px-4 py-2 text-sm text-txt-secondary hover:text-txt-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !inviteCode.trim()}
              className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Joining...' : 'Join Server'}
            </button>
          </div>
        </form>
      )}

      {/* Phase: connect — password prompt to connect to remote instance */}
      {phase === 'connect' && (
        <form onSubmit={handleConnect}>
          <p className="text-txt-secondary text-sm mb-4">
            Connect to <span className="text-txt-primary font-medium">{hostDisplay}</span> to join this server.
          </p>
          <div className="mb-4 space-y-2">
            <div>
              <label className="block text-xs text-txt-tertiary mb-1">
                Enter your password to connect
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your account password"
                className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary text-sm outline-none focus:ring-2 focus:ring-accent-primary"
                disabled={isLoading}
                autoFocus
              />
              <div className="text-xs text-txt-tertiary mt-1">
                Your password is verified locally, then used to create or access your account on the remote instance.
              </div>
            </div>
          </div>
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => { setPhase('input'); setPassword(''); setError(''); }}
              className="text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              Back
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={closeModal}
                className="px-4 py-2 text-sm text-txt-secondary hover:text-txt-primary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading || !password}
                className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
              >
                {isLoading ? 'Connecting...' : 'Connect & Join'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Phase: fallback — different password on remote instance */}
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
                disabled={isLoading}
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
                disabled={isLoading}
                autoFocus
              />
            </div>
          </div>
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => { setPhase('connect'); setFallbackPassword(''); setError(''); }}
              className="text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              Back
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={closeModal}
                className="px-4 py-2 text-sm text-txt-secondary hover:text-txt-primary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading || !fallbackUsername || !fallbackPassword}
                className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
              >
                {isLoading ? 'Logging in...' : 'Login & Join'}
              </button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
