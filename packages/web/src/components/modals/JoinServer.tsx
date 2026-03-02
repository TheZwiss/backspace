import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { useNavigate, useParams } from 'react-router-dom';

export function JoinServerModal() {
  const { inviteCode: urlInviteCode } = useParams<{ inviteCode?: string }>();
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const joinByCode = useServerStore((s) => s.joinByCode);
  const navigate = useNavigate();

  const isOpen = activeModal === 'joinServer';

  useEffect(() => {
    if (isOpen && urlInviteCode) {
      setInviteCode(urlInviteCode);
    }
  }, [isOpen, urlInviteCode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const code = inviteCode.trim();
    if (!code) {
      setError('Invite code is required');
      return;
    }

    setIsLoading(true);
    try {
      const server = await joinByCode(code);
      closeModal();
      setInviteCode('');
      navigate(`/channels/${server.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join server');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Join a Server">
      <form onSubmit={handleSubmit}>
        <p className="text-txt-secondary text-sm mb-4">
          Enter an invite code to join an existing server.
        </p>
        {error && (
          <div className="mb-3 p-2 bg-[rgba(253,164,175,0.10)] border border-[rgba(253,164,175,0.30)] rounded text-txt-danger text-sm">
            {error}
          </div>
        )}
        <div className="mb-4">
          <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
            Invite Code
          </label>
          <input
            type="text"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary"
            placeholder="e.g. abc123"
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
            disabled={isLoading}
            className="px-4 py-2 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Joining...' : 'Join Server'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
