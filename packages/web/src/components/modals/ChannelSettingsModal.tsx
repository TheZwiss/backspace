import React, { useState, useEffect, useCallback } from 'react';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, getApiForOrigin } from '../../stores/spaceStore';
import { PermissionBits, permissionsToString, stringToPermissions, hasPermissionBit } from '../../utils/permissions';
import { Toggle } from '../ui/Toggle';
import { PermissionsEditor } from '../ui/PermissionsEditor';
import type { PermissionDef } from '../ui/OverrideEntry';

// ─── Permission Definitions for Channel Overrides ──────────────────────────────

const TEXT_CHANNEL_PERMISSIONS: PermissionDef[] = [
  { key: 'VIEW_CHANNEL', label: 'View Channel', bit: PermissionBits.VIEW_CHANNEL },
  { key: 'SEND_MESSAGES', label: 'Send Messages', bit: PermissionBits.SEND_MESSAGES },
  { key: 'MANAGE_MESSAGES', label: 'Manage Messages', bit: PermissionBits.MANAGE_MESSAGES },
  { key: 'ATTACH_FILES', label: 'Attach Files', bit: PermissionBits.ATTACH_FILES },
  { key: 'READ_MESSAGE_HISTORY', label: 'Read Message History', bit: PermissionBits.READ_MESSAGE_HISTORY },
  { key: 'ADD_REACTIONS', label: 'Add Reactions', bit: PermissionBits.ADD_REACTIONS },
];

const VOICE_CHANNEL_PERMISSIONS: PermissionDef[] = [
  { key: 'VIEW_CHANNEL', label: 'View Channel', bit: PermissionBits.VIEW_CHANNEL },
  { key: 'CONNECT', label: 'Connect', bit: PermissionBits.CONNECT },
  { key: 'SPEAK', label: 'Speak', bit: PermissionBits.SPEAK },
  { key: 'STREAM', label: 'Stream', bit: PermissionBits.STREAM },
  { key: 'MUTE_MEMBERS', label: 'Mute Members', bit: PermissionBits.MUTE_MEMBERS },
  { key: 'DEAFEN_MEMBERS', label: 'Deafen Members', bit: PermissionBits.DEAFEN_MEMBERS },
  { key: 'MOVE_MEMBERS', label: 'Move Members', bit: PermissionBits.MOVE_MEMBERS },
  { key: 'DISCONNECT_MEMBERS', label: 'Disconnect Members', bit: PermissionBits.DISCONNECT_MEMBERS },
];

// ─── Overview Tab ───────────────────────────────────────────────────────────────

function OverviewTab({
  channelId,
  channelName,
  channelType,
  isPrivate,
  isFetching,
  isLoading,
  error,
  canManageChannels,
  onTogglePrivate,
  onDeleteChannel,
}: {
  channelId: string;
  channelName: string;
  channelType: string;
  isPrivate: boolean;
  isFetching: boolean;
  isLoading: boolean;
  error: string;
  canManageChannels: boolean;
  onTogglePrivate: () => void;
  onDeleteChannel: () => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
          Channel
        </label>
        <div className="flex items-center gap-2 text-txt-primary">
          {isPrivate ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="opacity-60 flex-shrink-0">
              <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="opacity-60 flex-shrink-0">
              <path d="M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z" />
            </svg>
          )}
          <span className="text-sm font-medium">{channelName}</span>
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
          <div className={`flex-shrink-0 ml-4 ${(isLoading || isFetching) ? 'opacity-50 pointer-events-none' : ''}`}>
            <Toggle enabled={isPrivate} onChange={onTogglePrivate} />
          </div>
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

      {canManageChannels && (
        <div className="pt-4 border-t border-border-soft">
          <label className="block text-xs font-bold text-accent-rose uppercase mb-2">Danger Zone</label>
          <button
            onClick={onDeleteChannel}
            className="w-full px-3 py-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-accent-rose text-sm font-medium hover:bg-accent-rose/20 transition-colors"
          >
            Delete Channel
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ─────────────────────────────────────────────────────────────────

export function ChannelSettingsModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const channels = useSpaceStore((s) => s.channels);
  const spaces = useSpaceStore((s) => s.spaces);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);

  const [tab, setTab] = useState<'overview' | 'permissions'>('overview');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const isOpen = activeModal === 'channelSettings';
  const channelId = modalData?.channelId as string | undefined;
  const channel = channels.find(c => c.id === channelId);

  const myPerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;
  const canManageChannels = myPerms !== undefined && hasPermissionBit(myPerms, PermissionBits.MANAGE_CHANNELS);
  const canManageRoles = myPerms !== undefined && hasPermissionBit(myPerms, PermissionBits.MANAGE_ROLES);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setShowDeleteConfirm(false);
      setIsDeleting(false);
      setTab('overview');
    }
  }, [isOpen]);

  // Fetch overrides for the private toggle (overview tab)
  const fetchPrivateState = useCallback(() => {
    if (!channelId || !currentSpaceId) return;

    setIsFetching(true);
    setError('');

    const space = spaces.find(s => s.id === currentSpaceId);
    const channelApi = getApiForOrigin(space?._instanceOrigin ?? '');

    channelApi.channels.getOverrides(channelId)
      .then((data: { targetType: string; targetId: string; allow: string; deny: string }[]) => {
        // Check if @everyone role (id === spaceId) has VIEW_CHANNEL denied
        const everyoneOverride = data.find(
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
  }, [channelId, currentSpaceId, spaces]);

  useEffect(() => {
    if (isOpen && channelId && currentSpaceId) {
      fetchPrivateState();
    } else {
      setIsFetching(false);
    }
  }, [isOpen, channelId, currentSpaceId, fetchPrivateState]);

  if (!isOpen || !channel || !channelId || !currentSpaceId) return null;

  const space = spaces.find(s => s.id === currentSpaceId);

  const handleToggle = async () => {
    setError('');
    setIsLoading(true);

    const channelApi = getApiForOrigin(space?._instanceOrigin ?? '');

    try {
      if (!isPrivate) {
        // Make private: deny VIEW_CHANNEL for @everyone role
        await channelApi.channels.putOverride(channelId, {
          targetType: 'role',
          targetId: currentSpaceId,
          allow: '0',
          deny: permissionsToString(PermissionBits.VIEW_CHANNEL),
        });
        setIsPrivate(true);
      } else {
        // Make public: remove the @everyone VIEW_CHANNEL deny override
        await channelApi.channels.deleteOverride(channelId, 'role', currentSpaceId);
        setIsPrivate(false);
      }
      // Re-fetch to keep in sync
      fetchPrivateState();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update channel privacy');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteChannel = async () => {
    if (!channelId || !currentSpaceId) return;
    setIsDeleting(true);
    try {
      const channelApi = getApiForOrigin(space?._instanceOrigin ?? '');
      await channelApi.channels.delete(channelId);
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete channel');
      setIsDeleting(false);
    }
  };

  const showTabs = canManageRoles;

  const tabClass = (t: typeof tab) =>
    `w-full text-left px-2.5 py-1.5 rounded text-sm transition-colors ${
      tab === t ? 'bg-interactive-selected text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  return (
    <>
      <Modal isOpen={isOpen} onClose={closeModal} title="Channel Settings" mobileStyle="fullscreen" maxWidth={showTabs ? 'max-w-2xl' : 'max-w-md'}>
        {showTabs ? (
          <div className="flex gap-4 h-[min(520px,70vh)]">
            {/* Tabs */}
            <div className="w-32 flex-shrink-0 self-start z-10">
              <div className="glass-bubble rounded-lg p-1.5 space-y-0.5">
                <button onClick={() => setTab('overview')} className={tabClass('overview')}>
                  Overview
                </button>
                <button onClick={() => setTab('permissions')} className={tabClass('permissions')}>
                  Permissions
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin">
              {tab === 'overview' && (
                <OverviewTab
                  channelId={channelId}
                  channelName={channel.name}
                  channelType={channel.type}
                  isPrivate={isPrivate}
                  isFetching={isFetching}
                  isLoading={isLoading}
                  error={error}
                  canManageChannels={canManageChannels}
                  onTogglePrivate={handleToggle}
                  onDeleteChannel={() => setShowDeleteConfirm(true)}
                />
              )}
              {tab === 'permissions' && (
                <PermissionsEditor
                  entityId={channelId}
                  spaceId={currentSpaceId}
                  instanceOrigin={space?._instanceOrigin}
                  permDefs={channel.type === 'voice' ? VOICE_CHANNEL_PERMISSIONS : TEXT_CHANNEL_PERMISSIONS}
                  getOverrides={() => {
                    const channelApi = getApiForOrigin(space?._instanceOrigin ?? '');
                    return channelApi.channels.getOverrides(channelId);
                  }}
                  putOverride={(data) => {
                    const channelApi = getApiForOrigin(space?._instanceOrigin ?? '');
                    return channelApi.channels.putOverride(channelId, data);
                  }}
                  deleteOverride={(targetType, targetId) => {
                    const channelApi = getApiForOrigin(space?._instanceOrigin ?? '');
                    return channelApi.channels.deleteOverride(channelId, targetType, targetId);
                  }}
                />
              )}
            </div>
          </div>
        ) : (
          <OverviewTab
            channelId={channelId}
            channelName={channel.name}
            channelType={channel.type}
            isPrivate={isPrivate}
            isFetching={isFetching}
            isLoading={isLoading}
            error={error}
            canManageChannels={canManageChannels}
            onTogglePrivate={handleToggle}
            onDeleteChannel={() => setShowDeleteConfirm(true)}
          />
        )}
      </Modal>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteChannel}
        title={`Delete #${channel.name}?`}
        description={<>
          This will permanently delete <strong>#{channel.name}</strong> and all of its messages.
          {channel.type === 'voice' && ' Any users currently in this voice channel will be disconnected.'}
          {' '}This action cannot be undone.
        </>}
        confirmLabel="Delete Channel"
        variant="danger"
        loading={isDeleting}
      />
    </>
  );
}
