import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { useNavigate } from 'react-router-dom';

export function CreateServerModal() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const createServer = useServerStore((s) => s.createServer);
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const navigate = useNavigate();

  const isOpen = activeModal === 'createServer';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Server name is required');
      return;
    }

    setIsLoading(true);
    try {
      const server = await createServer(name.trim());
      closeModal();
      setName('');
      navigate(`/channels/${server.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create server');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Create a Server">
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-3 p-2 bg-discord-red/10 border border-discord-red/30 rounded text-discord-red text-sm">
            {error}
          </div>
        )}
        <div className="mb-4">
          <label className="block text-xs font-bold text-discord-text-secondary uppercase mb-2">
            Server Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple"
            placeholder="My Awesome Server"
            autoFocus
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-2 text-sm text-discord-text-secondary hover:text-discord-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="px-4 py-2 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
