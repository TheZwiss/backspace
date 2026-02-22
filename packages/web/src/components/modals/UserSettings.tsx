import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { Avatar } from '../ui/Avatar';

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
      <div className="space-y-6">
        {/* Profile preview */}
        <div className="flex items-center gap-4 p-4 bg-discord-bg-secondary rounded-lg">
          <Avatar
            src={user.avatar}
            name={user.displayName ?? user.username}
            size={64}
            status={user.status}
          />
          <div>
            <div className="font-bold text-lg">{user.displayName ?? user.username}</div>
            <div className="text-discord-text-muted text-sm">@{user.username}</div>
            {user.customStatus && (
              <div className="text-discord-text-secondary text-sm mt-1">{user.customStatus}</div>
            )}
          </div>
        </div>

        {error && (
          <div className="p-2 bg-discord-red/10 border border-discord-red/30 rounded text-discord-text-danger text-sm">{error}</div>
        )}
        {success && (
          <div className="p-2 bg-discord-green/10 border border-discord-green/30 rounded text-discord-text-positive text-sm">{success}</div>
        )}

        <div>
          <label className="block text-xs font-bold text-discord-text-secondary uppercase mb-2">
            Status
          </label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
            className="w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple appearance-none"
          >
            <option value="online">Online</option>
            <option value="idle">Idle</option>
            <option value="dnd">Do Not Disturb</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-bold text-discord-text-secondary uppercase mb-2">
            Display Name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple"
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-discord-text-secondary uppercase mb-2">
            Custom Status
          </label>
          <input
            type="text"
            value={customStatus}
            onChange={(e) => setCustomStatus(e.target.value)}
            className="w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple"
            placeholder="What are you up to?"
          />
        </div>

        {/* Voice Processing */}
        <div className="border-t border-white/[0.06] pt-4">
          <h3 className="text-xs font-bold text-discord-text-secondary uppercase mb-3">
            Voice Processing
          </h3>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-discord-text-primary">AI Noise Suppression</div>
              <div className="text-xs text-discord-text-muted">ML-based noise removal (RNNoise) — filters keyboard, fans, and background noise</div>
            </div>
            <button
              onClick={() => setRnnoiseEnabled(!rnnoiseEnabled)}
              className={`relative w-10 h-5 rounded-full transition-colors ${rnnoiseEnabled ? 'bg-discord-green' : 'bg-discord-bg-tertiary'}`}
            >
              <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${rnnoiseEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-discord-text-primary">Echo Cancellation</div>
              <div className="text-xs text-discord-text-muted">Removes echo when using speakers (auto-disabled during screen share)</div>
            </div>
            <button
              onClick={() => setEchoCancellation(!echoCancellation)}
              className={`relative w-10 h-5 rounded-full transition-colors ${echoCancellation ? 'bg-discord-green' : 'bg-discord-bg-tertiary'}`}
            >
              <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${echoCancellation ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-discord-text-primary">Auto Gain Control</div>
              <div className="text-xs text-discord-text-muted">Auto-adjusts mic volume — can cause voice ducking during streams</div>
            </div>
            <button
              onClick={() => setAutoGainControl(!autoGainControl)}
              className={`relative w-10 h-5 rounded-full transition-colors ${autoGainControl ? 'bg-discord-green' : 'bg-discord-bg-tertiary'}`}
            >
              <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${autoGainControl ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <button
            onClick={handleLogout}
            className="px-4 py-2 text-sm text-discord-red hover:bg-discord-red/10 rounded transition-colors"
          >
            Log Out
          </button>
          <button
            onClick={handleSave}
            disabled={isLoading}
            className="px-4 py-2 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
