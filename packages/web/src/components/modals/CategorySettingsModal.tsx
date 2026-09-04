import React, { useState, useEffect, useCallback } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, getApiForOrigin } from '../../stores/spaceStore';
import { PermissionBits, permissionsToString, stringToPermissions, hasPermissionBit } from '../../utils/permissions';
import { Toggle } from '../ui/Toggle';
import { PermissionsEditor } from '../ui/PermissionsEditor';
import type { PermissionDef } from '../ui/OverrideEntry';
import { describeError } from '../../i18n/errors';

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
  onRename: (name: string) => void;
}) {
  const { t } = useTranslation(['spaces']);
  const [editName, setEditName] = useState(categoryName);
  const [isSavingName, setIsSavingName] = useState(false);

  // Sync edit name when category name changes externally
  useEffect(() => {
    setEditName(categoryName);
  }, [categoryName]);

  const handleNameBlur = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== categoryName) {
      setIsSavingName(true);
      onRename(trimmed);
      // The parent will update the store; we just reset the saving state after a short delay
      setTimeout(() => setIsSavingName(false), 500);
    } else {
      setEditName(categoryName);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      setEditName(categoryName);
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
          {t('spaces:category.settings.categoryLabel')}
        </label>
        {canManageChannels ? (
          <div className="flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="opacity-60 flex-shrink-0 text-txt-primary">
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              disabled={isSavingName}
              className="input-standard flex-1 py-1.5 px-2 text-sm"
              maxLength={100}
            />
          </div>
        ) : (
          <div className="flex items-center gap-2 text-txt-primary">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="opacity-60 flex-shrink-0">
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
            <span className="text-sm font-medium">{categoryName}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {error}
        </div>
      )}

      <div className="pt-2 border-t border-border-soft">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-txt-primary">{t('spaces:category.settings.private.label')}</div>
            <div className="text-xs text-txt-tertiary mt-0.5">
              {t('spaces:category.settings.private.description')}
            </div>
          </div>
          <div className={`flex-shrink-0 ml-4 ${(isLoading || isFetching || !canManageRoles) ? 'opacity-50 pointer-events-none' : ''}`}>
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
            {t('spaces:category.settings.private.note')}
          </span>
        </div>
      )}

      {canManageChannels && (
        <div className="pt-4 border-t border-border-soft">
          <label className="block text-xs font-bold text-accent-rose uppercase mb-2">{t('spaces:settings.dangerZone')}</label>
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
  const { t } = useTranslation(['spaces']);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const categories = useSpaceStore((s) => s.categories);
  const spaces = useSpaceStore((s) => s.spaces);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);

  const [tab, setTab] = useState<'overview' | 'permissions'>('overview');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
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

  // Fetch overrides for the private toggle (overview tab)
  const fetchPrivateState = useCallback(() => {
    if (!categoryId || !currentSpaceId) return;

    setIsFetching(true);
    setError('');

    const space = spaces.find(s => s.id === currentSpaceId);
    const catApi = getApiForOrigin(space?._instanceOrigin ?? '');

    catApi.categories.getOverrides(categoryId)
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
        setError(describeError(err));
      })
      .finally(() => {
        setIsFetching(false);
      });
  }, [categoryId, currentSpaceId, spaces]);

  useEffect(() => {
    if (isOpen && categoryId && currentSpaceId) {
      fetchPrivateState();
    } else {
      setIsFetching(false);
    }
  }, [isOpen, categoryId, currentSpaceId, fetchPrivateState]);

  if (!isOpen || !category || !categoryId || !currentSpaceId) return null;

  const space = spaces.find(s => s.id === currentSpaceId);

  const handleToggle = async () => {
    setError('');
    setIsLoading(true);

    const catApi = getApiForOrigin(space?._instanceOrigin ?? '');

    try {
      if (!isPrivate) {
        // Make private: deny VIEW_CHANNEL for @everyone role
        await catApi.categories.putOverride(categoryId, {
          targetType: 'role',
          targetId: currentSpaceId,
          allow: '0',
          deny: permissionsToString(PermissionBits.VIEW_CHANNEL),
        });
        setIsPrivate(true);
      } else {
        // Make public: remove the @everyone VIEW_CHANNEL deny override
        await catApi.categories.deleteOverride(categoryId, 'role', currentSpaceId);
        setIsPrivate(false);
      }
      // Re-fetch to keep in sync
      fetchPrivateState();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRename = async (name: string) => {
    setError('');
    try {
      await useSpaceStore.getState().updateCategory(categoryId, { name });
    } catch (err) {
      setError(describeError(err));
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
          <div className="flex gap-4 h-[min(520px,70vh)]">
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
                  error={error}
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
                  instanceOrigin={space?._instanceOrigin}
                  permDefs={CATEGORY_PERMISSIONS}
                  getOverrides={() => {
                    const catApi = getApiForOrigin(space?._instanceOrigin ?? '');
                    return catApi.categories.getOverrides(categoryId);
                  }}
                  putOverride={(data) => {
                    const catApi = getApiForOrigin(space?._instanceOrigin ?? '');
                    return catApi.categories.putOverride(categoryId, data);
                  }}
                  deleteOverride={(targetType, targetId) => {
                    const catApi = getApiForOrigin(space?._instanceOrigin ?? '');
                    return catApi.categories.deleteOverride(categoryId, targetType, targetId);
                  }}
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
            error={error}
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
