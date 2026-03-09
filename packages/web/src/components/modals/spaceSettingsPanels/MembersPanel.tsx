import React, { useState } from 'react';
import { Avatar } from '../../ui/Avatar';
import { useSpaceStore } from '../../../stores/spaceStore';
import { useAuthStore } from '../../../stores/authStore';
import { api } from '../../../api/client';
import { hasPermissionBit, PermissionBits } from '../../../utils/permissions';
import type { MemberWithUser } from '@backspace/shared';

interface MembersPanelProps {
  spaceId: string;
}

export function MembersPanel({ spaceId }: MembersPanelProps) {
  const spaces = useSpaceStore((s) => s.spaces);
  const members = useSpaceStore((s) => s.members);
  const roles = useSpaceStore((s) => s.roles);
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);
  const currentUser = useAuthStore((s) => s.user);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);

  const space = spaces.find((s) => s.id === spaceId);
  const myPerms = spacePermissions.get(spaceId);
  const canManageRoles = hasPermissionBit(myPerms, PermissionBits.MANAGE_ROLES);
  const canKick = hasPermissionBit(myPerms, PermissionBits.KICK_MEMBERS);

  const [pendingRoleChanges, setPendingRoleChanges] = useState<Map<string, Set<string>>>(new Map());
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Assignable roles: exclude @everyone (where role.id === spaceId)
  const assignableRoles = roles.filter((r) => r.id !== spaceId);

  if (!space) return null;

  const getMemberRoleIds = (member: MemberWithUser): Set<string> => {
    const pending = pendingRoleChanges.get(member.userId);
    if (pending) return pending;
    return new Set(member.roles?.map((r) => r.id) ?? []);
  };

  const handleRoleToggle = (userId: string, roleId: string, currentRoleIds: Set<string>) => {
    const updated = new Set(currentRoleIds);
    if (updated.has(roleId)) {
      updated.delete(roleId);
    } else {
      updated.add(roleId);
    }
    setPendingRoleChanges((prev) => new Map(prev).set(userId, updated));
  };

  const handleSaveRoles = async (userId: string) => {
    const roleIds = pendingRoleChanges.get(userId);
    if (!roleIds) return;
    try {
      await api.spaces.updateMember(spaceId, userId, { roleIds: Array.from(roleIds) });
      setPendingRoleChanges((prev) => {
        const next = new Map(prev);
        next.delete(userId);
        return next;
      });
      setExpandedMemberId(null);
      await loadSpaceDetail(spaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update roles');
    }
  };

  const handleCancelRoleChange = (userId: string) => {
    setPendingRoleChanges((prev) => {
      const next = new Map(prev);
      next.delete(userId);
      return next;
    });
  };

  const handleKick = async (userId: string) => {
    try {
      await api.spaces.removeMember(spaceId, userId);
      await loadSpaceDetail(spaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to kick member');
    }
  };

  const canExpandMember = (member: MemberWithUser) =>
    canManageRoles && member.userId !== currentUser?.id && member.userId !== space.ownerId && assignableRoles.length > 0;

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
      )}
      <p className="text-xs text-txt-tertiary">Manage members of this space. Click a member to edit their roles.</p>

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Members ({members.length})
        </div>
        <div className="rounded-lg bg-white/[0.02] p-2">
          <div className="space-y-0.5">
            {members.map((member) => {
              const displayName = member.user.displayName ?? member.user.username;
              const isOwner = member.userId === space.ownerId;
              const memberRoleIds = getMemberRoleIds(member);
              const hasPendingChanges = pendingRoleChanges.has(member.userId);
              const isExpanded = expandedMemberId === member.userId;
              const expandable = canExpandMember(member);

              return (
                <div key={member.userId}>
                  <div
                    className={`flex items-center justify-between p-2 rounded transition-colors ${
                      expandable ? 'cursor-pointer hover:bg-interactive-hover' : ''
                    } ${isExpanded ? 'bg-interactive-hover' : ''}`}
                    onClick={() => {
                      if (expandable) {
                        setExpandedMemberId(isExpanded ? null : member.userId);
                      }
                    }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar
                        src={member.user.avatar}
                        name={displayName}
                        size={32}
                        status={member.user.status}
                        user={member.user}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{displayName}</div>
                        <div className="flex items-center gap-1 flex-wrap">
                          {isOwner && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-rose/20 text-txt-danger font-medium">
                              Owner
                            </span>
                          )}
                          {member.roles?.filter((r) => r.id !== spaceId).map((r) => (
                            <span
                              key={r.id}
                              className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                              style={{ backgroundColor: `${r.color}20`, color: r.color }}
                            >
                              {r.name}
                            </span>
                          ))}
                          {!isOwner && (!member.roles || member.roles.filter((r) => r.id !== spaceId).length === 0) && (
                            <span className="text-[10px] text-txt-tertiary">No roles</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      {canKick && member.userId !== currentUser?.id && !isOwner && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleKick(member.userId); }}
                          className="px-2 py-1 text-xs text-txt-danger hover:bg-accent-rose/10 rounded transition-colors"
                        >
                          Kick
                        </button>
                      )}
                      {expandable && (
                        <svg
                          className={`w-4 h-4 text-txt-tertiary transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      )}
                    </div>
                  </div>

                  {/* Role checkboxes — only shown when expanded */}
                  {isExpanded && expandable && (
                    <div className="mt-1 mb-1 ml-10 space-y-1">
                      {assignableRoles.map((role) => (
                        <label key={role.id} className="flex items-center gap-2 cursor-pointer group/role">
                          <input
                            type="checkbox"
                            checked={memberRoleIds.has(role.id)}
                            onChange={() => handleRoleToggle(member.userId, role.id, memberRoleIds)}
                            className="w-3.5 h-3.5 rounded border-txt-tertiary accent-accent-primary"
                          />
                          <span
                            className="text-xs font-medium"
                            style={{ color: role.color !== '#9ca3af' ? role.color : undefined }}
                          >
                            {role.name}
                          </span>
                        </label>
                      ))}
                      {hasPendingChanges && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <button
                            onClick={() => handleSaveRoles(member.userId)}
                            className="px-2 py-0.5 text-xs bg-accent-primary hover:bg-accent-primary/80 text-white rounded transition-colors"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => handleCancelRoleChange(member.userId)}
                            className="px-2 py-0.5 text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
