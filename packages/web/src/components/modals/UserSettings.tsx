import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { Avatar } from '../ui/Avatar';
import { ConnectedInstances } from './ConnectedInstances';

export function UserSettingsModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const logout = useAuthStore((s) => s.logout);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [customStatus, setCustomStatus] = useState(user?.customStatus ?? '');
  const [status, setStatus] = useState(user?.status ?? 'online');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);
  const setEchoCancellation = useVoiceStore((s) => s.setEchoCancellation);
  const setAutoGainControl = useVoiceStore((s) => s.setAutoGainControl);
  const setRnnoiseEnabled = useVoiceStore((s) => s.setRnnoiseEnabled);

  const isOpen = activeModal === 'userSettings';

  const handleSave = async () => {
    setError('');
    setSuccess('');
    setIsLoading(true);
    try {
      await updateProfile({
        displayName: displayName.trim() || undefined,
        customStatus: customStatus.trim() || undefined,
        status: status as any,
      } as any);
      setSuccess('Profile updated!');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    closeModal();
  };

  if (!user) return null;

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="User Settings" maxWidth="max-w-lg">
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
          <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
            <div>
              <label className="block text-xs text-txt-secondary mb-1.5">
                Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as any)}
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

        {/* Voice Processing section card */}
        <div>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            Voice Processing
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm text-txt-primary">AI Noise Suppression</div>
                <div className="text-xs text-txt-tertiary">ML-based noise removal (RNNoise) — filters keyboard, fans, and background noise</div>
              </div>
              <button
                onClick={() => setRnnoiseEnabled(!rnnoiseEnabled)}
                className={`relative w-10 h-5 rounded-full transition-colors ${rnnoiseEnabled ? 'bg-status-online' : 'bg-surface-input'}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${rnnoiseEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>

            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm text-txt-primary">Echo Cancellation</div>
                <div className="text-xs text-txt-tertiary">Removes echo when using speakers</div>
              </div>
              <button
                onClick={() => setEchoCancellation(!echoCancellation)}
                className={`relative w-10 h-5 rounded-full transition-colors ${echoCancellation ? 'bg-status-online' : 'bg-surface-input'}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${echoCancellation ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>

            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm text-txt-primary">Auto Gain Control</div>
                <div className="text-xs text-txt-tertiary">Auto-adjusts mic volume — can cause voice ducking during streams</div>
              </div>
              <button
                onClick={() => setAutoGainControl(!autoGainControl)}
                className={`relative w-10 h-5 rounded-full transition-colors ${autoGainControl ? 'bg-status-online' : 'bg-surface-input'}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${autoGainControl ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Connected Instances */}
        <ConnectedInstances />

        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-3 py-2 flex items-center gap-3 pointer-events-auto">
              <button
                onClick={handleLogout}
                className="px-3 py-1 text-sm text-txt-danger hover:bg-accent-rose/10 rounded-full transition-colors"
              >
                Log Out
              </button>
              <div className="w-px h-5 bg-white/10" />
              <button
                onClick={handleSave}
                disabled={isLoading}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {isLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
