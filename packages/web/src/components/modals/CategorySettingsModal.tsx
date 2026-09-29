import React, { useState, useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { PermissionBits, hasPermissionBit } from '../../utils/permissions';
import { InlineNameEditor } from '../ui/InlineNameEditor';
import { PermissionsEditor } from '../ui/PermissionsEditor';
import type { PermissionDef } from '../ui/OverrideEntry';
import { describeError } from '../../i18n/errors';
import { useEntityOverrides } from '../../hooks/useEntityOverrides';
import { isHiddenFromEveryone } from '../../utils/overrideBits';
import { PrivacySetting } from './PrivacySetting';
import { CATEGORY_NAME_MAX_LENGTH, normalizeCategoryName } from '@backspace/shared/src/constants';

// ─── Permission Definitions for Category Overrides ──────────────────────────────

const CATEGORY_PERMISSIONS: PermissionDef[] = [
  { key: 'VIEW_CHANNEL', bit: PermissionBits.VIEW_CHANNEL },
  { key: 'SEND_MESSAGES', bit: PermissionBits.SEND_MESSAGES },
  { key: 'MANAGE_MESSAGES', bit: PermissionBits.MANAGE_MESSAGES },
  { key: 'ATTACH_FILES', bit: PermissionBits.ATTACH_FILES },
  { key: 'READ_MESSAGE_HISTORY', bit: PermissionBits.READ_MESSAGE_HISTORY },
  { key: 'ADD_REACTIONS', bit: PermissionBits.ADD_REACTIONS },
  { key: 'CONNECT', bit: PermissionBits.CONNECT },
  { key: 'SPEAK', bit: PermissionBits.SPEAK },
  { key: 'STREAM', bit: PermissionBits.STREAM },
  { key: 'MUTE_MEMBERS', bit: PermissionBits.MUTE_MEMBERS },
  { key: 'DEAFEN_MEMBERS', bit: PermissionBits.DEAFEN_MEMBERS },
  { key: 'MOVE_MEMBERS', bit: PermissionBits.MOVE_MEMBERS },
  { key: 'DISCONNECT_MEMBERS', bit: PermissionBits.DISCONNECT_MEMBERS },
];

// ─── Overview Tab ───────────────────────────────────────────────────────────────

function OverviewTab({
  categoryId,
  categoryName,
  isPrivate,
  isFetching,
  isLoading,
  error,
  canManageChannels,
  canManageRoles,
  onTogglePrivate,
  onDeleteCategory,
  onRename,
}: {
  categoryId: string;
  categoryName: string;
  isPrivate: boolean;
  isFetching: boolean;
  isLoading: boolean;
  error: string;
  canManageChannels: boolean;
  canManageRoles: boolean;
  onTogglePrivate: () => void;
  onDeleteCategory: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation(['spaces', 'common']);
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
          {t('spaces:category.settings.categoryLabel')}
        </label>
        <InlineNameEditor
          name={categoryName}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="opacity-60 flex-shrink-0">
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
          }
          canEdit={canManageChannels}
          editLabel={t('spaces:category.settings.rename')}
          fieldLabel={t('spaces:category.settings.nameLabel')}
          maxLength={CATEGORY_NAME_MAX_LENGTH}
          normalize={normalizeCategoryName}
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
          label={t('spaces:category.settings.private.label')}
          description={t('spaces:category.settings.private.description')}
          note={t('spaces:category.settings.private.note')}
          isPrivate={isPrivate}
          busy={isLoading || isFetching}
          onToggle={onTogglePrivate}
        />
      )}

      {canManageChannels && (
        <div className="pt-4 border-t border-border-soft">
          <label className="block text-xs font-bold text-accent-rose uppercase mb-2">{t('common:labels.dangerZone')}</label>
          <button
            onClick={onDeleteCategory}
            className="w-full px-3 py-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-accent-rose text-sm font-medium hover:bg-accent-rose/20 transition-colors"
          >
            {t('spaces:category.settings.deleteButton')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Modal ─────────────────────────────────────────────────────────────────

export function CategorySettingsModal() {
  const { t } = useTranslation(['spaces', 'common']);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const categories = useSpaceStore((s) => s.categories);
  const spaces = useSpaceStore((s) => s.spaces);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);

  const [tab, setTab] = useState<'overview' | 'permissions'>('overview');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const isOpen = activeModal === 'categorySettings';
  const categoryId = modalData?.categoryId as string | undefined;
  const category = categories.find(c => c.id === categoryId);

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

  // One list of this category's overrides for the whole dialog: the Overview
  // derives privacy from it and the Permissions tab edits it, so neither
  // shows a copy the other has made stale.
  const space = spaces.find(s => s.id === currentSpaceId);
  const entityOverrides = useEntityOverrides('category', isOpen ? categoryId : undefined, space, canManageRoles);
  const isPrivate = currentSpaceId ? isHiddenFromEveryone(entityOverrides.overrides, currentSpaceId) : false;
  const isFetching = !entityOverrides.loaded;
  const shownError = error || entityOverrides.error;

  if (!isOpen || !category || !categoryId || !currentSpaceId) return null;

  const handleToggle = async () => {
    setError('');
    setIsLoading(true);
    try {
      // Only the View Channels bit of the @everyone override changes; any
      // other @everyone bit on this category stays (#327, #365).
      await entityOverrides.setBits('role', currentSpaceId, PermissionBits.VIEW_CHANNEL, isPrivate ? 'neutral' : 'deny');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRename = async (name: string): Promise<void> => {
    setError('');
    try {
      await useSpaceStore.getState().updateCategory(categoryId, { name });
    } catch (err) {
      setError(describeError(err));
      throw err;
    }
  };

  const handleDeleteCategory = async () => {
    if (!categoryId) return;
    setIsDeleting(true);
    try {
      await useSpaceStore.getState().deleteCategory(categoryId);
      closeModal();
    } catch (err) {
      setError(describeError(err));
      setIsDeleting(false);
    }
  };

  const showTabs = canManageRoles;

  const tabClass = (target: typeof tab) =>
    `w-full text-left px-2.5 py-1.5 rounded text-sm transition-colors ${
      tab === target ? 'bg-interactive-selected text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  return (
    <>
      <Modal isOpen={isOpen} onClose={closeModal} title={t('spaces:category.settings.title')} mobileStyle="fullscreen" maxWidth={showTabs ? 'max-w-2xl' : 'max-w-md'}>
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
                  categoryId={categoryId}
                  categoryName={category.name}
                  isPrivate={isPrivate}
                  isFetching={isFetching}
                  isLoading={isLoading}
                  error={shownError}
                  canManageChannels={canManageChannels}
                  canManageRoles={canManageRoles}
                  onTogglePrivate={handleToggle}
                  onDeleteCategory={() => setShowDeleteConfirm(true)}
                  onRename={handleRename}
                />
              )}
              {tab === 'permissions' && (
                <PermissionsEditor
                  entityId={categoryId}
                  spaceId={currentSpaceId}
                  permDefs={CATEGORY_PERMISSIONS}
                  overrides={entityOverrides.overrides}
                  loadError={entityOverrides.error}
                  putOverride={entityOverrides.put}
                  deleteOverride={entityOverrides.remove}
                  onSaved={entityOverrides.reload}
                  unhideNote={t('spaces:category.settings.private.unhideOnSave')}
                />
              )}
            </div>
          </div>
        ) : (
          <OverviewTab
            categoryId={categoryId}
            categoryName={category.name}
            isPrivate={isPrivate}
            isFetching={isFetching}
            isLoading={isLoading}
            error={shownError}
            canManageChannels={canManageChannels}
            canManageRoles={canManageRoles}
            onTogglePrivate={handleToggle}
            onDeleteCategory={() => setShowDeleteConfirm(true)}
            onRename={handleRename}
          />
        )}
      </Modal>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteCategory}
        title={t('spaces:category.delete.title', { name: category.name })}
        description={
          <Trans
            t={t}
            i18nKey="spaces:category.delete.description"
            values={{ name: category.name }}
            components={{ strong: <strong /> }}
          />
        }
        confirmLabel={t('spaces:category.delete.confirm')}
        variant="danger"
        loading={isDeleting}
      />
    </>
  );
}
