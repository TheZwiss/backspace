import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemberWithUser } from '@backspace/shared';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { usePermissionNames } from '../ui/OverrideEntry';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, getApiForOrigin } from '../../stores/spaceStore';
import { PermissionBits, stringToPermissions, permissionsToString } from '../../utils/permissions';
import { PERMISSION_GROUPS, type PermissionGroupId } from '../../utils/permissionGroups';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { describeError } from '../../i18n/errors';

/** True when both sets contain exactly the same ids. */
function sameIds(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * TeamSpeak-style role editor for one member, opened from the member list
 * (MemberSidebar) with `{ spaceId, userId }`. Left pane: every role of the
 * space with its membership checkbox plus the space's @everyone row. Right
 * pane: the permissions behind whichever role is selected — the same editor
 * the roles tab offers, so a moderator can fix both "who has this role" and
 * "what the role grants" without leaving the member.
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
      mobileStyle="fullscreen"
    >
      <MemberRolesEditor spaceId={spaceId} userId={userId} onClose={closeModal} />
    </Modal>
  );
}

/** Resolves the live member record; nothing renders once the member is gone. */
function MemberRolesEditor({ spaceId, userId, onClose }: { spaceId: string; userId: string; onClose: () => void }) {
  const member = useSpaceStore((s) => s.members.find((m) => m.userId === userId));
  if (!member) return null;
  return <MemberRolesBody spaceId={spaceId} userId={userId} member={member} onClose={onClose} />;
}

function MemberRolesBody({
  spaceId,
  userId,
  member,
  onClose,
}: {
  spaceId: string;
  userId: string;
  member: MemberWithUser;
  onClose: () => void;
}) {
  const { t } = useTranslation(['spaces', 'common']);
  const roles = useSpaceStore((s) => s.roles);
  const space = useSpaceStore((s) => s.spaces.find((x) => x.id === spaceId));
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);
  const addToast = useUIStore((s) => s.addToast);
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const permissionNames = usePermissionNames();
  const canonical = useCanonicalUserView(member.user);
  const displayName = canonical.displayName ?? canonical.username;

  const spaceApi = getApiForOrigin(space?._instanceOrigin ?? '');

  // Same ordering as the roles tab: by position desc, @everyone always last.
  const sortedRoles = [...roles].sort((a, b) => {
    const aIsEveryone = a.id === spaceId;
    const bIsEveryone = b.id === spaceId;
    if (aIsEveryone) return 1;
    if (bIsEveryone) return -1;
    return b.position - a.position;
  });

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [permDrafts, setPermDrafts] = useState<Map<string, bigint>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // The membership the member had when the modal opened. Drafts are compared
  // against it so the save bar only appears when something actually changed;
  // @everyone (id === spaceId) is implicit and never part of the set.
  const [initialRoleIds, setInitialRoleIds] = useState<Set<string>>(
    () => new Set((member.roles ?? []).map((r) => r.id).filter((id) => id !== spaceId))
  );
  const [draftRoleIds, setDraftRoleIds] = useState<Set<string>>(initialRoleIds);

  const selectedRole = selectedRoleId ? roles.find((r) => r.id === selectedRoleId) ?? null : null;
  const selectedPermissions = selectedRole
    ? permDrafts.get(selectedRole.id) ?? stringToPermissions(selectedRole.permissions)
    : 0n;

  const membershipChanged = !sameIds(draftRoleIds, initialRoleIds);
  const dirtyRoles = roles.filter((role) => {
    const draft = permDrafts.get(role.id);
    return draft !== undefined && permissionsToString(draft) !== (role.permissions ?? '0');
  });
  const hasChanges = membershipChanged || dirtyRoles.length > 0;

  const toggleMembership = (roleId: string) => {
    setDraftRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const togglePermission = (bit: bigint) => {
    if (!selectedRole) return;
    const next = (selectedPermissions & bit) !== 0n ? selectedPermissions & ~bit : selectedPermissions | bit;
    setPermDrafts((prev) => new Map(prev).set(selectedRole.id, next));
  };

  const handleDiscard = () => {
    setDraftRoleIds(new Set(initialRoleIds));
    setPermDrafts(new Map());
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (membershipChanged) {
        await spaceApi.spaces.updateMember(spaceId, userId, { roleIds: Array.from(draftRoleIds) });
        // What the server now holds becomes the new baseline.
        setInitialRoleIds(new Set(draftRoleIds));
      }
      for (const role of dirtyRoles) {
        const draft = permDrafts.get(role.id);
        if (draft === undefined) continue;
        await spaceApi.roles.update(spaceId, role.id, { permissions: permissionsToString(draft) });
      }
      setPermDrafts(new Map());
      await loadSpaceDetail(spaceId);
      addToast(t('spaces:memberRoles.saved'), 'success', 2000);
    } catch (err) {
      setError(describeError(err));
      // A partial save (member updated, a role write failed) must show what
      // actually landed, so re-read instead of trusting the drafts.
      try {
        await loadSpaceDetail(spaceId);
      } catch {
        // Keep the original error on screen; the refresh failing is not news.
      }
    } finally {
      setSaving(false);
    }
  };

  const handleViewProfile = (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget.getBoundingClientRect();
    onClose();
    openUserProfile(canonical, anchor, 'right');
  };

  const groupTitle = (id: PermissionGroupId): string => {
    switch (id) {
      case 'general': return t('spaces:roles.groups.general');
      case 'text': return t('spaces:roles.groups.text');
      case 'voice': return t('spaces:roles.groups.voice');
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header — who is being edited, plus the way back to the profile card */}
      <div className="flex items-center gap-3 px-6 py-4 pr-16 border-b border-white/[0.06] flex-shrink-0">
        <Avatar
          src={canonical.avatar}
          name={displayName}
          size={40}
          status={canonical.status}
          user={canonical}
        />
        <h2 className="flex-1 min-w-0 text-lg font-semibold text-txt-primary truncate">
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
        {/* Left pane — membership checkboxes; clicking a row edits that role */}
        <div className="w-72 flex-shrink-0 border-r border-white/[0.06] overflow-y-auto scrollbar-thin p-4">
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            {t('spaces:roles.listHeading')}
          </div>
          <div className="rounded-lg bg-white/[0.02] p-2">
            <div className="space-y-0.5">
              {sortedRoles.map((role) => {
                const isEveryone = role.id === spaceId;
                const selected = selectedRoleId === role.id;
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
                      checked={isEveryone || draftRoleIds.has(role.id)}
                      disabled={isEveryone}
                      onChange={() => toggleMembership(role.id)}
                      className="w-3.5 h-3.5 rounded border-txt-tertiary accent-accent-primary flex-shrink-0"
                    />
                    <div
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: role.color }}
                    />
                    <span className="text-sm text-txt-primary truncate">
                      {/* i18n-check: allow-literal — @everyone is the role's identifier, not a phrase */}
                      {isEveryone ? '@everyone' : role.name}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right pane — permissions of the role selected on the left */}
        <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin p-6">
          {selectedRole ? (
            <>
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: selectedRole.color }}
                />
                <h3 className="text-base font-semibold text-txt-primary truncate">
                  {/* i18n-check: allow-literal — @everyone is the role's identifier, not a phrase */}
                  {selectedRole.id === spaceId ? '@everyone' : selectedRole.name}
                </h3>
              </div>
              <p className="text-xs text-txt-tertiary mt-1 mb-5">{t('spaces:memberRoles.affectsAll')}</p>

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
                        return (
                          <label
                            key={perm.key}
                            className={`flex items-center justify-between py-1.5 px-2 rounded cursor-pointer group/perm ${
                              isInherited ? 'opacity-50 cursor-default' : 'hover:bg-interactive-hover'
                            }`}
                          >
                            <span className={`text-sm ${isAdminBit ? 'text-txt-danger font-medium' : 'text-txt-primary'}`}>
                              {permissionNames[perm.key]}
                            </span>
                            <div
                              onClick={(e) => {
                                e.preventDefault();
                                if (!isInherited) togglePermission(perm.bit);
                              }}
                              className={`relative w-9 h-5 rounded-full transition-colors ${
                                isInherited ? 'cursor-default' : 'cursor-pointer'
                              } ${isOn ? 'bg-accent-primary' : 'bg-interactive-muted'}`}
                            >
                              <div
                                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                                  isOn ? 'translate-x-4' : 'translate-x-0.5'
                                }`}
                              />
                            </div>
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
        </div>
      </div>

      {/* Footer — save bar */}
      <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-white/[0.06] flex-shrink-0">
        {error && (
          <div className="mr-auto min-w-0 text-sm text-txt-danger truncate">{error}</div>
        )}
        {hasChanges && (
          <>
            <button
              onClick={handleDiscard}
              className="px-3 py-1.5 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              {t('spaces:settings.discardChanges')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
            >
              {saving ? t('common:states.saving') : t('common:actions.save')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
