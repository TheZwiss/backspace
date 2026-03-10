import { useState, useEffect } from 'react';
import { useAuthStore } from '../../../stores/authStore';
import { Avatar } from '../../ui/Avatar';
import type { UserStatus } from '@backspace/shared';

export function AccountPanel() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [customStatus, setCustomStatus] = useState(user?.customStatus ?? '');
  const [status, setStatus] = useState<UserStatus>(user?.status ?? 'online');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Reset form when user data changes (e.g. after external update)
  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName ?? '');
      setCustomStatus(user.customStatus ?? '');
      setStatus(user.status ?? 'online');
    }
  }, [user]);

  if (!user) return null;

  const hasChanges =
    displayName !== (user.displayName ?? '') ||
    customStatus !== (user.customStatus ?? '') ||
    status !== (user.status ?? 'online');

  const handleSave = async () => {
    setError('');
    setSuccess('');
    setIsLoading(true);
    try {
      await updateProfile({
        displayName: displayName.trim(),
        customStatus: customStatus.trim(),
        status,
      });
      setSuccess('Profile updated!');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setDisplayName(user.displayName ?? '');
    setCustomStatus(user.customStatus ?? '');
    setStatus(user.status ?? 'online');
    setError('');
  };

  return (
    <div className="space-y-5">
      {/* Profile preview */}
      <div className="flex items-center gap-4 p-4 bg-surface-channel rounded-lg">
        <Avatar
          src={user.avatar}
          name={user.displayName ?? user.username}
          size={64}
          status={user.status}
          userId={user.homeUserId ?? user.id}
        />
        <div>
          <div className="font-bold text-lg">{user.displayName ?? user.username}</div>
          <div className="text-txt-tertiary text-sm">@{user.username}</div>
          {user.customStatus && (
            <div className="text-txt-secondary text-sm mt-1">{user.customStatus}</div>
          )}
        </div>
      </div>

      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
      )}
      {success && (
        <div className="p-2 bg-status-online/10 border border-status-online/30 rounded text-status-online text-sm">{success}</div>
      )}

      {/* Profile section card */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Profile</div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-4">
          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">
              Status
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as UserStatus)}
              className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary appearance-none"
            >
              <option value="online">Online</option>
              <option value="idle">Idle</option>
              <option value="dnd">Do Not Disturb</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary"
            />
          </div>

          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">
              Custom Status
            </label>
            <input
              type="text"
              value={customStatus}
              onChange={(e) => setCustomStatus(e.target.value)}
              className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary"
              placeholder="What are you up to?"
            />
          </div>
        </div>
      </div>

      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
              <button
                onClick={handleReset}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={isLoading}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {isLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
