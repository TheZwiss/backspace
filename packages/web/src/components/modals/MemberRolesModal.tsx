import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemberWithUser, Role } from '@backspace/shared';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { LockNote, LOCK_ICON } from '../ui/LockNote';
import { usePermissionNames } from '../ui/OverrideEntry';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, getApiForOrigin, type TaggedSpace } from '../../stores/spaceStore';
import { PermissionBits, stringToPermissions, permissionsToString } from '../../utils/permissions';
import { PERMISSION_GROUPS, type PermissionGroupId } from '../../utils/permissionGroups';
import {
  viewerCanManageRoleAt,
  viewerCanSwitchBit,
  viewerHoldsEveryBit,
  useViewerHeldPermissions,
} from '../../utils/roleHierarchy';
import { userDisplayName } from '../../utils/identity';
import { useSpaceOrigin } from '../../hooks/useSpaceOrigin';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { describeError } from '../../i18n/errors';
import { withSavedRole } from '../../utils/roleOrder';

const ALL_PERMISSION_DEFS = PERMISSION_GROUPS.flatMap((group) => group.perms);

/** Why a membership checkbox is locked: the role ranks too high, or it carries bits the viewer lacks. */
type RoleLock = 'rank' | 'bits';

/** True when both sets contain exactly the same ids. */
function sameIds(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** The member's assigned roles as ids; @everyone (id === spaceId) is implicit and never part of the set. */
function assignedRoleIds(member: MemberWithUser, spaceId: string): Set<string> {
  return new Set((member.roles ?? []).map((r) => r.id).filter((id) => id !== spaceId));
}

/**
 * Role editor for one member, opened from the profile card's Edit Roles
 * (UserProfilePopout) with `{ spaceId, userId }`, where `userId` is the
 * member's id on the space's instance. Left pane: every role of the space
 * with its membership checkbox plus the space's @everyone row. Right pane:
 * the permissions behind whichever role is selected, the same editor the
 * roles tab offers, so a moderator can fix both "who has this role" and
 * "what the role grants" without leaving the member.
 *
 * It follows the role hierarchy and the held-bits rule the server enforces
 * (permissions.md): roles at or above the viewer are read-only, a role
 * carrying bits the viewer lacks cannot be given, and those bits cannot be
 * switched. Desktop only: AppLayout mounts it in the desktop tree.
 */
export function MemberRolesModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);

  const spaceId = typeof modalData.spaceId === 'string' ? modalData.spaceId : '';
  const userId = typeof modalData.userId === 'string' ? modalData.userId : '';

  return (
    <Modal
      isOpen={activeModal === 'memberRoles' && !!spaceId && !!userId}
      onClose={closeModal}
      size="settings"
    >
      <MemberRolesEditor key={`${spaceId}:${userId}`} spaceId={spaceId} userId={userId} onClose={closeModal} />
    </Modal>
  );
}

/**
 * Resolves the live member and space. The store holds one space's members and
 * roles at a time, so the dialog closes once its member is gone or another
 * space becomes the current one, instead of editing against the wrong list.
 */
function MemberRolesEditor({ spaceId, userId, onClose }: { spaceId: string; userId: string; onClose: () => void }) {
  const member = useSpaceStore((s) =>
    s.currentSpaceId === spaceId ? s.members.find((m) => m.userId === userId) : undefined,
  );
  const space = useSpaceStore((s) => s.spaces.find((x) => x.id === spaceId));
  const gone = !member || !space;

  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  if (!member || !space) return null;
  return <MemberRolesBody space={space} member={member} onClose={onClose} />;
}

function MemberRolesBody({
  space,
  member,
  onClose,
}: {
  space: TaggedSpace;
  member: MemberWithUser;
  onClose: () => void;
}) {
  const { t } = useTranslation(['spaces', 'common']);
  const spaceId = space.id;
  const userId = member.userId;
  const roles = useSpaceStore((s) => s.roles);
  const members = useSpaceStore((s) => s.members);
  const held = useViewerHeldPermissions(spaceId);
  const addToast = useUIStore((s) => s.addToast);
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const permissionNames = usePermissionNames();
  const origin = useSpaceOrigin(spaceId);
  const canonical = useCanonicalUserView(member.user, origin);
  const displayName = userDisplayName(canonical);
  const nameIdPrefix = useId();

  // Roles live on the space's own instance (client-federation.md).
  const spaceApi = getApiForOrigin(space._instanceOrigin ?? '');

  // Same ordering as the roles tab: by position desc, @everyone always last.
  const sortedRoles = [...roles].sort((a, b) => {
    const aIsEveryone = a.id === spaceId;
    const bIsEveryone = b.id === spaceId;
    if (aIsEveryone) return 1;
    if (bIsEveryone) return -1;
    return b.position - a.position;
  });

  // Opens on the member's highest role, or @everyone for a member without one.
  const [selectedRoleId, setSelectedRoleId] = useState<string>(() => {
    const top = [...(member.roles ?? [])]
      .filter((r) => r.id !== spaceId)
      .sort((a, b) => b.position - a.position)[0];
    return top?.id ?? spaceId;
  });
  const [permDrafts, setPermDrafts] = useState<Map<string, bigint>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);

  // The error sits at the end of the permissions; bring it into view when it appears.
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);

  // The membership the drafts are compared against, and the draft itself.
  // While there is no local edit the baseline follows the member's roles, so
  // a change another moderator makes shows here instead of being overwritten
  // by a stale set on the next save.
  const serverRoleIds = useMemo(() => assignedRoleIds(member, spaceId), [member, spaceId]);
  const serverRoleKey = [...serverRoleIds].sort().join(',');
  const [initialRoleIds, setInitialRoleIds] = useState<Set<string>>(serverRoleIds);
  const [draftRoleIds, setDraftRoleIds] = useState<Set<string>>(serverRoleIds);
  // Compared by content: a reload hands over a new array with the same roles.
  const [syncedRoleKey, setSyncedRoleKey] = useState(serverRoleKey);
  if (syncedRoleKey !== serverRoleKey) {
    setSyncedRoleKey(serverRoleKey);
    if (sameIds(draftRoleIds, initialRoleIds)) {
      setInitialRoleIds(serverRoleIds);
      setDraftRoleIds(serverRoleIds);
    }
  }

  const selectedRole = roles.find((r) => r.id === selectedRoleId) ?? null;
  const selectedPermissions = selectedRole
    ? permDrafts.get(selectedRole.id) ?? stringToPermissions(selectedRole.permissions)
    : 0n;
  // Roles at or above the viewer's top role are shown, not changed.
  const canEditSelected = selectedRole !== null && viewerCanManageRoleAt(space, members, selectedRole.position);
  const hasUnheldToggle = canEditSelected && ALL_PERMISSION_DEFS.some((perm) => !viewerCanSwitchBit(held, perm.bit));

  // A membership checkbox is locked when the role ranks at or above the
  // viewer (hierarchy), or when giving it would hand out bits the viewer does
  // not hold (held-bits rule). Taking a role the member has is governed by the
  // hierarchy alone, as on the server.
  const roleLocks = new Map<string, RoleLock>();
  for (const role of roles) {
    if (role.id === spaceId) continue;
    if (!viewerCanManageRoleAt(space, members, role.position)) roleLocks.set(role.id, 'rank');
    else if (!serverRoleIds.has(role.id) && !viewerHoldsEveryBit(held, stringToPermissions(role.permissions))) {
      roleLocks.set(role.id, 'bits');
    }
  }
  const lockKinds = (['rank', 'bits'] as const).filter((kind) => [...roleLocks.values()].includes(kind));
  const lockReason: Record<RoleLock, string> = {
    rank: t('spaces:settings.members.rolesAboveYou'),
    bits: t('spaces:settings.members.rolesUnheld'),
  };

  const membershipChanged = !sameIds(draftRoleIds, initialRoleIds);
  const dirtyRoles = roles.filter((role) => {
    const draft = permDrafts.get(role.id);
    return draft !== undefined && permissionsToString(draft) !== (role.permissions ?? '0');
  });
  const hasChanges = membershipChanged || dirtyRoles.length > 0;

  const toggleMembership = (roleId: string) => {
    if (roleLocks.has(roleId)) return;
    setDraftRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const togglePermission = (bit: bigint) => {
    if (!selectedRole || !canEditSelected || !viewerCanSwitchBit(held, bit)) return;
    const next = (selectedPermissions & bit) !== 0n ? selectedPermissions & ~bit : selectedPermissions | bit;
    setPermDrafts((prev) => new Map(prev).set(selectedRole.id, next));
  };

  const handleDiscard = () => {
    // Back to what the member holds now, not to the set the edit started
    // from: another moderator may have changed it meanwhile.
    setInitialRoleIds(serverRoleIds);
    setDraftRoleIds(serverRoleIds);
    setPermDrafts(new Map());
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      // Each write that lands is applied here at once, so a partial save (the
      // member updated, a role write refused) shows exactly what landed. The
      // server also sends space_access_changed for each, which refreshes the
      // rest of the space for every member.
      if (membershipChanged) {
        const updated = await spaceApi.spaces.updateMember(spaceId, userId, { roleIds: Array.from(draftRoleIds) });
        const { members, setMembers } = useSpaceStore.getState();
        setMembers(members.map((m) => (m.userId === userId ? { ...m, roles: updated.roles } : m)));
        // What the server now holds becomes the new baseline.
        setInitialRoleIds(new Set(draftRoleIds));
      }
      for (const role of dirtyRoles) {
        const draft = permDrafts.get(role.id);
        if (draft === undefined) continue;
        const saved = await spaceApi.roles.update(spaceId, role.id, { permissions: permissionsToString(draft) });
        const { roles, setRoles } = useSpaceStore.getState();
        setRoles(withSavedRole(roles, saved));
        setPermDrafts((prev) => {
          const next = new Map(prev);
          next.delete(role.id);
          return next;
        });
      }
      addToast(t('spaces:memberRoles.saved'), 'success', 2000);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleViewProfile = (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget.getBoundingClientRect();
    onClose();
    openUserProfile(canonical, origin, anchor, 'right', { spaceId, userId });
  };

  const groupTitle = (id: PermissionGroupId): string => {
    switch (id) {
      case 'general': return t('spaces:roles.groups.general');
      case 'text': return t('spaces:roles.groups.text');
      case 'voice': return t('spaces:roles.groups.voice');
    }
  };

  // @everyone is the role's identifier, not a phrase, so it is not translated.
  const roleName = (role: Role): string => (role.id === spaceId ? '@everyone' : role.name);

  return (
    <div className="flex flex-col h-full">
      {/* Header: who is being edited, plus the way back to the profile card */}
      <div className="flex items-center gap-3 px-6 py-4 pr-16 border-b border-white/[0.06] flex-shrink-0">
        <Avatar
          src={canonical.avatar}
          name={displayName}
          size={40}
          status={canonical.status}
          user={canonical}
        />
        <h2 className="flex-1 min-w-0 text-lg font-semibold text-txt-primary truncate" title={displayName}>
          {t('spaces:memberRoles.title', { name: displayName })}
        </h2>
        <button
          onClick={handleViewProfile}
          className="flex-shrink-0 px-3 py-1.5 text-sm font-medium rounded-full text-txt-secondary hover:bg-interactive-hover transition-colors"
        >
          {t('spaces:memberRoles.viewProfile')}
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Left pane: membership checkboxes; clicking a row edits that role */}
        <div className="w-72 flex-shrink-0 border-r border-white/[0.06] overflow-y-auto scrollbar-thin p-4">
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            {t('spaces:roles.listHeading')}
          </div>
          <div className="rounded-lg bg-white/[0.02] p-2">
            <div className="space-y-0.5">
              {sortedRoles.map((role) => {
                const isEveryone = role.id === spaceId;
                const selected = selectedRoleId === role.id;
                const lock = roleLocks.get(role.id);
                const nameId = `${nameIdPrefix}-${role.id}`;
                const name = roleName(role);
                return (
                  <div
                    key={role.id}
                    onClick={() => setSelectedRoleId(role.id)}
                    className={`flex items-center gap-2.5 px-2.5 py-2 rounded cursor-pointer transition-colors ${
                      selected ? 'bg-interactive-selected' : 'hover:bg-interactive-hover'
                    }`}
                  >
                    <input
                      type="checkbox"
                      aria-labelledby={nameId}
                      title={lock ? lockReason[lock] : undefined}
                      checked={isEveryone || draftRoleIds.has(role.id)}
                      disabled={isEveryone || lock !== undefined}
                      onChange={() => toggleMembership(role.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-3.5 h-3.5 rounded border-txt-tertiary accent-accent-primary flex-shrink-0 disabled:opacity-50"
                    />
                    <div
                      className={`w-3 h-3 rounded-full flex-shrink-0${lock ? ' opacity-50' : ''}`}
                      style={{ backgroundColor: role.color }}
                    />
                    <span
                      id={nameId}
                      title={name}
                      className={`text-sm text-txt-primary truncate${lock ? ' opacity-50' : ''}`}
                    >
                      {name}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          {lockKinds.length > 0 && (
            <div className="mt-3">
              <LockNote>
                {lockKinds.map((kind) => <span key={kind} className="block">{lockReason[kind]}</span>)}
              </LockNote>
            </div>
          )}
        </div>

        {/* Right pane: permissions of the role selected on the left */}
        <div data-pane="permissions" className="flex-1 min-w-0 overflow-y-auto scrollbar-thin px-6 pt-6 pb-3">
          {selectedRole ? (
            <>
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: selectedRole.color }}
                />
                <h3 className="text-base font-semibold text-txt-primary truncate" title={roleName(selectedRole)}>
                  {roleName(selectedRole)}
                </h3>
              </div>
              <p className="text-xs text-txt-tertiary mt-1 mb-4">{t('spaces:memberRoles.affectsAll')}</p>

              {(!canEditSelected || hasUnheldToggle) && (
                <div className="space-y-2 mb-5">
                  {!canEditSelected && <LockNote>{t('spaces:roles.aboveYou')}</LockNote>}
                  {hasUnheldToggle && <LockNote>{t('spaces:roles.unheldLocked')}</LockNote>}
                </div>
              )}

              {PERMISSION_GROUPS.map((group) => (
                <div key={group.id} className="mb-5">
                  <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
                    {groupTitle(group.id)}
                  </div>
                  <div className="rounded-lg bg-white/[0.02] p-3.5">
                    <div className="space-y-1">
                      {group.perms.map((perm) => {
                        const isAdminBit = perm.bit === PermissionBits.ADMINISTRATOR;
                        const hasAdmin = (selectedPermissions & PermissionBits.ADMINISTRATOR) !== 0n;
                        const isOn = isAdminBit ? hasAdmin : hasAdmin || (selectedPermissions & perm.bit) !== 0n;
                        const isInherited = !isAdminBit && hasAdmin;
                        const isUnheld = canEditSelected && !viewerCanSwitchBit(held, perm.bit);
                        const isLocked = isInherited || !canEditSelected || isUnheld;
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
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-center text-sm text-txt-tertiary px-8">
              {t('spaces:memberRoles.selectRole')}
            </div>
          )}
          {/* A failed save, in flow above the pill as in the roles tab. */}
          {error && (
            <div ref={errorRef} role="alert" className="mt-1 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
              {error}
            </div>
          )}

          {/* Save pill: only while something changed. Sticky at the foot of
              the permissions pane, as in the roles tab. */}
          {hasChanges && (
            <div className="sticky bottom-0 z-10 pointer-events-none">
              <div className="flex justify-center pt-3 pb-1">
                <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 pointer-events-auto animate-slide-up">
                  <button
                    onClick={handleDiscard}
                    className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
                  >
                    {t('spaces:settings.discardChanges')}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
                  >
                    {saving ? t('common:states.saving') : t('common:actions.save')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
