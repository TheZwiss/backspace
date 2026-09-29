import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpaceStore, getApiForOrigin } from '../../../stores/spaceStore';
import { useUIStore } from '../../../stores/uiStore';
import { HttpError } from '../../../api/client';
import { PermissionBits, stringToPermissions, permissionsToString } from '../../../utils/permissions';
import { PERMISSION_GROUPS, type PermDef, type PermissionGroupId } from '../../../utils/permissionGroups';
import { usePermissionNames } from '../../ui/OverrideEntry';
import { describeError } from '../../../i18n/errors';
import type { Role } from '@backspace/shared';
import {
  viewerCanManageRoleAt,
  useViewerHeldPermissions,
  viewerCanSwitchBit,
  viewerCanCreateRoleWith,
  viewerHoldsEveryBit,
} from '../../../utils/roleHierarchy';
import { RoleOrderList } from './RoleOrderList';
import { LockNote, LOCK_ICON } from '../../ui/LockNote';

const ALL_PERMISSION_DEFS: PermDef[] = PERMISSION_GROUPS.flatMap((group) => group.perms);
const PRESET_COLORS = [
  '#b9bbbe', '#a5f3c4', '#ffc9a9', '#c4b5fd', '#93c5fd',
  '#fbbf24', '#fda4af', '#f87171', '#60a5fa', '#34d399',
];

/** Auto-increment a base name ("Foo" → "Foo 2" → "Foo 3") to avoid uniqueness conflicts. */
function getUniqueRoleName(baseName: string, existingRoles: Role[]): string {
  const existingNames = new Set(existingRoles.map((r) => r.name.toLowerCase()));
  let candidateName = baseName;
  let counter = 2;
  while (existingNames.has(candidateName.toLowerCase())) {
    candidateName = `${baseName} ${counter}`;
    counter++;
  }
  return candidateName;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface RolesPanelProps {
  spaceId: string;
}

export function RolesPanel({ spaceId }: RolesPanelProps) {
  const { t } = useTranslation(['spaces', 'common']);
  const roles = useSpaceStore((s) => s.roles);
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);
  const space = useSpaceStore((s) => s.spaces.find((sp) => sp.id === spaceId));
  const members = useSpaceStore((s) => s.members);
  // A new role starts at the bottom (position 1), so creating one needs a top
  // role above that (permissions.md, "Role hierarchy").
  const canCreateRole = !space || viewerCanManageRoleAt(space, members, 1);

  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [isNewRole, setIsNewRole] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreateRole = async () => {
    setCreating(true);
    setError('');
    try {
      const uniqueName = getUniqueRoleName(t('spaces:roles.defaultName'), roles);
      // Roles live on the space's own instance (client-federation.md).
      const newRole = await getApiForOrigin(space?._instanceOrigin ?? '').roles.create(spaceId, { name: uniqueName });
      await loadSpaceDetail(spaceId);
      setIsNewRole(true);
      setEditingRoleId(newRole.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setCreating(false);
    }
  };

  if (editingRoleId) {
    const role = roles.find((r) => r.id === editingRoleId);
    if (!role) {
      setEditingRoleId(null);
      return null;
    }
    return (
      <RoleEditView
        key={editingRoleId}
        role={role}
        spaceId={spaceId}
        isNew={isNewRole}
        onBack={() => { setIsNewRole(false); setEditingRoleId(null); }}
        onDeleted={() => { setIsNewRole(false); setEditingRoleId(null); }}
        onCopied={(newRoleId) => { setIsNewRole(true); setEditingRoleId(newRoleId); }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">{t('spaces:roles.title')}</h2>
      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
      )}

      <div className="sticky top-0 z-10 pointer-events-none pb-3">
        <button
          onClick={handleCreateRole}
          disabled={creating || !canCreateRole}
          className="glass-bubble rounded-full px-3 py-1.5 flex items-center gap-1.5 text-sm text-txt-primary hover:text-txt-secondary transition-colors pointer-events-auto disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {creating ? t('spaces:roles.creating') : t('spaces:roles.create')}
        </button>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('spaces:roles.listHeading')}</div>
        <p className="text-xs text-txt-tertiary">{t('spaces:roles.description')}</p>
        <p className="text-xs text-txt-tertiary mb-2">{t('spaces:roles.hierarchyHint')}</p>
        <div className="rounded-lg bg-white/[0.02] p-2">
          <RoleOrderList
            spaceId={spaceId}
            onOpen={(roleId) => { setIsNewRole(false); setEditingRoleId(roleId); }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Role Edit View ─────────────────────────────────────────────────────────

interface RoleEditViewProps {
  role: Role;
  spaceId: string;
  isNew?: boolean;
  onBack: () => void;
  onDeleted: () => void;
  onCopied: (newRoleId: string) => void;
}

function RoleEditView({ role, spaceId, isNew, onBack, onDeleted, onCopied }: RoleEditViewProps) {
  const { t } = useTranslation(['spaces', 'common']);
  const permissionNames = usePermissionNames();
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);
  const roles = useSpaceStore((s) => s.roles);
  const space = useSpaceStore((s) => s.spaces.find((sp) => sp.id === spaceId));
  const members = useSpaceStore((s) => s.members);
  const isEveryone = role.id === spaceId;
  // Roles at or above the viewer's top role can be looked at, not changed
  // (permissions.md, "Role hierarchy"); the server refuses the change anyway.
  const canEdit = !space || viewerCanManageRoleAt(space, members, role.position);
  // Held-bits rule (permissions.md): only bits the viewer holds can be
  // switched, and a copy can only carry bits they hold.
  const held = useViewerHeldPermissions(spaceId);
  const copyCarriesUnheld = !viewerCanCreateRoleWith(held, stringToPermissions(role.permissions));
  const canCopy = (!space || viewerCanManageRoleAt(space, members, 1)) && !copyCarriesUnheld;
  // Deleting switches the role's bits off for everyone holding it.
  const offersDelete = !isEveryone && canEdit;
  const deleteCarriesUnheld = offersDelete && !viewerHoldsEveryBit(held, stringToPermissions(role.permissions));
  const hasUnheldToggle = canEdit && ALL_PERMISSION_DEFS.some((perm) => !viewerCanSwitchBit(held, perm.bit));
  // Every role write goes to the space's own instance (client-federation.md).
  const roleApi = () => getApiForOrigin(space?._instanceOrigin ?? '').roles;

  const [draftName, setDraftName] = useState(role.name);
  const [nameError, setNameError] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEveryone && canEdit && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, []);

  const validateName = (name: string): string => {
    const trimmed = name.trim();
    if (!trimmed) return t('spaces:roles.nameEmpty');
    const isDuplicate = roles.some(
      (r) => r.id !== role.id && r.name.toLowerCase() === trimmed.toLowerCase()
    );
    return isDuplicate ? t('spaces:roles.nameDuplicate') : '';
  };

  const [draftColor, setDraftColor] = useState(role.color);
  const [draftPermissions, setDraftPermissions] = useState<bigint>(
    stringToPermissions(role.permissions)
  );
  const addToast = useUIStore((s) => s.addToast);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hasNameChange = !isEveryone && draftName.trim() !== role.name;
  const hasColorChange = !isEveryone && draftColor !== role.color;
  const hasPermChange = permissionsToString(draftPermissions) !== (role.permissions ?? '0');
  const hasChanges = hasNameChange || hasColorChange || hasPermChange;

  const togglePermission = (bit: bigint) => {
    if (!canEdit || !viewerCanSwitchBit(held, bit)) return;
    setDraftPermissions((prev) => (prev & bit) !== 0n ? prev & ~bit : prev | bit);
  };

  const handleSave = async () => {
    setConfirmDelete(false);
    setSaving(true);
    setSaveError('');
    try {
      const data: { name?: string; color?: string; permissions?: string } = {};
      if (hasNameChange) data.name = draftName.trim();
      if (hasColorChange) data.color = draftColor;
      if (hasPermChange) data.permissions = permissionsToString(draftPermissions);
      await roleApi().update(spaceId, role.id, data);
      await loadSpaceDetail(spaceId);
      addToast(t('spaces:roles.saved'), 'success', 2000);
    } catch (err) {
      // A duplicate name belongs on the name field, not in the save banner.
      if (err instanceof HttpError && err.code === 'role_name_taken') {
        setNameError(t('spaces:roles.nameDuplicate'));
      } else {
        setSaveError(describeError(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDraftName(role.name);
    setDraftColor(role.color);
    setDraftPermissions(stringToPermissions(role.permissions));
    setConfirmDelete(false);
    setSaveError('');
    setNameError('');
  };

  const handleDelete = async () => {
    if (deleteCarriesUnheld) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setSaveError('');
    try {
      await roleApi().delete(spaceId, role.id);
      await loadSpaceDetail(spaceId);
      onDeleted();
    } catch (err) {
      setSaveError(describeError(err));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const [copying, setCopying] = useState(false);

  const handleCopy = async () => {
    setCopying(true);
    setSaveError('');
    try {
      const uniqueName = getUniqueRoleName(t('spaces:roles.copyName', { name: role.name }), roles);
      const newRole = await roleApi().create(spaceId, {
        name: uniqueName,
        color: role.color,
        permissions: role.permissions ?? undefined,
      });
      await loadSpaceDetail(spaceId);
      onCopied(newRole.id);
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setCopying(false);
    }
  };

  const groupTitle = (id: PermissionGroupId): string => {
    switch (id) {
      case 'general': return t('spaces:roles.groups.general');
      case 'text': return t('spaces:roles.groups.text');
      case 'voice': return t('spaces:roles.groups.voice');
    }
  };

  return (
    <div className="space-y-5">
      {/* Back button */}
      <div className="sticky top-0 z-10 pointer-events-none pb-3">
        <button
          onClick={onBack}
          className="glass-bubble rounded-full px-3 py-1.5 flex items-center gap-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors pointer-events-auto"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {t('spaces:roles.backToList')}
        </button>
      </div>

      {isNew && !hasChanges && (
        <div className="p-2 bg-status-online/10 border border-status-online/30 rounded text-status-online text-sm">
          {t('spaces:roles.created')}
        </div>
      )}

      {!canEdit && <LockNote>{t('spaces:roles.aboveYou')}</LockNote>}

      {(hasUnheldToggle || copyCarriesUnheld) && (
        <LockNote>
          {hasUnheldToggle && t('spaces:roles.unheldLocked')}
          {hasUnheldToggle && copyCarriesUnheld && ' '}
          {copyCarriesUnheld && t(deleteCarriesUnheld ? 'spaces:roles.copyDeleteUnheld' : 'spaces:roles.copyUnheld')}
        </LockNote>
      )}

      {/* Identity card (Name + Color — not shown for @everyone) */}
      {!isEveryone && (
        <div>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">{t('spaces:roles.identity')}</div>
          {/* A disabled fieldset disables every control inside it. */}
          <fieldset disabled={!canEdit} className={`rounded-lg bg-white/[0.02] p-3.5 space-y-4 min-w-0 ${canEdit ? '' : 'opacity-60'}`}>
            <div>
              <label className="block text-xs text-txt-secondary mb-1.5">
                {t('spaces:roles.nameLabel')}
              </label>
              <input
                ref={nameInputRef}
                type="text"
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value);
                  setNameError(validateName(e.target.value));
                }}
                onBlur={() => setNameError(validateName(draftName))}
                className={`input-standard w-full${nameError ? ' ring-2 ring-accent-rose' : ''}`}
              />
              {nameError && (
                <p className="text-xs text-txt-danger mt-1">{nameError}</p>
              )}
            </div>
            <div>
              <label className="block text-xs text-txt-secondary mb-1.5">
                {t('spaces:roles.colorLabel')}
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setDraftColor(c)}
                    className={`w-7 h-7 rounded-full border-2 transition-all ${
                      draftColor === c ? 'border-white scale-110' : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <label className="relative w-7 h-7 rounded-full border-2 border-border-subtle hover:border-accent-primary transition-colors cursor-pointer overflow-hidden">
                  <input
                    type="color"
                    value={draftColor}
                    onChange={(e) => setDraftColor(e.target.value)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className="w-full h-full rounded-full bg-gradient-to-br from-red-400 via-green-400 to-blue-400" />
                </label>
                <input
                  type="text"
                  value={draftColor}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setDraftColor(v);
                  }}
                  className="input-standard w-20 px-2 py-1 text-xs font-mono"
                  maxLength={7}
                />
              </div>
            </div>
          </fieldset>
        </div>
      )}

      {/* Permission groups — each gets its own section card */}
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.id}>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            {groupTitle(group.id)}
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="space-y-1">
              {group.perms.map((perm) => {
                const isAdminBit = perm.bit === PermissionBits.ADMINISTRATOR;
                const hasAdmin = (draftPermissions & PermissionBits.ADMINISTRATOR) !== 0n;
                const isOn = isAdminBit ? hasAdmin : hasAdmin || (draftPermissions & perm.bit) !== 0n;
                const isInherited = !isAdminBit && hasAdmin;
                const isUnheld = canEdit && !viewerCanSwitchBit(held, perm.bit);
                const isLocked = isInherited || !canEdit || isUnheld;
                const name = permissionNames[perm.key];
                return (
                  <label
                    key={perm.key}
                    className={`flex items-center justify-between gap-3 py-1.5 px-2 rounded group/perm ${
                      isLocked ? 'cursor-default' : 'cursor-pointer hover:bg-interactive-hover'
                    }`}
                  >
                    <span className={`text-sm ${isLocked ? 'opacity-50 ' : ''}${isAdminBit ? 'text-txt-danger font-medium' : 'text-txt-primary'}`}>
                      {name}
                    </span>
                    <span className="flex items-center gap-2 flex-shrink-0">
                      {isUnheld && (
                        <svg
                          width="12" height="12" viewBox="0 0 24 24" fill="currentColor"
                          className="text-txt-tertiary"
                          role="img"
                          aria-label={t('spaces:roles.unheldPermission')}
                        >
                          <title>{t('spaces:roles.unheldPermission')}</title>
                          <path d={LOCK_ICON} />
                        </svg>
                      )}
                      <div
                        role="switch"
                        aria-checked={isOn}
                        aria-disabled={isLocked}
                        aria-label={name}
                        tabIndex={isLocked ? -1 : 0}
                        onClick={(e) => {
                          e.preventDefault();
                          if (!isLocked) togglePermission(perm.bit);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== ' ' && e.key !== 'Enter') return;
                          e.preventDefault();
                          if (!isLocked) togglePermission(perm.bit);
                        }}
                        className={`relative w-9 h-5 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary ${
                          isLocked ? 'cursor-default opacity-50' : 'cursor-pointer'
                        } ${isOn ? 'bg-accent-primary' : 'bg-interactive-muted'}`}
                      >
                        <div
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                            isOn ? 'translate-x-4' : 'translate-x-0.5'
                          }`}
                        />
                      </div>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      ))}

      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}
      <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className={`glass-bubble rounded-full px-4 py-2 flex items-center gap-2 pointer-events-auto${
              isEveryone ? ' animate-slide-up' : ''
            }`}>
              {hasChanges && (
                <>
                  <button
                    onClick={handleDiscard}
                    className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
                  >
                    {t('spaces:settings.discardChanges')}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving || (!isEveryone && !draftName.trim()) || !!nameError}
                    className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
                  >
                    {saving ? t('common:states.saving') : t('common:actions.save')}
                  </button>
                </>
              )}
              {hasChanges && (
                <div className="w-px h-5 bg-white/10" />
              )}
              <button
                onClick={handleCopy}
                disabled={copying || !canCopy}
                className="px-3 py-1.5 text-sm font-medium rounded-full text-txt-secondary hover:bg-interactive-hover transition-colors disabled:opacity-50"
              >
                {copying ? t('spaces:roles.copying') : t('spaces:roles.copy')}
              </button>
              {offersDelete && (
                <>
                  <div className="w-px h-5 bg-white/10" />
                  <button
                    onClick={handleDelete}
                    disabled={deleting || deleteCarriesUnheld}
                    className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors disabled:opacity-50 ${
                      confirmDelete
                        ? 'bg-accent-rose/15 text-accent-rose'
                        : 'text-accent-rose hover:bg-accent-rose/10'
                    }`}
                  >
                    {deleting ? t('spaces:roles.deleting') : confirmDelete ? t('spaces:roles.confirmDelete') : t('spaces:roles.delete')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
    </div>
  );
}
