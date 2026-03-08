import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { api } from '../../api/client';
import { PermissionBits, permissionsToString, stringToPermissions } from '../../utils/permissions';

interface ChannelOverride {
  channelId: string;
  targetType: string;
  targetId: string;
  allow: string;
  deny: string;
}

export function ChannelSettingsModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const channels = useSpaceStore((s) => s.channels);

  const [isPrivate, setIsPrivate] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState('');

  const isOpen = activeModal === 'channelSettings';
  const channelId = modalData?.channelId as string | undefined;
  const channel = channels.find(c => c.id === channelId);

  // Fetch overrides when modal opens
  useEffect(() => {
    if (!isOpen || !channelId || !currentSpaceId) {
      setIsFetching(false);
      return;
    }

    setIsFetching(true);
    setError('');

    api.channels.getOverrides(channelId)
      .then((overrides: ChannelOverride[]) => {
        // Check if @everyone role (id === spaceId) has VIEW_CHANNEL denied
        const everyoneOverride = overrides.find(
          o => o.targetType === 'role' && o.targetId === currentSpaceId
        );
        if (everyoneOverride) {
          const denyBits = stringToPermissions(everyoneOverride.deny);
          setIsPrivate((denyBits & PermissionBits.VIEW_CHANNEL) !== 0n);
        } else {
          setIsPrivate(false);
        }
      })
      .catch((err: Error) => {
        setError(err.message || 'Failed to load channel overrides');
      })
      .finally(() => {
        setIsFetching(false);
      });
  }, [isOpen, channelId, currentSpaceId]);

  if (!isOpen || !channel || !channelId || !currentSpaceId) return null;

  const handleToggle = async () => {
    setError('');
    setIsLoading(true);

    try {
      if (!isPrivate) {
        // Make private: deny VIEW_CHANNEL for @everyone role
        await api.channels.putOverride(channelId, {
          targetType: 'role',
          targetId: currentSpaceId,
          allow: '0',
          deny: permissionsToString(PermissionBits.VIEW_CHANNEL),
        });
        setIsPrivate(true);
      } else {
        // Make public: remove the @everyone VIEW_CHANNEL deny override
        await api.channels.deleteOverride(channelId, 'role', currentSpaceId);
        setIsPrivate(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update channel privacy');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Channel Settings" maxWidth="max-w-md">
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
            Channel
          </label>
          <div className="flex items-center gap-2 text-txt-primary">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="opacity-60 flex-shrink-0">
              <path d="M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z" />
            </svg>
            <span className="text-sm font-medium">{channel.name}</span>
          </div>
        </div>

        {error && (
          <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
            {error}
          </div>
        )}

        <div className="pt-2 border-t border-border-soft">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-txt-primary">Private Channel</div>
              <div className="text-xs text-txt-tertiary mt-0.5">
                Only selected members and roles will be able to view this channel.
              </div>
            </div>
            <button
              onClick={handleToggle}
              disabled={isLoading || isFetching}
              className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ml-4 ${
                isFetching
                  ? 'bg-surface-input opacity-50 cursor-wait'
                  : isPrivate
                    ? 'bg-status-online'
                    : 'bg-surface-input'
              } ${isLoading ? 'opacity-70 cursor-wait' : 'cursor-pointer'}`}
              aria-label={isPrivate ? 'Make channel public' : 'Make channel private'}
            >
              <div
                className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  isPrivate ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>

        {isPrivate && !isFetching && (
          <div className="flex items-start gap-2 p-2 bg-surface-input/50 rounded text-xs text-txt-tertiary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0 mt-0.5 text-txt-secondary">
              <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
            </svg>
            <span>
              This channel is hidden from members without explicit access. Users with the Administrator permission or space owners can always see all channels.
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}
