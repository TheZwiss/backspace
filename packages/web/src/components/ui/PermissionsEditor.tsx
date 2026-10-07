import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpaceStore } from '../../stores/spaceStore';
import { PermissionBits, permissionsToString, stringToPermissions } from '../../utils/permissions';
import { OverrideEntry, type PermissionDef } from './OverrideEntry';
import { LOCK_ICON } from './LockNote';
import { describeError } from '../../i18n/errors';
import { userDisplayName } from '../../utils/identity';
import { isHiddenFromEveryone, type StoredOverride } from '../../utils/overrideBits';
import {
  useViewerHeldPermissions,
  unswitchableBits,
  viewerCanRemoveOverride,
  viewerCanManageRoleAt,
  viewerCanActOn,
} from '../../utils/roleHierarchy';
import type { Role, MemberWithUser } from '@backspace/shared';

export type Override = StoredOverride;

export interface PermissionsEditorProps {
  entityId: string;
  spaceId: string;
  permDefs: PermissionDef[];
  /**
   * The saved overrides. The dialog owns the list (`useEntityOverrides`) so
   * every tab reads the same one; this editor stages changes on top of it.
   */
  overrides: Override[];
  /** Why the list could not be loaded; empty when it could. */
  loadError?: string;
  putOverride: (data: Override) => Promise<unknown>;
  deleteOverride: (targetType: string, targetId: string) => Promise<unknown>;
  /** Called after a save, landed or partly refused, so the owner lists the overrides again. */
  onSaved: () => Promise<void> | void;
  /** Shown above Save while the staged edit would stop hiding this channel or category from @everyone. */
  unhideNote: string;
}

export function PermissionsEditor({
  entityId,
  spaceId,
  permDefs,
  overrides,
  loadError = '',
  putOverride,
  deleteOverride,
  onSaved,
  unhideNote,
}: PermissionsEditorProps) {
  const { t } = useTranslation(['spaces', 'common']);
  const roles = useSpaceStore((s) => s.roles);
  const members = useSpaceStore((s) => s.members);
  // Held-bits rule (permissions.md): the viewer can only switch bits they
  // hold, and only remove a saved override whose bits are all ones they hold.
  const held = useViewerHeldPermissions(spaceId);
  const lockedBits = useMemo(() => unswitchableBits(held, permDefs.map((p) => p.bit)), [held, permDefs]);
  // Role hierarchy (permissions.md): an override on a role or member at or
  // above the viewer is theirs to look at, not to change.
  const space = useSpaceStore((s) => s.spaces.find((sp) => sp.id === spaceId));
  const isAboveViewer = useCallback((key: string): boolean => {
    if (!space) return false;
    const [targetType, targetId] = key.split(':');
    if (targetType === 'role') {
      const role = roles.find((r) => r.id === targetId);
      return !!role && !viewerCanManageRoleAt(space, members, role.position);
    }
    const member = members.find((m) => m.userId === targetId);
    return !!member && !viewerCanActOn(space, members, member);
  }, [space, roles, members]);

  // Draft state: keyed by "role:id" or "member:id"
  const [draftOverrides, setDraftOverrides] = useState<Map<string, { allow: bigint; deny: bigint }>>(new Map());
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
  const [newOverrides, setNewOverrides] = useState<Map<string, { targetType: string; targetId: string; allow: bigint; deny: bigint }>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Add role/member dropdown state
  const [showAddRole, setShowAddRole] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');

  // Refs + click-outside/Escape for dropdown menus
  const roleDropdownRef = useRef<HTMLDivElement>(null);
  const memberDropdownRef = useRef<HTMLDivElement>(null);

  // Reset draft state when entityId changes
  useEffect(() => {
    setDraftOverrides(new Map());
    setNewOverrides(new Map());
    setPendingRemovals(new Set());
    setSaveError('');
  }, [entityId]);

  useEffect(() => {
    if (!showAddRole) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (roleDropdownRef.current && !roleDropdownRef.current.contains(e.target as Node)) {
        setShowAddRole(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAddRole(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showAddRole]);

  useEffect(() => {
    if (!showAddMember) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (memberDropdownRef.current && !memberDropdownRef.current.contains(e.target as Node)) {
        setShowAddMember(false);
        setMemberSearch('');
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAddMember(false);
        setMemberSearch('');
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showAddMember]);

  // Build map of existing overrides keyed by "role:id" or "member:id"
  const existingOverrideMap = useMemo(() => {
    const map = new Map<string, Override>();
    for (const o of overrides) {
      map.set(`${o.targetType}:${o.targetId}`, o);
    }
    return map;
  }, [overrides]);

  // A row staged in this edit can always be dropped; a saved one is deleted
  // on the server, which clears every bit it sets.
  const isRemoveLocked = useCallback((key: string): boolean => {
    if (isAboveViewer(key)) return true;
    const saved = existingOverrideMap.get(key);
    if (!saved) return false;
    return !viewerCanRemoveOverride(held, { allow: stringToPermissions(saved.allow), deny: stringToPermissions(saved.deny) });
  }, [existingOverrideMap, held, isAboveViewer]);

  // Get effective allow/deny for a key — considers drafts, new overrides, and originals
  const getEffective = useCallback((key: string): { allow: bigint; deny: bigint } => {
    if (newOverrides.has(key)) {
      const n = newOverrides.get(key)!;
      return { allow: n.allow, deny: n.deny };
    }
    if (draftOverrides.has(key)) return draftOverrides.get(key)!;
    const orig = existingOverrideMap.get(key);
    if (orig) return { allow: stringToPermissions(orig.allow), deny: stringToPermissions(orig.deny) };
    return { allow: 0n, deny: 0n };
  }, [draftOverrides, newOverrides, existingOverrideMap]);

  // Update handler for an override entry
  const handleChange = useCallback((key: string, allow: bigint, deny: bigint) => {
    if (isAboveViewer(key)) return;
    if (newOverrides.has(key)) {
      setNewOverrides(prev => {
        const next = new Map(prev);
        const entry = next.get(key)!;
        next.set(key, { ...entry, allow, deny });
        return next;
      });
    } else {
      setDraftOverrides(prev => {
        const next = new Map(prev);
        next.set(key, { allow, deny });
        return next;
      });
    }
  }, [newOverrides, isAboveViewer]);

  // Remove handler. Whatever the row held in this edit (a staged addition or
  // edited bits) is dropped, and a row the server already stores is marked for
  // deletion, so removing works the same after a remove-and-re-add.
  const handleRemove = useCallback((key: string) => {
    if (isRemoveLocked(key)) return;
    setNewOverrides(prev => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    setDraftOverrides(prev => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    if (existingOverrideMap.has(key)) {
      setPendingRemovals(prev => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    }
  }, [existingOverrideMap, isRemoveLocked]);

  // Add role override
  const handleAddRole = useCallback((roleId: string) => {
    const key = `role:${roleId}`;
    setNewOverrides(prev => {
      const next = new Map(prev);
      next.set(key, { targetType: 'role', targetId: roleId, allow: 0n, deny: 0n });
      return next;
    });
    // If it was pending removal, unmark it
    setPendingRemovals(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setShowAddRole(false);
  }, []);

  // Add member override
  const handleAddMember = useCallback((userId: string) => {
    const key = `member:${userId}`;
    setNewOverrides(prev => {
      const next = new Map(prev);
      next.set(key, { targetType: 'member', targetId: userId, allow: 0n, deny: 0n });
      return next;
    });
    setPendingRemovals(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setShowAddMember(false);
    setMemberSearch('');
  }, []);

  const hasChanges = draftOverrides.size > 0 || newOverrides.size > 0 || pendingRemovals.size > 0;

  const handleDiscard = useCallback(() => {
    setDraftOverrides(new Map());
    setNewOverrides(new Map());
    setPendingRemovals(new Set());
    setSaveError('');
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError('');

    try {
      const promises: Promise<unknown>[] = [];

      // Delete removed overrides
      for (const key of pendingRemovals) {
        const parts = key.split(':');
        promises.push(deleteOverride(parts[0]!, parts[1]!));
      }

      // Update modified existing overrides
      for (const [key, { allow, deny }] of draftOverrides) {
        if (pendingRemovals.has(key)) continue;
        const parts = key.split(':');
        promises.push(putOverride({
          targetType: parts[0]!,
          targetId: parts[1]!,
          allow: permissionsToString(allow),
          deny: permissionsToString(deny),
        }));
      }

      // Create new overrides
      for (const [, { targetType, targetId, allow, deny }] of newOverrides) {
        promises.push(putOverride({
          targetType,
          targetId,
          allow: permissionsToString(allow),
          deny: permissionsToString(deny),
        }));
      }

      const results = await Promise.allSettled(promises);
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        const first = failures[0] as PromiseRejectedResult;
        setSaveError(
          first.reason instanceof Error
            ? describeError(first.reason)
            : t('spaces:permissions.partialFailure', { count: failures.length }),
        );
      }

      // Reset draft state; the owner lists the overrides again
      setDraftOverrides(new Map());
      setNewOverrides(new Map());
      setPendingRemovals(new Set());
      await onSaved();
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  }, [draftOverrides, newOverrides, pendingRemovals, deleteOverride, putOverride, onSaved, t]);

  // Build ordered lists of role and member overrides
  const roleOverrides = useMemo(() => {
    const items: { key: string; role: Role; isNew: boolean }[] = [];

    // Existing overrides (excluding pending removals)
    for (const o of overrides) {
      if (o.targetType !== 'role') continue;
      const key = `role:${o.targetId}`;
      if (pendingRemovals.has(key)) continue;
      const role = roles.find(r => r.id === o.targetId);
      if (!role) continue;
      items.push({ key, role, isNew: false });
    }

    // New overrides
    for (const [key, entry] of newOverrides) {
      if (!key.startsWith('role:')) continue;
      const role = roles.find(r => r.id === entry.targetId);
      if (!role) continue;
      if (items.some(i => i.key === key)) continue;
      items.push({ key, role, isNew: true });
    }

    // Rank order, as the Roles list shows it: highest first, @everyone last.
    items.sort((a, b) => {
      if (a.role.id === spaceId) return 1;
      if (b.role.id === spaceId) return -1;
      return (b.role.position ?? 0) - (a.role.position ?? 0);
    });

    return items;
  }, [overrides, newOverrides, pendingRemovals, roles, spaceId]);

  const memberOverrides = useMemo(() => {
    const items: { key: string; member: MemberWithUser; isNew: boolean }[] = [];

    for (const o of overrides) {
      if (o.targetType !== 'member') continue;
      const key = `member:${o.targetId}`;
      if (pendingRemovals.has(key)) continue;
      const member = members.find(m => m.userId === o.targetId);
      if (!member) continue;
      items.push({ key, member, isNew: false });
    }

    for (const [key, entry] of newOverrides) {
      if (!key.startsWith('member:')) continue;
      const member = members.find(m => m.userId === entry.targetId);
      if (!member) continue;
      if (items.some(i => i.key === key)) continue;
      items.push({ key, member, isNew: true });
    }

    return items;
  }, [overrides, newOverrides, pendingRemovals, members]);

  // The add pickers offer exactly what has no row right now. They read the
  // same staged rows the lists above render, so a staged removal puts its
  // target back in the picker at once and a staged addition takes it out.
  const stagedKeys = useMemo(() => new Set([
    ...roleOverrides.map((item) => item.key),
    ...memberOverrides.map((item) => item.key),
  ]), [roleOverrides, memberOverrides]);

  // Privacy is @everyone's VIEW_CHANNEL deny. Saving unhides the entity when
  // the saved @everyone row denies it and the staged rows, read the way they
  // render, no longer do: the row is staged for removal, or the bit cleared.
  const everyoneKey = `role:${spaceId}`;
  const unhides = useMemo(() => {
    if (!isHiddenFromEveryone(overrides, spaceId)) return false;
    const stagedHides = stagedKeys.has(everyoneKey)
      && (getEffective(everyoneKey).deny & PermissionBits.VIEW_CHANNEL) !== 0n;
    return !stagedHides;
  }, [overrides, spaceId, everyoneKey, stagedKeys, getEffective]);

  const availableRoles = useMemo(() =>
    roles.filter(r => !stagedKeys.has(`role:${r.id}`) && !isAboveViewer(`role:${r.id}`)),
    [roles, stagedKeys, isAboveViewer]);

  // Filtered by the search box, capped at 20 rows.
  const availableMembers = useMemo(() => {
    const filtered = members.filter(m => !stagedKeys.has(`member:${m.userId}`) && !isAboveViewer(`member:${m.userId}`));
    if (!memberSearch.trim()) return filtered.slice(0, 20);
    const q = memberSearch.toLowerCase();
    return filtered.filter(m =>
      m.user.username.toLowerCase().includes(q) ||
      (m.user.displayName?.toLowerCase().includes(q))
    ).slice(0, 20);
  }, [members, stagedKeys, memberSearch, isAboveViewer]);

  const savePill = (
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
  );

  return (
    <div className="space-y-4 relative pb-14">
      {/* Load error */}
      {loadError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {loadError}
        </div>
      )}

      {/* Role Overrides */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">
          {t('spaces:permissions.roleOverrides')}
        </div>
        {roleOverrides.length === 0 && (
          <p className="text-[12.5px] text-txt-tertiary">{t('spaces:permissions.noRoleOverrides')}</p>
        )}
        <div className="space-y-1.5">
          {roleOverrides.map(({ key, role }) => {
            const eff = getEffective(key);
            return (
              <OverrideEntry
                key={key}
                label={role.name}
                color={role.color}
                permDefs={permDefs}
                allow={eff.allow}
                deny={eff.deny}
                onChange={(a, d) => handleChange(key, a, d)}
                onRemove={() => handleRemove(key)}
                lockedBits={lockedBits}
                removeLocked={isRemoveLocked(key)}
                readOnlyNote={isAboveViewer(key) ? t('spaces:permissions.aboveYouRole') : undefined}
              />
            );
          })}
        </div>

        {/* Add Role */}
        <div className="mt-2 relative">
          {!showAddRole ? (
            <button
              onClick={() => setShowAddRole(true)}
              className="flex items-center gap-1.5 text-[13px] text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
              </svg>
              {t('spaces:permissions.addRole')}
            </button>
          ) : (
            <div ref={roleDropdownRef} className="glass rounded-lg overflow-hidden">
              <div className="p-1.5 max-h-48 overflow-y-auto scrollbar-thin">
                {availableRoles.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-xs text-txt-tertiary">{t('spaces:permissions.noMoreRoles')}</div>
                ) : (
                  availableRoles.map(role => (
                    <button
                      key={role.id}
                      onClick={() => handleAddRole(role.id)}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-txt-secondary hover:text-txt-primary hover:bg-interactive-hover rounded transition-colors"
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: role.color || '#b9bbbe' }}
                      />
                      {role.name}
                    </button>
                  ))
                )}
              </div>
              <div className="border-t border-white/[0.04] p-1.5">
                <button
                  onClick={() => setShowAddRole(false)}
                  className="w-full text-xs text-txt-tertiary hover:text-txt-secondary px-2.5 py-1 transition-colors"
                >
                  {t('common:actions.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Member Overrides */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">
          {t('spaces:permissions.memberOverrides')}
        </div>
        {memberOverrides.length === 0 && (
          <p className="text-[12.5px] text-txt-tertiary">{t('spaces:permissions.noMemberOverrides')}</p>
        )}
        <div className="space-y-1.5">
          {memberOverrides.map(({ key, member }) => {
            const eff = getEffective(key);
            return (
              <OverrideEntry
                key={key}
                label={userDisplayName(member.user)}
                permDefs={permDefs}
                allow={eff.allow}
                deny={eff.deny}
                onChange={(a, d) => handleChange(key, a, d)}
                onRemove={() => handleRemove(key)}
                lockedBits={lockedBits}
                removeLocked={isRemoveLocked(key)}
                readOnlyNote={isAboveViewer(key) ? t('spaces:permissions.aboveYouMember') : undefined}
              />
            );
          })}
        </div>

        {/* Add Member */}
        <div className="mt-2 relative">
          {!showAddMember ? (
            <button
              onClick={() => setShowAddMember(true)}
              className="flex items-center gap-1.5 text-[13px] text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
              </svg>
              {t('spaces:permissions.addMember')}
            </button>
          ) : (
            <div ref={memberDropdownRef} className="glass rounded-lg overflow-hidden">
              <div className="p-1.5">
                <input
                  type="text"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder={t('common:labels.searchMembers')}
                  className="input-search w-full mb-1"
                  autoFocus
                />
              </div>
              <div className="px-1.5 max-h-48 overflow-y-auto scrollbar-thin">
                {availableMembers.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-xs text-txt-tertiary">{t('common:labels.noMembersFound')}</div>
                ) : (
                  availableMembers.map(member => (
                    <button
                      key={member.userId}
                      onClick={() => handleAddMember(member.userId)}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-txt-secondary hover:text-txt-primary hover:bg-interactive-hover rounded transition-colors"
                    >
                      <span className="truncate">{userDisplayName(member.user)}</span>
                      {member.user.displayName && (
                        <span className="text-txt-tertiary text-xs truncate">@{member.user.username}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
              <div className="border-t border-white/[0.04] p-1.5">
                <button
                  onClick={() => { setShowAddMember(false); setMemberSearch(''); }}
                  className="w-full text-xs text-txt-tertiary hover:text-txt-secondary px-2.5 py-1 transition-colors"
                >
                  {t('common:actions.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {saveError}
        </div>
      )}

      {/* Save/Discard pill, with the unhide note above it when a save would
          make this channel or category visible to everyone. */}
      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          {unhides ? (
            // Note and pill float over the scrolling rows as one glass group
            // (design-system.md, "Nested glass").
            <div className="glass-bubble rounded-lg mt-3 mb-1 p-2 space-y-2 pointer-events-auto">
              {/* Laid out like the Overview privacy note. */}
              <div className="flex items-start gap-2 text-xs text-txt-tertiary">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="flex-shrink-0 mt-0.5 text-txt-secondary">
                  <path d={LOCK_ICON} />
                </svg>
                <span>{unhideNote}</span>
              </div>
              <div className="flex justify-center">{savePill}</div>
            </div>
          ) : (
            <div className="flex justify-center pt-3 pb-1">{savePill}</div>
          )}
        </div>
      )}
    </div>
  );
}
