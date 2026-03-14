import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';

export function CreateChannelModal() {
  const [name, setName] = useState('');
  const [type, setType] = useState<'text' | 'voice'>('text');
  const [topic, setTopic] = useState('');
  const [categoryId, setCategoryId] = useState<string | ''>('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const createChannel = useSpaceStore((s) => s.createChannel);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const categories = useSpaceStore((s) => s.categories);

  const isOpen = activeModal === 'createChannel';

  // Pre-select category when opened from a category's + button
  useEffect(() => {
    if (isOpen && modalData.categoryId) {
      setCategoryId(modalData.categoryId as string);
    }
  }, [isOpen, modalData.categoryId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Channel name is required');
      return;
    }

    if (!currentSpaceId) {
      setError('No space selected');
      return;
    }

    setIsLoading(true);
    try {
      await createChannel(currentSpaceId, name.trim(), type, topic.trim() || undefined, categoryId || undefined);
      closeModal();
      setName('');
      setTopic('');
      setType('text');
      setCategoryId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create channel');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Create Channel">
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-3 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
            {error}
          </div>
        )}

        <div className="mb-4">
          <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
            Channel Type
          </label>
          <div className="space-y-2">
            {(['text', 'voice'] as const).map((t) => (
              <label
                key={t}
                className={`flex items-center gap-3 p-3 rounded cursor-pointer border ${
                  type === t
                    ? 'border-accent-primary bg-interactive-hover'
                    : 'border-border-soft bg-surface-channel hover:bg-interactive-hover'
                }`}
              >
                <input
                  type="radio"
                  name="channelType"
                  value={t}
                  checked={type === t}
                  onChange={() => setType(t)}
                  className="hidden"
                />
                <div className="w-5 h-5 text-txt-tertiary">
                  {t === 'text' && (
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z" /></svg>
                  )}
                  {t === 'voice' && (
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" /></svg>
                  )}
                </div>
                <div>
                  <div className="text-sm font-medium text-txt-primary capitalize">{t}</div>
                  <div className="text-xs text-txt-tertiary">
                    {t === 'text' && 'Send messages, images, and files'}
                    {t === 'voice' && 'Hang out with voice and video'}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
            Channel Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-standard w-full"
            placeholder="new-channel"
            autoFocus
          />
        </div>

        {type === 'text' && (
          <div className="mb-4">
            <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
              Topic (optional)
            </label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="input-standard w-full"
              placeholder="What's this channel about?"
            />
          </div>
        )}

        {categories.length > 0 && (
          <div className="mb-4">
            <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
              Category
            </label>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="input-standard w-full"
            >
              <option value="">No Category</option>
              {[...categories].sort((a, b) => a.position - b.position).map((cat) => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
          </div>
        )}

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
                {isLoading ? 'Creating...' : 'Create Channel'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}
