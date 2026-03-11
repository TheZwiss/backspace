import { useState, useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { api } from '../../api/client';
import { deleteAccountOnRemotes, type FederationOpResult } from '../../utils/federationOps';

interface DeleteAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Step = 'warning' | 'confirm' | 'federation' | 'complete';

interface OwnedSpaceInfo {
  id: string;
  name: string;
  members: { userId: string; username: string; displayName: string | null }[];
  action: 'none' | 'transfer' | 'delete';
  transferTo: string;
}

export function DeleteAccountModal({ isOpen, onClose }: DeleteAccountModalProps) {
  const user = useAuthStore((s) => s.user);
  const instances = useInstanceStore((s) => s.instances);
  const spaces = useSpaceStore((s) => s.spaces);

  const [step, setStep] = useState<Step>('warning');
  const [ownedSpaces, setOwnedSpaces] = useState<OwnedSpaceInfo[]>([]);
  const [confirmUsername, setConfirmUsername] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [federationResults, setFederationResults] = useState<FederationOpResult[]>([]);
  const [deletionComplete, setDeletionComplete] = useState(false);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setStep('warning');
      setConfirmUsername('');
      setConfirmPassword('');
      setError('');
      setIsLoading(false);
      setFederationResults([]);
      setDeletionComplete(false);

      // Build owned spaces list and fetch members for each
      if (user) {
        const owned = spaces.filter(s => s.ownerId === user.id);
        if (owned.length > 0) {
          Promise.all(
            owned.map(async (s) => {
              try {
                const members = await api.spaces.members(s.id);
                return {
                  id: s.id,
                  name: s.name,
                  members: members
                    .filter(m => m.userId !== user.id)
                    .map(m => ({
                      userId: m.userId,
                      username: m.user.username,
                      displayName: m.user.displayName,
                    })),
                  action: 'none' as const,
                  transferTo: '',
                };
              } catch {
                return {
                  id: s.id,
                  name: s.name,
                  members: [] as OwnedSpaceInfo['members'],
                  action: 'none' as const,
                  transferTo: '',
                };
              }
            })
          ).then(setOwnedSpaces);
        }
      }
    }
  }, [isOpen, user]);

  // Auto-redirect after deletion — must be before early return to maintain hooks order
  useEffect(() => {
    if (deletionComplete && step === 'complete') {
      const timer = setTimeout(() => {
        localStorage.removeItem('backspace_token');
        window.location.href = '/login';
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [deletionComplete, step]);

  if (!isOpen || !user) return null;

  const hasRemotes = instances.filter(i => i.status === 'connected').length > 0;
  const allOwnedHandled = ownedSpaces.every(s => s.action !== 'none');

  const handleSpaceAction = (spaceId: string, action: 'transfer' | 'delete') => {
    setOwnedSpaces(prev => prev.map(s =>
      s.id === spaceId ? { ...s, action, transferTo: action === 'transfer' ? s.transferTo : '' } : s
    ));
  };

  const handleTransferTo = (spaceId: string, userId: string) => {
    setOwnedSpaces(prev => prev.map(s =>
      s.id === spaceId ? { ...s, transferTo: userId } : s
    ));
  };

  const handleContinueFromWarning = async () => {
    setError('');
    setIsLoading(true);

    try {
      // Process owned spaces
      for (const space of ownedSpaces) {
        if (space.action === 'transfer' && space.transferTo) {
          await api.spaces.transferOwnership(space.id, space.transferTo);
        } else if (space.action === 'delete') {
          await api.spaces.delete(space.id);
        }
      }
      setStep('confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process spaces');
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (confirmUsername !== user.username) {
      setError('Username does not match');
      return;
    }

    setError('');
    setIsLoading(true);

    try {
      if (hasRemotes) {
        setStep('federation');
        // Delete on remotes first
        const results = await deleteAccountOnRemotes();
        setFederationResults(results);
        // Then delete home account
        await api.users.deleteAccount({ password: confirmPassword, username: confirmUsername });
        setDeletionComplete(true);
        setStep('complete');
      } else {
        // No remotes — direct delete via API (don't clear auth state yet — let the modal show "complete")
        await api.users.deleteAccount({ password: confirmPassword, username: confirmUsername });
        setDeletionComplete(true);
        setStep('complete');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete account');
      if (step === 'federation') {
        // Stay on federation step so user can see results
      } else {
        setStep('confirm');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteAnyway = async () => {
    setError('');
    setIsLoading(true);
    try {
      await api.users.deleteAccount({ password: confirmPassword, username: confirmUsername });
      setDeletionComplete(true);
      setStep('complete');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete account');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-surface-overlay" onClick={step !== 'complete' ? onClose : undefined} />
      <div className="relative max-w-lg w-full mx-4 max-h-[calc(100vh-2rem)] flex flex-col bg-surface-elevated rounded-lg shadow-xl animate-slide-up overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 flex-shrink-0">
          <h2 className="text-lg font-bold text-txt-primary">Delete Account</h2>
          {step !== 'complete' && (
            <button onClick={onClose} className="text-txt-tertiary hover:text-txt-primary transition-colors p-1">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          {/* Step 1: Warning & Space Handling */}
          {step === 'warning' && (
            <>
              <div className="bg-accent-rose/10 border border-accent-rose/20 rounded-lg p-3.5">
                <p className="text-sm text-txt-primary font-medium mb-2">This will permanently delete your account.</p>
                <ul className="text-xs text-txt-secondary space-y-1">
                  <li>- All space memberships will be removed</li>
                  <li>- All friend connections will be removed</li>
                  <li>- All DM memberships will be removed</li>
                  <li>- Your messages will remain but be attributed to "Deleted User"</li>
                </ul>
              </div>

              {ownedSpaces.length > 0 && (
                <div>
                  <p className="text-sm text-txt-primary font-medium mb-2">
                    You own {ownedSpaces.length} space{ownedSpaces.length > 1 ? 's' : ''}. Handle each before continuing:
                  </p>
                  <div className="space-y-3">
                    {ownedSpaces.map(space => (
                      <div key={space.id} className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3">
                        <div className="text-sm font-medium text-txt-primary mb-2">{space.name}</div>
                        <div className="flex gap-2 mb-2">
                          <button
                            onClick={() => handleSpaceAction(space.id, 'transfer')}
                            className={`px-2.5 py-1 text-xs rounded transition-colors ${
                              space.action === 'transfer'
                                ? 'bg-accent-primary text-white'
                                : 'bg-white/[0.06] text-txt-secondary hover:text-txt-primary'
                            }`}
                          >
                            Transfer
                          </button>
                          <button
                            onClick={() => handleSpaceAction(space.id, 'delete')}
                            className={`px-2.5 py-1 text-xs rounded transition-colors ${
                              space.action === 'delete'
                                ? 'bg-accent-rose text-white'
                                : 'bg-white/[0.06] text-txt-secondary hover:text-txt-primary'
                            }`}
                          >
                            Delete Space
                          </button>
                        </div>
                        {space.action === 'transfer' && (
                          <select
                            value={space.transferTo}
                            onChange={(e) => handleTransferTo(space.id, e.target.value)}
                            className="w-full px-2.5 py-1.5 bg-surface-input rounded text-xs text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary"
                          >
                            <option value="">Select new owner...</option>
                            {space.members.map(m => (
                              <option key={m.userId} value={m.userId}>
                                {m.displayName || m.username}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {error && (
                <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">{error}</div>
              )}

              <button
                onClick={ownedSpaces.length > 0 ? handleContinueFromWarning : () => setStep('confirm')}
                disabled={
                  isLoading ||
                  (ownedSpaces.length > 0 && (!allOwnedHandled || ownedSpaces.some(s => s.action === 'transfer' && !s.transferTo)))
                }
                className="w-full py-2 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Processing...' : 'Continue'}
              </button>
            </>
          )}

          {/* Step 2: Confirmation */}
          {step === 'confirm' && (
            <>
              <div className="bg-accent-rose/10 border border-accent-rose/20 rounded-lg p-3.5">
                <p className="text-sm text-txt-danger font-medium">This action is permanent and cannot be undone.</p>
              </div>

              <div>
                <label className="block text-xs text-txt-secondary mb-1.5">
                  Type your username <span className="font-mono text-txt-primary">{user.username}</span> to confirm
                </label>
                <input
                  type="text"
                  value={confirmUsername}
                  onChange={(e) => setConfirmUsername(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-input rounded text-sm text-txt-primary outline-none focus:ring-2 focus:ring-accent-rose"
                  placeholder={user.username}
                />
              </div>

              <div>
                <label className="block text-xs text-txt-secondary mb-1.5">Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-input rounded text-sm text-txt-primary outline-none focus:ring-2 focus:ring-accent-rose"
                  placeholder="Enter your password"
                />
              </div>

              {error && (
                <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">{error}</div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => { setStep('warning'); setError(''); }}
                  className="flex-1 py-2 bg-white/[0.06] hover:bg-white/[0.1] text-txt-secondary text-sm font-medium rounded-lg transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleConfirmDelete}
                  disabled={isLoading || confirmUsername !== user.username || !confirmPassword}
                  className="flex-1 py-2 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isLoading ? 'Deleting...' : 'Delete My Account'}
                </button>
              </div>
            </>
          )}

          {/* Step 3: Federation Progress */}
          {step === 'federation' && (
            <>
              <p className="text-sm text-txt-secondary">Removing your account from connected instances...</p>
              <div className="space-y-2">
                {instances.filter(i => i.status === 'connected').map(inst => {
                  const result = federationResults.find(r => r.origin === inst.origin);
                  return (
                    <div key={inst.origin} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.04]">
                      <span className="text-sm text-txt-primary">{inst.label || new URL(inst.origin).host}</span>
                      {!result ? (
                        <svg className="animate-spin w-4 h-4 text-txt-tertiary" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      ) : result.success ? (
                        <svg className="w-4 h-4 text-status-online" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <svg className="w-4 h-4 text-txt-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          <span className="text-xs text-txt-danger">{result.error}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {error && (
                <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">{error}</div>
              )}

              {federationResults.length > 0 && !deletionComplete && (
                <button
                  onClick={handleDeleteAnyway}
                  disabled={isLoading}
                  className="w-full py-2 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {isLoading ? 'Deleting...' : 'Delete Account Now'}
                </button>
              )}
            </>
          )}

          {/* Step 4: Complete */}
          {step === 'complete' && (
            <div className="text-center py-6">
              <svg className="w-12 h-12 text-txt-tertiary mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <p className="text-lg font-medium text-txt-primary mb-1">Account deleted</p>
              <p className="text-sm text-txt-tertiary">Redirecting to login...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
