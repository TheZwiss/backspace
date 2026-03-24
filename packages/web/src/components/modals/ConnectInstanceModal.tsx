import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useInstanceConnect } from '../../hooks/useInstanceConnect';

interface ConnectInstanceModalProps {
  domain: string;
  targetDisplayName: string;
  isReconnect?: boolean;
  actionLabel?: string;
  onConnected(result: 'new' | 'reconnect'): void;
  onCancel(): void;
}

export function ConnectInstanceModal({
  domain,
  targetDisplayName,
  isReconnect = false,
  actionLabel,
  onConnected,
  onCancel,
}: ConnectInstanceModalProps) {
  const [password, setPassword] = useState('');
  const { connect, isConnecting, error, clearError } = useInstanceConnect();
  const inputRef = useRef<HTMLInputElement>(null);

  const resolvedLabel = actionLabel
    ?? (isReconnect ? 'Reconnect & Add Friend' : 'Connect & Add Friend');

  // Focus password input on mount
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  // Escape key handler — stop propagation to prevent parent modal from closing
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', handleKey, true); // capture phase
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [onCancel]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim() || isConnecting) return;

    try {
      const result = await connect(domain, password.trim());
      onConnected(result);
    } catch {
      // Error state is managed by the hook — UI updates via `error`
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center animate-fade-in">
      {/* Lighter backdrop to avoid compounding with parent modal */}
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />

      <div className="relative w-full max-w-sm mx-4 glass-modal rounded-lg animate-slide-up overflow-hidden">
        {/* Header */}
        <div className="px-5 pt-5 pb-0">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-accent-lavender/15 flex items-center justify-center flex-shrink-0">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-accent-lavender">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
            </div>
            <h3 className="text-[16px] font-bold text-txt-primary">
              {isReconnect ? 'Reconnect to Instance' : 'Connect to Instance'}
            </h3>
          </div>

          <p className="text-[13px] text-txt-secondary leading-relaxed mb-4">
            {isReconnect ? (
              <>
                Your connection to <strong className="text-txt-primary font-semibold">{domain}</strong> was lost.
                Re-enter your password to reconnect and send a friend request to{' '}
                <strong className="text-txt-primary font-semibold">{targetDisplayName}</strong>.
              </>
            ) : (
              <>
                <strong className="text-txt-primary font-semibold">{targetDisplayName}</strong> is on{' '}
                <strong className="text-txt-primary font-semibold">{domain}</strong>, an instance you
                haven&apos;t connected to yet. Connect to send a friend request.
              </>
            )}
          </p>

          {/* Instance badge */}
          <div className="flex items-center gap-2.5 px-3 py-2.5 bg-white/[0.03] border border-white/[0.06] rounded-lg mb-4">
            <div className="w-7 h-7 rounded-md bg-accent-sky/12 flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-accent-sky">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z" />
              </svg>
            </div>
            <div>
              <div className="text-[12px] font-semibold text-txt-primary">{domain}</div>
              <div className="text-[11px] text-txt-tertiary">Remote Backspace instance</div>
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 pb-5">
          <input
            ref={inputRef}
            type="password"
            className="input-standard w-full py-2.5 mb-1"
            placeholder="Your password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) clearError();
            }}
            disabled={isConnecting}
            autoComplete="current-password"
          />

          {/* Error text */}
          {error && (
            <p className="text-[12px] text-txt-danger mt-1 mb-2">{error}</p>
          )}

          <div className="flex gap-2 mt-3">
            <button
              type="submit"
              disabled={isConnecting || !password.trim()}
              className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold text-white bg-accent-primary hover:bg-accent-primary/80 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isConnecting ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Connecting...
                </>
              ) : (
                resolvedLabel
              )}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isConnecting}
              className="py-2.5 px-4 rounded-lg text-[13px] font-medium text-txt-tertiary border border-white/[0.06] hover:bg-white/[0.06] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
