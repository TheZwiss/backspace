import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';

export function CreateCategoryModal() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const createCategory = useSpaceStore((s) => s.createCategory);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);

  const isOpen = activeModal === 'createCategory';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Category name is required');
      return;
    }

    if (!currentSpaceId) {
      setError('No space selected');
      return;
    }

    setIsLoading(true);
    try {
      await createCategory(currentSpaceId, name.trim());
      closeModal();
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create category');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Create Category">
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-3 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
            {error}
          </div>
        )}

        <div className="mb-4">
          <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
            Category Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-surface-input border border-border-soft rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary transition-colors"
            placeholder="new-category"
            autoFocus
          />
        </div>

        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-3 py-2 flex items-center gap-3 pointer-events-auto">
              <button
                type="button"
                onClick={closeModal}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {isLoading ? 'Creating...' : 'Create Category'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}
