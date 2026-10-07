import React, { useState, useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, getApiForOrigin } from '../../stores/spaceStore';
import { PermissionBits, hasPermissionBit } from '../../utils/permissions';
import { InlineNameEditor } from '../ui/InlineNameEditor';
import { PermissionsEditor } from '../ui/PermissionsEditor';
import type { PermissionDef } from '../ui/OverrideEntry';
import { describeError } from '../../i18n/errors';
import { useEntityOverrides } from '../../hooks/useEntityOverrides';
import { isHiddenFromEveryone } from '../../utils/overrideBits';
import { PrivacySetting } from './PrivacySetting';
import { LOCK_ICON } from '../ui/LockNote';
import { CHANNEL_NAME_MAX_LENGTH, normalizeChannelName } from '@backspace/shared/src/constants';

// ─── Permission Definitions for Channel Overrides ──────────────────────────────

const TEXT_CHANNEL_PERMISSIONS: PermissionDef[] = [
  { key: 'VIEW_CHANNEL', bit: PermissionBits.VIEW_CHANNEL },
  { key: 'SEND_MESSAGES', bit: PermissionBits.SEND_MESSAGES },
  { key: 'MANAGE_MESSAGES', bit: PermissionBits.MANAGE_MESSAGES },
  { key: 'ATTACH_FILES', bit: PermissionBits.ATTACH_FILES },
  { key: 'READ_MESSAGE_HISTORY', bit: PermissionBits.READ_MESSAGE_HISTORY },
  { key: 'ADD_REACTIONS', bit: PermissionBits.ADD_REACTIONS },
];

const VOICE_CHANNEL_PERMISSIONS: PermissionDef[] = [
  { key: 'VIEW_CHANNEL', bit: PermissionBits.VIEW_CHANNEL },
  { key: 'CONNECT', bit: PermissionBits.CONNECT },
  { key: 'SPEAK', bit: PermissionBits.SPEAK },
  { key: 'STREAM', bit: PermissionBits.STREAM },
  { key: 'MUTE_MEMBERS', bit: PermissionBits.MUTE_MEMBERS },
  { key: 'DEAFEN_MEMBERS', bit: PermissionBits.DEAFEN_MEMBERS },
  { key: 'MOVE_MEMBERS', bit: PermissionBits.MOVE_MEMBERS },
  { key: 'DISCONNECT_MEMBERS', bit: PermissionBits.DISCONNECT_MEMBERS },
];

const CHANNEL_ICON_PUBLIC = 'M5.88657 21C5.57547 21 5.3399 20.7189 5.39427 20.4126L6.00001 17H2.59511C2.28449 17 2.04905 16.7198 2.10259 16.4138L2.27759 15.4138C2.31946 15.1746 2.52722 15 2.77011 15H6.35001L7.41001 9H4.00511C3.69449 9 3.45905 8.71977 3.51259 8.41381L3.68759 7.41381C3.72946 7.17456 3.93722 7 4.18011 7H7.76001L8.39677 3.41262C8.43914 3.17391 8.64664 3 8.88907 3H9.87344C10.1845 3 10.4201 3.28107 10.3657 3.58738L9.76001 7H15.76L16.3968 3.41262C16.4391 3.17391 16.6466 3 16.8891 3H17.8734C18.1845 3 18.4201 3.28107 18.3657 3.58738L17.76 7H21.1649C21.4755 7 21.711 7.28023 21.6574 7.58619L21.4824 8.58619C21.4406 8.82544 21.2328 9 20.9899 9H17.41L16.35 15H19.7549C20.0655 15 20.301 15.2802 20.2474 15.5862L20.0724 16.5862C20.0306 16.8254 19.8228 17 19.5799 17H16L15.3632 20.5874C15.3209 20.8261 15.1134 21 14.8709 21H13.8866C13.5755 21 13.3399 20.7189 13.3943 20.4126L14 17H8.00001L7.36325 20.5874C7.32088 20.8261 7.11337 21 6.87094 21H5.88657ZM9.41001 9L8.35001 15H14.35L15.41 9H9.41001Z';

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
  canManageRoles,
  onTogglePrivate,
  onDeleteChannel,
  onRename,
}: {
  channelId: string;
  channelName: string;
  channelType: string;
  isPrivate: boolean;
  isFetching: boolean;
  isLoading: boolean;
  error: string;
  canManageChannels: boolean;
  canManageRoles: boolean;
  onTogglePrivate: () => void;
  onDeleteChannel: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation(['spaces', 'common']);
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
          {t('spaces:channel.settings.channelLabel')}
        </label>
        <InlineNameEditor
          name={channelName}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="opacity-60 flex-shrink-0">
              <path d={isPrivate ? LOCK_ICON : CHANNEL_ICON_PUBLIC} />
            </svg>
          }
          canEdit={canManageChannels}
          editLabel={t('spaces:channel.settings.rename')}
          fieldLabel={t('spaces:channel.settings.nameLabel')}
          maxLength={CHANNEL_NAME_MAX_LENGTH}
          normalize={normalizeChannelName}
          onSave={onRename}
        />
      </div>

      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {error}
        </div>
      )}

      {/* Privacy is an @everyone override: reading and writing it both need
          MANAGE_ROLES, so without it the row would only show a guess. */}
      {canManageRoles && (
        <PrivacySetting
          label={t('spaces:channel.settings.private.label')}
          description={t('spaces:channel.settings.private.description')}
          note={t('spaces:channel.settings.private.note')}
          isPrivate={isPrivate}
          busy={isLoading || isFetching}
          onToggle={onTogglePrivate}
        />
      )}

      {canManageChannels && (
        <div className="pt-4 border-t border-border-soft">
          <label className="block text-xs font-bold text-accent-rose uppercase mb-2">{t('common:labels.dangerZone')}</label>
          <button
            onClick={onDeleteChannel}
            className="w-full px-3 py-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-accent-rose text-sm font-medium hover:bg-accent-rose/20 transition-colors"
          >
            {t('spaces:channel.settings.deleteButton')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ─────────────────────────────────────────────────────────────────

export function ChannelSettingsModal() {
  const { t } = useTranslation(['spaces', 'common']);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const channels = useSpaceStore((s) => s.channels);
  const spaces = useSpaceStore((s) => s.spaces);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const channelPermissions = useSpaceStore((s) => s.channelPermissions);

  const [tab, setTab] = useState<'overview' | 'permissions'>('overview');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const isOpen = activeModal === 'channelSettings';
  const channelId = modalData?.channelId as string | undefined;
  const channel = channels.find(c => c.id === channelId);

  // Each flag reads the scope its server route checks (permissions.md, "Client
  // gating"): editing or deleting this channel resolves MANAGE_CHANNELS with the
  // channel's overrides, the override routes check MANAGE_ROLES space-wide.
  const canManageChannels = hasPermissionBit(channelId ? channelPermissions.get(channelId) : undefined, PermissionBits.MANAGE_CHANNELS);
  const canManageRoles = hasPermissionBit(currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined, PermissionBits.MANAGE_ROLES);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setShowDeleteConfirm(false);
      setIsDeleting(false);
      setTab('overview');
    }
  }, [isOpen]);

  // One list of this channel's overrides for the whole dialog: the Overview
  // derives privacy from it and the Permissions tab edits it, so neither
  // shows a copy the other has made stale.
  const space = spaces.find(s => s.id === currentSpaceId);
  const entityOverrides = useEntityOverrides('channel', isOpen ? channelId : undefined, space, canManageRoles);
  const isPrivate = currentSpaceId ? isHiddenFromEveryone(entityOverrides.overrides, currentSpaceId) : false;
  const isFetching = !entityOverrides.loaded;
  const shownError = error || entityOverrides.error;

  if (!isOpen || !channel || !channelId || !currentSpaceId) return null;

  const handleToggle = async () => {
    setError('');
    setIsLoading(true);
    try {
      // Only the View Channels bit of the @everyone override changes; any
      // other @everyone bit on this channel stays (#327, #365).
      await entityOverrides.setBits('role', currentSpaceId, PermissionBits.VIEW_CHANNEL, isPrivate ? 'neutral' : 'deny');
    } catch (err) {
      setError(describeError(err));
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
      setError(describeError(err));
      setIsDeleting(false);
    }
  };

  const handleRenameChannel = async (name: string): Promise<void> => {
    setError('');
    try {
      await useSpaceStore.getState().updateChannel(channelId, { name });
    } catch (err) {
      setError(describeError(err));
      throw err;
    }
  };

  const showTabs = canManageRoles;

  const tabClass = (target: typeof tab) =>
    `w-full text-left px-2.5 py-1.5 rounded text-sm transition-colors ${
      tab === target ? 'bg-interactive-selected text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  return (
    <>
      <Modal isOpen={isOpen} onClose={closeModal} title={t('spaces:channel.settings.title')} mobileStyle="fullscreen" maxWidth={showTabs ? 'max-w-2xl' : 'max-w-md'}>
        {showTabs ? (
          <div className="flex gap-4 h-[min(520px,calc(70*var(--app-vh)))]">
            {/* Tabs */}
            <div className="w-32 flex-shrink-0 self-start z-10">
              <div className="glass-bubble rounded-lg p-1.5 space-y-0.5">
                <button onClick={() => setTab('overview')} className={tabClass('overview')}>
                  {t('spaces:settings.nav.tabs.overview')}
                </button>
                <button onClick={() => setTab('permissions')} className={tabClass('permissions')}>
                  {t('spaces:permissions.title')}
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
                  error={shownError}
                  canManageChannels={canManageChannels}
                  canManageRoles={canManageRoles}
                  onTogglePrivate={handleToggle}
                  onDeleteChannel={() => setShowDeleteConfirm(true)}
                  onRename={handleRenameChannel}
                />
              )}
              {tab === 'permissions' && (
                <PermissionsEditor
                  entityId={channelId}
                  spaceId={currentSpaceId}
                  permDefs={channel.type === 'voice' ? VOICE_CHANNEL_PERMISSIONS : TEXT_CHANNEL_PERMISSIONS}
                  overrides={entityOverrides.overrides}
                  loadError={entityOverrides.error}
                  putOverride={entityOverrides.put}
                  deleteOverride={entityOverrides.remove}
                  onSaved={entityOverrides.reload}
                  unhideNote={t('spaces:channel.settings.private.unhideOnSave')}
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
            error={shownError}
            canManageChannels={canManageChannels}
            canManageRoles={canManageRoles}
            onTogglePrivate={handleToggle}
            onDeleteChannel={() => setShowDeleteConfirm(true)}
            onRename={handleRenameChannel}
          />
        )}
      </Modal>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteChannel}
        title={t('spaces:channel.delete.title', { name: channel.name })}
        description={
          <Trans
            t={t}
            i18nKey={channel.type === 'voice' ? 'spaces:channel.delete.descriptionVoice' : 'spaces:channel.delete.description'}
            values={{ name: channel.name }}
            components={{ strong: <strong /> }}
          />
        }
        confirmLabel={t('spaces:channel.delete.confirm')}
        variant="danger"
        loading={isDeleting}
      />
    </>
  );
}
