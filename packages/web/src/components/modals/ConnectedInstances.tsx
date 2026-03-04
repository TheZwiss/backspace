import React, { useState } from 'react';
import type { InstanceInfoResponse } from '@backspace/shared';
import { useInstanceStore, DifferentPasswordError } from '../../stores/instanceStore';
import { useAuthStore } from '../../stores/authStore';

// ─── Status indicator ────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const colorClass =
    status === 'connected' ? 'bg-status-online' :
    status === 'connecting' ? 'bg-accent-amber' :
    'bg-txt-tertiary';

  return <div className={`w-2 h-2 rounded-full shrink-0 ${colorClass}`} />;
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
              className="flex-1 px-3 py-2 bg-surface-input rounded text-txt-primary text-sm outline-none focus:ring-2 focus:ring-accent-primary"
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

          <div className="space-y-2">
            <div>
              <label className="block text-xs text-txt-tertiary mb-1">
                Enter your password to connect to {new URL(probeResult.origin).host}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !isLoading && password && handleConnect()}
                placeholder="Your account password"
                className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary text-sm outline-none focus:ring-2 focus:ring-accent-primary"
                disabled={isLoading}
                autoFocus
              />
              <div className="text-xs text-txt-tertiary mt-1">
                Your password is verified locally, then used to create or access your account on the remote instance.
              </div>
            </div>
            <button
              onClick={handleConnect}
              disabled={isLoading || !password}
              className="w-full px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Connecting...' : 'Connect'}
            </button>
          </div>

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

          <div className="space-y-2">
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
                onKeyDown={(e) => e.key === 'Enter' && !isLoading && fallbackUsername && fallbackPassword && handleFallbackLogin()}
                placeholder="Password on the remote instance"
                className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary text-sm outline-none focus:ring-2 focus:ring-accent-primary"
                disabled={isLoading}
                autoFocus
              />
            </div>
            <button
              onClick={handleFallbackLogin}
              disabled={isLoading || !fallbackUsername || !fallbackPassword}
              className="w-full px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Logging in...' : 'Login & Connect'}
            </button>
          </div>

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

// ─── Main component ──────────────────────────────────────────────────────────

export function ConnectedInstances() {
  const instances = useInstanceStore((s) => s.instances);
  const removeInstance = useInstanceStore((s) => s.removeInstance);
  const [showAddForm, setShowAddForm] = useState(false);

  return (
    <div className="border-t border-white/[0.06] pt-4">
      <h3 className="text-xs font-bold text-txt-secondary uppercase mb-3">
        Connected Instances
      </h3>

      <div className="space-y-2">
        {/* Home instance (always shown, non-removable) */}
        <div className="flex items-center justify-between p-3 bg-surface-channel rounded-lg">
          <div className="flex items-center gap-2 min-w-0">
            <StatusDot status="connected" />
            <div className="min-w-0">
              <div className="text-sm text-txt-primary font-medium truncate">
                Home Instance
              </div>
              <div className="text-xs text-txt-tertiary truncate">
                {window.location.host}
              </div>
            </div>
          </div>
          <div className="text-xs text-txt-tertiary shrink-0 ml-2">
            Local
          </div>
        </div>

        {/* Remote instances */}
        {instances.map((inst) => (
          <div key={inst.origin} className="flex items-center justify-between p-3 bg-surface-channel rounded-lg">
            <div className="flex items-center gap-2 min-w-0">
              <StatusDot status={inst.status} />
              <div className="min-w-0">
                <div className="text-sm text-txt-primary font-medium truncate">
                  {inst.label}
                </div>
                <div className="text-xs text-txt-tertiary truncate">
                  {new URL(inst.origin).host}
                  {inst.username && (
                    <span className="ml-1 text-txt-quaternary">as {inst.username}</span>
                  )}
                </div>
                {inst.status === 'disconnected' && inst.error && (
                  <div className="text-xs text-accent-amber mt-0.5">{inst.error}</div>
                )}
              </div>
            </div>
            <button
              onClick={() => removeInstance(inst.origin)}
              className="px-2 py-1 text-xs text-txt-danger hover:bg-accent-rose/10 rounded transition-colors shrink-0 ml-2"
              title="Disconnect"
            >
              Disconnect
            </button>
          </div>
        ))}

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
