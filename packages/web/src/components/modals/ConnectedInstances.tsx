import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import type { InstanceInfoResponse, FederationRegistryEntry } from '@backspace/shared';
import { useInstanceStore, DifferentPasswordError } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';
import { isElectron } from '../../platform/platform';
import { ConfirmDialog } from '../ui/ConfirmDialog';

// ─── URL helpers ─────────────────────────────────────────────────────────────

function safeHost(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

// ─── Status indicator ────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const colorClass =
    status === 'connected' ? 'bg-status-online' :
    status === 'connecting' ? 'bg-accent-amber' :
    'bg-txt-tertiary';

  return <div className={`w-2 h-2 rounded-full shrink-0 ${colorClass}`} />;
}

// ─── Registry status helpers ────────────────────────────────────────────────

function registryStatusColor(status: string): string {
  switch (status) {
    case 'connected': return 'bg-status-online/15 text-status-online';
    case 'disconnected': return 'bg-white/5 text-txt-tertiary';
    case 'unreachable': return 'bg-accent-amber/15 text-accent-amber';
    case 'auth_expired': return 'bg-accent-rose/15 text-accent-rose';
    default: return 'bg-white/5 text-txt-tertiary';
  }
}

function registryStatusDotColor(status: string): string {
  switch (status) {
    case 'connected': return 'bg-status-online';
    case 'unreachable': return 'bg-accent-amber';
    case 'auth_expired': return 'bg-accent-rose';
    default: return 'bg-txt-tertiary';
  }
}

function registryStatusLabel(status: string): string {
  switch (status) {
    case 'connected': return 'Connected';
    case 'disconnected': return 'Disconnected';
    case 'unreachable': return 'Unreachable';
    case 'auth_expired': return 'Auth Expired';
    default: return status;
  }
}

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatAbsoluteDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Add Instance flow ───────────────────────────────────────────────────────

type AddStep = 'url' | 'auth' | 'done';
type AuthPhase = 'password' | 'fallback-login';

function AddInstanceFlow({ onDone }: { onDone: () => void }) {
  const user = useAuthStore((s) => s.user);
  const connectToRemote = useInstanceStore((s) => s.connectToRemote);
  const loginToRemote = useInstanceStore((s) => s.loginToRemote);
  const probeInstance = useInstanceStore((s) => s.probeInstance);

  const [step, setStep] = useState<AddStep>('url');
  const [url, setUrl] = useState('');
  const [probeResult, setProbeResult] = useState<(InstanceInfoResponse & { origin: string }) | null>(null);
  const [authPhase, setAuthPhase] = useState<AuthPhase>('password');
  const [password, setPassword] = useState('');
  const [fallbackUsername, setFallbackUsername] = useState('');
  const [fallbackPassword, setFallbackPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleProbe = async () => {
    setError('');
    setIsLoading(true);
    try {
      const result = await probeInstance(url);
      setProbeResult(result);
      setAuthPhase('password');
      setStep('auth');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnect = async () => {
    if (!probeResult) return;
    setError('');
    setIsLoading(true);
    try {
      await connectToRemote(
        probeResult.origin,
        password,
        user?.displayName || undefined,
      );
      setStep('done');
      onDone();
    } catch (err) {
      if (err instanceof DifferentPasswordError) {
        setAuthPhase('fallback-login');
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

  const handleFallbackLogin = async () => {
    if (!probeResult) return;
    setError('');
    setIsLoading(true);
    try {
      await loginToRemote(probeResult.origin, fallbackUsername, fallbackPassword);
      setStep('done');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  if (step === 'done') return null;

  return (
    <div className="mt-3 p-3 bg-surface-channel rounded-lg space-y-3">
      {/* Step 1: Enter URL */}
      {step === 'url' && (
        <>
          <div className="text-sm text-txt-primary font-medium">Add Remote Instance</div>
          <div className="flex gap-2">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isLoading && url.trim() && handleProbe()}
              placeholder="https://instance.example.com"
              className="input-standard flex-1"
              disabled={isLoading}
            />
            <button
              onClick={handleProbe}
              disabled={isLoading || !url.trim()}
              className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Probing...' : 'Connect'}
            </button>
          </div>
          <button
            onClick={onDone}
            className="text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
          >
            Cancel
          </button>
        </>
      )}

      {/* Step 2: Auth — single password */}
      {step === 'auth' && probeResult && authPhase === 'password' && (
        <>
          {/* Instance info card */}
          <div className="flex items-center gap-2">
            <StatusDot status="connecting" />
            <div>
              <div className="text-sm text-txt-primary font-medium">{probeResult.name}</div>
              <div className="text-xs text-txt-tertiary">{probeResult.origin}</div>
            </div>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); handleConnect(); }} className="space-y-2">
            <input type="text" autoComplete="username" value={user?.username || ''} readOnly tabIndex={-1} className="sr-only" />
            <div>
              <label className="block text-xs text-txt-tertiary mb-1">
                Enter your password to connect to {new URL(probeResult.origin).host}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your account password"
                className="input-standard w-full"
                disabled={isLoading}
                autoFocus
                autoComplete="current-password"
              />
              <div className="text-xs text-txt-tertiary mt-1">
                Your password is verified locally, then used to create or access your account on the remote instance.
              </div>
            </div>
            <button
              type="submit"
              disabled={isLoading || !password}
              className="w-full px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Connecting...' : 'Connect'}
            </button>
          </form>

          <div className="flex gap-2">
            <button
              onClick={() => { setStep('url'); setProbeResult(null); setError(''); }}
              className="text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              Back
            </button>
            <button
              onClick={onDone}
              className="text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {/* Step 2b: Fallback login — different password on remote */}
      {step === 'auth' && probeResult && authPhase === 'fallback-login' && (
        <>
          {/* Instance info card */}
          <div className="flex items-center gap-2">
            <StatusDot status="connecting" />
            <div>
              <div className="text-sm text-txt-primary font-medium">{probeResult.name}</div>
              <div className="text-xs text-txt-tertiary">{probeResult.origin}</div>
            </div>
          </div>

          <div className="p-2 bg-accent-amber/10 border border-accent-amber/30 rounded text-xs text-accent-amber">
            An account already exists on this instance with a different password. Enter the credentials you used on that instance.
          </div>

          <form onSubmit={(e) => { e.preventDefault(); handleFallbackLogin(); }} className="space-y-2">
            <div>
              <label className="block text-xs text-txt-tertiary mb-1">Username</label>
              <input
                type="text"
                value={fallbackUsername}
                onChange={(e) => setFallbackUsername(e.target.value)}
                placeholder="Your username on this instance"
                className="input-standard w-full"
                disabled={isLoading}
                autoComplete="username"
              />
            </div>
            <div>
              <label className="block text-xs text-txt-tertiary mb-1">Password for this instance</label>
              <input
                type="password"
                value={fallbackPassword}
                onChange={(e) => setFallbackPassword(e.target.value)}
                placeholder="Password on the remote instance"
                className="input-standard w-full"
                disabled={isLoading}
                autoFocus
                autoComplete="current-password"
              />
            </div>
            <button
              type="submit"
              disabled={isLoading || !fallbackUsername || !fallbackPassword}
              className="w-full px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Logging in...' : 'Login & Connect'}
            </button>
          </form>

          <div className="flex gap-2">
            <button
              onClick={() => { setAuthPhase('password'); setPassword(''); setError(''); }}
              className="text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              Back
            </button>
            <button
              onClick={onDone}
              className="text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {/* Error display */}
      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">
          {error}
        </div>
      )}
    </div>
  );
}

// ─── Filter / Sort types ────────────────────────────────────────────────────

type StatusFilter = 'all' | 'connected' | 'disconnected' | 'issues';
type SortBy = 'name' | 'dateAdded' | 'lastConnected';

// ─── RegistryFilterBar ──────────────────────────────────────────────────────

function RegistryFilterBar({
  filter,
  setFilter,
  sortBy,
  setSortBy,
  counts,
}: {
  filter: StatusFilter;
  setFilter: (f: StatusFilter) => void;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
  counts: { all: number; connected: number; disconnected: number; issues: number };
}) {
  const [sortOpen, setSortOpen] = useState(false);

  const tabs: Array<{ key: StatusFilter; label: string; count: number }> = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'connected', label: 'Connected', count: counts.connected },
    { key: 'disconnected', label: 'Disconnected', count: counts.disconnected },
    { key: 'issues', label: 'Issues', count: counts.issues },
  ];

  const sortOptions: Array<{ key: SortBy; label: string }> = [
    { key: 'name', label: 'Name (A-Z)' },
    { key: 'dateAdded', label: 'Date Added' },
    { key: 'lastConnected', label: 'Last Connected' },
  ];

  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex bg-white/[0.04] rounded-md p-0.5">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setFilter(tab.key)}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              filter === tab.key ? 'bg-white/[0.08] text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary'
            }`}
          >
            {tab.label} <span className="text-[10px] text-txt-tertiary ml-0.5">{tab.count}</span>
          </button>
        ))}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setSortOpen(!sortOpen)}
          className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-txt-tertiary hover:text-txt-secondary bg-white/[0.04] hover:bg-white/[0.06] rounded transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="opacity-60">
            <path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Sort
          <span className="text-[10px]">&#9662;</span>
        </button>

        {sortOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setSortOpen(false)} />
            <div className="absolute right-0 top-full mt-1 z-50 glass rounded-lg p-1.5 w-44">
              <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-2 py-1">Sort by</div>
              {sortOptions.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => { setSortBy(opt.key); setSortOpen(false); }}
                  className={`w-full text-left px-2 py-1.5 text-xs rounded ${
                    sortBy === opt.key ? 'text-accent-lavender bg-accent-lavender/[0.08]' : 'text-txt-primary'
                  } hover:bg-white/[0.06] transition-colors`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── DeleteIdentityDialog ───────────────────────────────────────────────────

type DeletionMode = 'leave' | 'nuke' | 'evaporate';
type DeletionScope = 'this' | 'select' | 'all';

function DeleteIdentityDialog({
  origin,
  label,
  onClose,
}: {
  origin: string;
  label: string;
  onClose: () => void;
}) {
  const deleteIdentity = useInstanceStore((s) => s.deleteIdentity);
  const [mode, setMode] = useState<DeletionMode>('leave');
  const [scope, setScope] = useState<DeletionScope>('this');

  const handleConfirm = () => {
    deleteIdentity([origin]);
    onClose();
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center animate-fade-in">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className="relative max-w-md w-full mx-4 glass-modal rounded-xl p-6 animate-slide-up">
        <h3 className="text-base font-semibold text-txt-primary mb-1">Delete Identity</h3>
        <p className="text-xs text-txt-tertiary mb-4">
          Remove your federated identity on <span className="text-txt-secondary font-medium">{label}</span>. Choose how your data should be handled.
        </p>

        {/* Deletion mode selection */}
        <div className="space-y-2 mb-4">
          {/* Leave quietly */}
          <button
            type="button"
            onClick={() => setMode('leave')}
            className={`w-full text-left p-3 rounded-lg border transition-colors ${
              mode === 'leave'
                ? 'bg-white/[0.03] border-white/[0.08]'
                : 'bg-transparent border-white/[0.04] hover:border-white/[0.06]'
            }`}
          >
            <div className="text-sm font-medium text-txt-primary">Leave quietly</div>
            <div className="text-[11px] text-txt-tertiary mt-0.5">
              Remove the connection. Your messages and data remain on the remote instance.
            </div>
          </button>

          {/* Nuke everything */}
          <button
            type="button"
            onClick={() => setMode('nuke')}
            className={`w-full text-left p-3 rounded-lg border transition-colors ${
              mode === 'nuke'
                ? 'bg-accent-rose/[0.04] border-accent-rose/20'
                : 'bg-transparent border-white/[0.04] hover:border-white/[0.06]'
            }`}
          >
            <div className={`text-sm font-medium ${mode === 'nuke' ? 'text-txt-danger' : 'text-txt-primary'}`}>
              Nuke everything
            </div>
            <div className="text-[11px] text-txt-tertiary mt-0.5">
              Delete your account and all associated data on the remote instance.
            </div>
          </button>

          {/* Evaporate (coming soon) */}
          <div
            className="w-full text-left p-3 rounded-lg border border-dashed border-white/[0.04] opacity-40 cursor-not-allowed"
          >
            <div className="text-sm font-medium text-txt-primary">Evaporate</div>
            <div className="text-[11px] text-txt-tertiary mt-0.5">
              Gradually fade your presence — coming soon.
            </div>
          </div>
        </div>

        {/* Scope selector */}
        <div className="mb-4">
          <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Scope</div>
          <div className="flex gap-1.5">
            {([
              { key: 'this' as DeletionScope, label: 'This instance only' },
              { key: 'select' as DeletionScope, label: 'Select instances...' },
              { key: 'all' as DeletionScope, label: 'All remote instances' },
            ]).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setScope(opt.key)}
                className={`flex-1 px-2 py-1.5 text-[11px] font-medium rounded transition-colors ${
                  scope === opt.key
                    ? 'bg-accent-lavender/15 text-accent-lavender'
                    : 'bg-white/[0.04] text-txt-tertiary hover:text-txt-secondary'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 text-sm font-medium text-txt-secondary bg-interactive-hover hover:bg-interactive-selected rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="flex-1 py-2.5 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Delete Identity
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── RegistryRow ────────────────────────────────────────────────────────────

function RegistryRow({
  entry,
  expanded,
  onToggleExpand,
}: {
  entry: FederationRegistryEntry;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const instances = useInstanceStore((s) => s.instances);
  const disconnectInstance = useInstanceStore((s) => s.disconnectInstance);
  const reconnectInstance = useInstanceStore((s) => s.reconnectInstance);
  const forceRemoveEntry = useInstanceStore((s) => s.forceRemoveEntry);
  const reauthenticateInstance = useInstanceStore((s) => s.reauthenticateInstance);

  const [showForceRemoveConfirm, setShowForceRemoveConfirm] = useState(false);
  const [showDeleteIdentity, setShowDeleteIdentity] = useState(false);
  const [showReauth, setShowReauth] = useState(false);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthLoading, setReauthLoading] = useState(false);
  const [reauthError, setReauthError] = useState('');

  const name = entry.label || safeHost(entry.origin);
  const isDisconnected = entry.status === 'disconnected';
  const isConnected = entry.status === 'connected';
  const hasIssue = entry.status === 'unreachable' || entry.status === 'auth_expired';

  // Check if there's a live ConnectedInstance for reconnect actions
  const liveInstance = instances.find((i) => i.origin === entry.origin);

  // Build context-dependent metadata line
  let metadataText = '';
  if (isConnected) {
    metadataText = `Added ${formatAbsoluteDate(entry.addedAt)}`;
    if (entry.lastConnectedAt) {
      metadataText += ` · Connected ${formatRelativeTime(entry.lastConnectedAt)}`;
    }
  } else if (isDisconnected) {
    metadataText = `Added ${formatAbsoluteDate(entry.addedAt)}`;
    if (entry.disconnectedAt) {
      metadataText += ` · Disconnected ${formatRelativeTime(entry.disconnectedAt)}`;
    }
  } else {
    metadataText = `Added ${formatAbsoluteDate(entry.addedAt)}`;
    if (entry.lastConnectedAt) {
      metadataText += ` · Last connected ${formatRelativeTime(entry.lastConnectedAt)}`;
    }
  }

  const handleDisconnect = () => {
    disconnectInstance(entry.origin);
  };

  const handleReconnect = () => {
    if (liveInstance) {
      reconnectInstance(entry.origin);
    }
  };

  const handleForceRemove = () => {
    forceRemoveEntry(entry.origin);
    setShowForceRemoveConfirm(false);
  };

  const handleReauth = async () => {
    if (!reauthPassword) return;
    setReauthError('');
    setReauthLoading(true);
    try {
      await reauthenticateInstance(entry.origin, reauthPassword);
      setShowReauth(false);
      setReauthPassword('');
    } catch (err) {
      setReauthError((err as Error).message);
    } finally {
      setReauthLoading(false);
    }
  };

  return (
    <>
      <div className={`bg-white/[0.02] rounded-md transition-colors ${isDisconnected ? 'opacity-70' : ''} ${expanded ? 'border border-white/[0.06]' : ''}`}>
        {/* Compact row */}
        <div
          className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-white/[0.02] rounded-md"
          onClick={onToggleExpand}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-2 h-2 rounded-full shrink-0 ${registryStatusDotColor(entry.status)}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-txt-primary truncate">{name}</span>
                <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded ${registryStatusColor(entry.status)}`}>
                  {registryStatusLabel(entry.status)}
                </span>
              </div>
              <div className="text-[11px] text-txt-tertiary truncate">
                {safeHost(entry.origin)}
                {entry.username && (
                  <span className="ml-1">as {entry.username}</span>
                )}
              </div>
              <div className="text-[10px] text-txt-tertiary">{metadataText}</div>
            </div>
          </div>
          <span className="text-txt-tertiary text-xs shrink-0 ml-2">{expanded ? '\u25BE' : '\u25B8'}</span>
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className="px-3 pb-3">
            <div className="border-t border-white/[0.05] pt-3">
              {/* Stats grid */}
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div>
                  <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider mb-0.5">Remote User ID</div>
                  <div className="text-xs text-txt-secondary truncate" title={entry.remoteUserId || 'Unknown'}>
                    {entry.remoteUserId ? entry.remoteUserId.slice(0, 12) + '...' : 'Unknown'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider mb-0.5">Added</div>
                  <div className="text-xs text-txt-secondary">{formatAbsoluteDate(entry.addedAt)}</div>
                </div>
                <div>
                  {isDisconnected && entry.disconnectedAt ? (
                    <>
                      <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider mb-0.5">Disconnected</div>
                      <div className="text-xs text-txt-secondary">{formatAbsoluteDate(entry.disconnectedAt)}</div>
                    </>
                  ) : (
                    <>
                      <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider mb-0.5">Last Connected</div>
                      <div className="text-xs text-txt-secondary">
                        {entry.lastConnectedAt ? formatAbsoluteDate(entry.lastConnectedAt) : 'Never'}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Error message */}
              {entry.errorMessage && (
                <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs mb-3">
                  {entry.errorMessage}
                </div>
              )}

              {/* Re-auth inline form */}
              {showReauth && (
                <form onSubmit={(e) => { e.preventDefault(); handleReauth(); }} className="mt-3 space-y-2">
                  <input type="text" autoComplete="username" value={entry.username ?? ''} readOnly tabIndex={-1} className="sr-only" />
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={reauthPassword}
                      onChange={(e) => setReauthPassword(e.target.value)}
                      placeholder="Your account password"
                      className="input-standard flex-1 py-1.5"
                      disabled={reauthLoading}
                      autoFocus
                      autoComplete="current-password"
                    />
                    <button
                      type="submit"
                      disabled={reauthLoading || !reauthPassword}
                      className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
                    >
                      {reauthLoading ? 'Connecting...' : 'Connect'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowReauth(false); setReauthPassword(''); setReauthError(''); }}
                      className="px-2 py-1.5 text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                  {reauthError && (
                    <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">
                      {reauthError}
                    </div>
                  )}
                </form>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 flex-wrap">
                {isConnected && (
                  <>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDisconnect(); }}
                      className="px-3 py-1.5 text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-txt-secondary rounded transition-colors"
                    >
                      Disconnect
                    </button>
                    <button
                      type="button"
                      disabled
                      className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger rounded opacity-50 cursor-not-allowed"
                      title="Disconnect first to delete identity"
                    >
                      Delete Identity
                    </button>
                  </>
                )}

                {isDisconnected && (
                  <>
                    {liveInstance && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleReconnect(); }}
                        className="px-3 py-1.5 text-xs font-medium bg-accent-lavender/15 text-accent-lavender hover:bg-accent-lavender/25 rounded transition-colors"
                      >
                        Reconnect
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowReauth((v) => !v); }}
                      className="px-3 py-1.5 text-xs font-medium bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25 rounded transition-colors"
                    >
                      Re-authenticate
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowDeleteIdentity(true); }}
                      className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger hover:bg-accent-rose/20 rounded transition-colors"
                    >
                      Delete Identity
                    </button>
                  </>
                )}

                {hasIssue && (
                  <>
                    {entry.status === 'unreachable' && liveInstance && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleReconnect(); }}
                        className="px-3 py-1.5 text-xs font-medium bg-accent-lavender/15 text-accent-lavender hover:bg-accent-lavender/25 rounded transition-colors"
                      >
                        Reconnect
                      </button>
                    )}
                    {entry.status === 'auth_expired' && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setShowReauth((v) => !v); }}
                        className="px-3 py-1.5 text-xs font-medium bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25 rounded transition-colors"
                      >
                        Re-authenticate
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowForceRemoveConfirm(true); }}
                      className="px-3 py-1.5 text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-txt-secondary rounded transition-colors"
                    >
                      Force Remove
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowDeleteIdentity(true); }}
                      className="px-3 py-1.5 text-xs font-medium bg-accent-rose/10 text-txt-danger hover:bg-accent-rose/20 rounded transition-colors"
                    >
                      Delete Identity
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Force Remove confirmation dialog */}
      <ConfirmDialog
        isOpen={showForceRemoveConfirm}
        onClose={() => setShowForceRemoveConfirm(false)}
        onConfirm={handleForceRemove}
        title="Force Remove Entry"
        description={`This will remove the registry entry for ${name}. The remote instance will not be notified. Use this only if the instance is permanently unreachable.`}
        confirmLabel="Force Remove"
        variant="warning"
      />

      {/* Delete Identity dialog */}
      {showDeleteIdentity && (
        <DeleteIdentityDialog
          origin={entry.origin}
          label={name}
          onClose={() => setShowDeleteIdentity(false)}
        />
      )}
    </>
  );
}

// ─── Sorting ────────────────────────────────────────────────────────────────

function sortEntries(entries: FederationRegistryEntry[], sortBy: SortBy): FederationRegistryEntry[] {
  return [...entries].sort((a, b) => {
    switch (sortBy) {
      case 'name': {
        const nameA = (a.label || safeHost(a.origin)).toLowerCase();
        const nameB = (b.label || safeHost(b.origin)).toLowerCase();
        return nameA.localeCompare(nameB);
      }
      case 'dateAdded':
        return b.addedAt - a.addedAt;
      case 'lastConnected':
        return (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0);
      default:
        return 0;
    }
  });
}

// ─── Main component ──────────────────────────────────────────────────────────

export function ConnectedInstances() {
  const instances = useInstanceStore((s) => s.instances);
  const registry = useInstanceStore((s) => s.registry);
  const user = useAuthStore((s) => s.user);

  const [showAddForm, setShowAddForm] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('dateAdded');
  const [expandedOrigins, setExpandedOrigins] = useState<Set<string>>(new Set());

  const toggleExpand = (origin: string) => {
    setExpandedOrigins((prev) => {
      const next = new Set(prev);
      if (next.has(origin)) {
        next.delete(origin);
      } else {
        next.add(origin);
      }
      return next;
    });
  };

  // Convert registry Map to array
  const registryEntries = Array.from(registry.values());

  // Compute filter counts
  const counts = {
    all: registryEntries.length,
    connected: registryEntries.filter((e) => e.status === 'connected').length,
    disconnected: registryEntries.filter((e) => e.status === 'disconnected').length,
    issues: registryEntries.filter((e) => e.status === 'unreachable' || e.status === 'auth_expired').length,
  };

  // Filter entries
  const filteredEntries = registryEntries.filter((entry) => {
    switch (filter) {
      case 'all': return true;
      case 'connected': return entry.status === 'connected';
      case 'disconnected': return entry.status === 'disconnected';
      case 'issues': return entry.status === 'unreachable' || entry.status === 'auth_expired';
      default: return true;
    }
  });

  // Sort entries
  const sortedEntries = sortEntries(filteredEntries, sortBy);

  // Empty state message
  const emptyMessage = registryEntries.length === 0
    ? null
    : filteredEntries.length === 0
      ? 'No instances match the current filter.'
      : null;

  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
        Connected Instances
      </div>
      <p className="text-xs text-txt-tertiary mb-2">Link accounts across federated Backspace instances.</p>

      <div className="rounded-lg bg-white/[0.02] p-3 space-y-2">
        {/* Home instance (always pinned, non-filterable) */}
        <div className="flex items-center justify-between p-3 bg-surface-channel rounded-lg">
          <div className="flex items-center gap-2 min-w-0">
            <StatusDot status="connected" />
            <div className="min-w-0">
              <div className="text-sm text-txt-primary font-medium truncate">
                Home Instance
              </div>
              <div className="text-xs text-txt-tertiary truncate">
                {window.location.host}
                {user?.username && (
                  <span className="ml-1">as {user.username}</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
            <span className="text-xs text-txt-tertiary">Local</span>
            {isElectron() && (
              <button
                onClick={() => window.backspace?.clearInstanceUrl()}
                className="px-2 py-1 text-xs text-txt-secondary hover:text-txt-primary hover:bg-white/[0.04] rounded transition-colors"
              >
                Change
              </button>
            )}
          </div>
        </div>

        {/* Filter bar (only if registry has entries) */}
        {registryEntries.length > 0 && (
          <RegistryFilterBar
            filter={filter}
            setFilter={setFilter}
            sortBy={sortBy}
            setSortBy={setSortBy}
            counts={counts}
          />
        )}

        {/* Registry rows */}
        {sortedEntries.length > 0 && (
          <div className="space-y-2">
            {sortedEntries.map((entry) => (
              <RegistryRow
                key={entry.origin}
                entry={entry}
                expanded={expandedOrigins.has(entry.origin)}
                onToggleExpand={() => toggleExpand(entry.origin)}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {emptyMessage && (
          <div className="text-xs text-txt-tertiary py-2">{emptyMessage}</div>
        )}

        {registryEntries.length === 0 && !showAddForm && (
          <div className="text-xs text-txt-tertiary py-2">
            No remote instances connected. Add one to start federating.
          </div>
        )}

        {/* Add instance button / flow */}
        {showAddForm ? (
          <AddInstanceFlow onDone={() => setShowAddForm(false)} />
        ) : (
          <button
            onClick={() => setShowAddForm(true)}
            className="w-full p-2 text-sm text-txt-secondary hover:text-txt-primary hover:bg-surface-channel/50 rounded-lg border border-dashed border-white/[0.06] hover:border-white/[0.12] transition-colors"
          >
            + Add Instance
          </button>
        )}
      </div>
    </div>
  );
}
