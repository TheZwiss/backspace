import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, getApiForOrigin } from '../../stores/spaceStore';
import { api } from '../../api/client';
import { PermissionBits, permissionsToString, stringToPermissions, hasPermissionBit } from '../../utils/permissions';
import { Toggle } from '../ui/Toggle';
import type { Role, MemberWithUser } from '@backspace/shared';

interface ChannelOverride {
  channelId: string;
  targetType: string;
  targetId: string;
  allow: string;
  deny: string;
}

// ─── Permission Definitions for Channel Overrides ──────────────────────────────

interface PermissionDef {
  key: keyof typeof PermissionBits;
  label: string;
  bit: bigint;
}

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

// ─── Tri-State Toggle ──────────────────────────────────────────────────────────

type TriState = 'allow' | 'neutral' | 'deny';

function TriStateToggle({
  value,
  onChange,
  disabled,
}: {
  value: TriState;
  onChange: (v: TriState) => void;
  disabled?: boolean;
}) {
  const btnClass = (v: TriState, active: boolean) => {
    const base = 'w-6 h-6 flex items-center justify-center rounded-full transition-colors text-xs font-bold';
    if (disabled) return `${base} cursor-not-allowed opacity-40`;
    if (!active) return `${base} cursor-pointer text-txt-muted hover:text-txt-tertiary`;
    switch (v) {
      case 'deny': return `${base} cursor-pointer bg-accent-rose/15 text-accent-rose`;
      case 'neutral': return `${base} cursor-pointer bg-white/[0.06] text-txt-tertiary`;
      case 'allow': return `${base} cursor-pointer bg-accent-primary/15 text-accent-primary`;
    }
  };

  return (
    <div className="flex items-center gap-0.5 bg-surface-input rounded-full p-0.5">
      <button
        className={btnClass('deny', value === 'deny')}
        onClick={() => !disabled && onChange(value === 'deny' ? 'neutral' : 'deny')}
        title="Deny"
      >
        ✕
      </button>
      <button
        className={btnClass('neutral', value === 'neutral')}
        onClick={() => !disabled && onChange('neutral')}
        title="Neutral (inherit)"
      >
        /
      </button>
      <button
        className={btnClass('allow', value === 'allow')}
        onClick={() => !disabled && onChange(value === 'allow' ? 'neutral' : 'allow')}
        title="Allow"
      >
        ✓
      </button>
    </div>
  );
}

// ─── Override Entry (expandable row) ────────────────────────────────────────────

function OverrideEntry({
  label,
  color,
  permDefs,
  allow,
  deny,
  onChange,
  onRemove,
  isEveryone,
}: {
  label: string;
  color?: string;
  permDefs: PermissionDef[];
  allow: bigint;
  deny: bigint;
  onChange: (allow: bigint, deny: bigint) => void;
  onRemove?: () => void;
  isEveryone?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const getState = (bit: bigint): TriState => {
    if ((allow & bit) !== 0n) return 'allow';
    if ((deny & bit) !== 0n) return 'deny';
    return 'neutral';
  };

  const setState = (bit: bigint, state: TriState) => {
    let newAllow = allow & ~bit;
    let newDeny = deny & ~bit;
    if (state === 'allow') newAllow |= bit;
    if (state === 'deny') newDeny |= bit;
    onChange(newAllow, newDeny);
  };

  // Compact summary of non-neutral permissions
  const summary = permDefs.filter(p => getState(p.bit) !== 'neutral');

  return (
    <div className="rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-interactive-hover transition-colors"
      >
        <span
          className="w-3 h-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: color || '#b9bbbe' }}
        />
        <span className="text-sm font-medium text-txt-primary flex-1 text-left truncate">{label}</span>
        {!expanded && summary.length > 0 && (
          <span className="text-[11px] text-txt-tertiary flex-shrink-0">
            {summary.length} override{summary.length !== 1 ? 's' : ''}
          </span>
        )}
        {onRemove && !isEveryone && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="p-0.5 text-txt-muted hover:text-accent-rose transition-colors"
            title="Remove override"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
          className={`text-txt-muted transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5 border-t border-white/[0.04] pt-2">
          {permDefs.map((perm) => (
            <div key={perm.key} className="flex items-center justify-between">
              <span className="text-[13px] text-txt-secondary">{perm.label}</span>
              <TriStateToggle
                value={getState(perm.bit)}
                onChange={(v) => setState(perm.bit, v)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Permissions Tab ────────────────────────────────────────────────────────────

function PermissionsTab({
  channelId,
  channelType,
  spaceId,
  overrides,
  onOverridesChange,
}: {
  channelId: string;
  channelType: 'text' | 'voice';
  spaceId: string;
  overrides: ChannelOverride[];
  onOverridesChange: () => void;
}) {
  const spaces = useSpaceStore((s) => s.spaces);
  const space = spaces.find(s => s.id === spaceId);
  const roles = useSpaceStore((s) => s.roles);
  const members = useSpaceStore((s) => s.members);

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

  const permDefs = channelType === 'voice' ? VOICE_CHANNEL_PERMISSIONS : TEXT_CHANNEL_PERMISSIONS;

  // Build map of existing overrides keyed by "role:id" or "member:id"
  const existingOverrideMap = useMemo(() => {
    const map = new Map<string, ChannelOverride>();
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

    const channelApi = getApiForOrigin(space?._instanceOrigin ?? '');

    try {
      const promises: Promise<any>[] = [];

      // Delete removed overrides
      for (const key of pendingRemovals) {
        const parts = key.split(':');
        promises.push(channelApi.channels.deleteOverride(channelId, parts[0]!, parts[1]!));
      }

      // Update modified existing overrides
      for (const [key, { allow, deny }] of draftOverrides) {
        if (pendingRemovals.has(key)) continue;
        const parts = key.split(':');
        promises.push(channelApi.channels.putOverride(channelId, {
          targetType: parts[0]!,
          targetId: parts[1]!,
          allow: permissionsToString(allow),
          deny: permissionsToString(deny),
        }));
      }

      // Create new overrides
      for (const [, { targetType, targetId, allow, deny }] of newOverrides) {
        promises.push(channelApi.channels.putOverride(channelId, {
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
      onOverridesChange();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save overrides');
    } finally {
      setSaving(false);
    }
  }, [channelId, draftOverrides, newOverrides, pendingRemovals, space, onOverridesChange]);

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
  const [overrides, setOverrides] = useState<ChannelOverride[]>([]);

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
      setOverrides([]);
    }
  }, [isOpen]);

  // Fetch overrides when modal opens
  const fetchOverrides = useCallback(() => {
    if (!channelId || !currentSpaceId) return;

    setIsFetching(true);
    setError('');

    const space = spaces.find(s => s.id === currentSpaceId);
    const channelApi = getApiForOrigin(space?._instanceOrigin ?? '');

    channelApi.channels.getOverrides(channelId)
      .then((data: ChannelOverride[]) => {
        setOverrides(data);
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
      fetchOverrides();
    } else {
      setIsFetching(false);
    }
  }, [isOpen, channelId, currentSpaceId, fetchOverrides]);

  if (!isOpen || !channel || !channelId || !currentSpaceId) return null;

  const handleToggle = async () => {
    setError('');
    setIsLoading(true);

    const space = spaces.find(s => s.id === currentSpaceId);
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
      // Re-fetch overrides to keep permissions tab in sync
      fetchOverrides();
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
      const space = spaces.find(s => s.id === currentSpaceId);
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
      <Modal isOpen={isOpen} onClose={closeModal} title="Channel Settings" maxWidth={showTabs ? 'max-w-2xl' : 'max-w-md'}>
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
                <PermissionsTab
                  channelId={channelId}
                  channelType={channel.type}
                  spaceId={currentSpaceId}
                  overrides={overrides}
                  onOverridesChange={fetchOverrides}
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
