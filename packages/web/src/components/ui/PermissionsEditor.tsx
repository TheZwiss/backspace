import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSpaceStore } from '../../stores/spaceStore';
import { permissionsToString, stringToPermissions } from '../../utils/permissions';
import { OverrideEntry, type PermissionDef } from './OverrideEntry';
import type { Role, MemberWithUser } from '@backspace/shared';

export interface Override {
  targetType: string;
  targetId: string;
  allow: string;
  deny: string;
}

export interface PermissionsEditorProps {
  entityId: string;
  spaceId: string;
  instanceOrigin?: string;
  permDefs: PermissionDef[];
  getOverrides: () => Promise<Override[]>;
  putOverride: (data: { targetType: string; targetId: string; allow: string; deny: string }) => Promise<unknown>;
  deleteOverride: (targetType: string, targetId: string) => Promise<unknown>;
}

export function PermissionsEditor({
  entityId,
  spaceId,
  instanceOrigin,
  permDefs,
  getOverrides,
  putOverride,
  deleteOverride,
}: PermissionsEditorProps) {
  const roles = useSpaceStore((s) => s.roles);
  const members = useSpaceStore((s) => s.members);

  // Fetched overrides
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [fetchError, setFetchError] = useState('');

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

  // Stable ref for the getOverrides callback to avoid re-fetch loops
  const getOverridesRef = useRef(getOverrides);
  getOverridesRef.current = getOverrides;

  // Fetch overrides on mount and when entityId changes
  const fetchOverrides = useCallback(() => {
    setFetchError('');
    getOverridesRef.current()
      .then((data: Override[]) => {
        setOverrides(data);
      })
      .catch((err: Error) => {
        setFetchError(err.message || 'Failed to load overrides');
      });
  }, []);

  useEffect(() => {
    fetchOverrides();
  }, [entityId, fetchOverrides]);

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

  // Roles that already have overrides
  const existingRoleIds = useMemo(() => {
    const set = new Set<string>();
    for (const o of overrides) {
      if (o.targetType === 'role') set.add(o.targetId);
    }
    for (const [key] of newOverrides) {
      if (key.startsWith('role:')) set.add(key.slice(5));
    }
    return set;
  }, [overrides, newOverrides]);

  // Members that already have overrides
  const existingMemberIds = useMemo(() => {
    const set = new Set<string>();
    for (const o of overrides) {
      if (o.targetType === 'member') set.add(o.targetId);
    }
    for (const [key] of newOverrides) {
      if (key.startsWith('member:')) set.add(key.slice(7));
    }
    return set;
  }, [overrides, newOverrides]);

  // Available roles to add (not already in overrides)
  const availableRoles = useMemo(() =>
    roles.filter(r => !existingRoleIds.has(r.id) && !pendingRemovals.has(`role:${r.id}`)),
    [roles, existingRoleIds, pendingRemovals]);

  // Available members to add (not already in overrides), filtered by search
  const availableMembers = useMemo(() => {
    const filtered = members.filter(m =>
      !existingMemberIds.has(m.userId) &&
      !pendingRemovals.has(`member:${m.userId}`)
    );
    if (!memberSearch.trim()) return filtered.slice(0, 20);
    const q = memberSearch.toLowerCase();
    return filtered.filter(m =>
      m.user.username.toLowerCase().includes(q) ||
      (m.user.displayName?.toLowerCase().includes(q))
    ).slice(0, 20);
  }, [members, existingMemberIds, pendingRemovals, memberSearch]);

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
  }, [newOverrides]);

  // Remove handler
  const handleRemove = useCallback((key: string) => {
    if (newOverrides.has(key)) {
      setNewOverrides(prev => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    } else {
      setPendingRemovals(prev => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      // Remove from drafts too
      setDraftOverrides(prev => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    }
  }, [newOverrides]);

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
        setSaveError(first.reason?.message || `${failures.length} override(s) failed to save`);
      }

      // Reset draft state and re-fetch overrides
      setDraftOverrides(new Map());
      setNewOverrides(new Map());
      setPendingRemovals(new Set());
      fetchOverrides();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save overrides');
    } finally {
      setSaving(false);
    }
  }, [draftOverrides, newOverrides, pendingRemovals, deleteOverride, putOverride, fetchOverrides]);

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

    // Sort: @everyone first, then by position
    items.sort((a, b) => {
      if (a.role.id === spaceId) return -1;
      if (b.role.id === spaceId) return 1;
      return (a.role.position ?? 0) - (b.role.position ?? 0);
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

  return (
    <div className="space-y-4 relative pb-14">
      {/* Fetch error */}
      {fetchError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {fetchError}
        </div>
      )}

      {/* Role Overrides */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">
          Role Overrides
        </div>
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
                isEveryone={role.id === spaceId}
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
              Add Role
            </button>
          ) : (
            <div ref={roleDropdownRef} className="glass rounded-lg overflow-hidden">
              <div className="p-1.5 max-h-48 overflow-y-auto scrollbar-thin">
                {availableRoles.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-xs text-txt-muted">No more roles to add</div>
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
                  className="w-full text-xs text-txt-muted hover:text-txt-tertiary px-2.5 py-1 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Member Overrides */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-2">
          Member Overrides
        </div>
        <div className="space-y-1.5">
          {memberOverrides.map(({ key, member }) => {
            const eff = getEffective(key);
            return (
              <OverrideEntry
                key={key}
                label={member.user.displayName ?? member.user.username}
                permDefs={permDefs}
                allow={eff.allow}
                deny={eff.deny}
                onChange={(a, d) => handleChange(key, a, d)}
                onRemove={() => handleRemove(key)}
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
              Add Member
            </button>
          ) : (
            <div ref={memberDropdownRef} className="glass rounded-lg overflow-hidden">
              <div className="p-1.5">
                <input
                  type="text"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="Search members..."
                  className="input-search w-full mb-1"
                  autoFocus
                />
              </div>
              <div className="px-1.5 max-h-48 overflow-y-auto scrollbar-thin">
                {availableMembers.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-xs text-txt-muted">No members found</div>
                ) : (
                  availableMembers.map(member => (
                    <button
                      key={member.userId}
                      onClick={() => handleAddMember(member.userId)}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-txt-secondary hover:text-txt-primary hover:bg-interactive-hover rounded transition-colors"
                    >
                      <span className="truncate">{member.user.displayName ?? member.user.username}</span>
                      {member.user.displayName && (
                        <span className="text-txt-muted text-xs truncate">@{member.user.username}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
              <div className="border-t border-white/[0.04] p-1.5">
                <button
                  onClick={() => { setShowAddMember(false); setMemberSearch(''); }}
                  className="w-full text-xs text-txt-muted hover:text-txt-tertiary px-2.5 py-1 transition-colors"
                >
                  Cancel
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

      {/* Save/Discard pill */}
      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 pointer-events-auto animate-slide-up">
              <button
                onClick={handleDiscard}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                Discard
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
