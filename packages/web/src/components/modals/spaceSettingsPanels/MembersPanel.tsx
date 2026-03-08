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

  return (
    <div>
      {error && (
        <div className="mb-3 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
      )}
      <div className="space-y-2 max-h-[400px] overflow-y-auto scrollbar-thin">
        {members.map((member) => {
          const displayName = member.user.displayName ?? member.user.username;
          const isOwner = member.userId === space.ownerId;
          const memberRoleIds = getMemberRoleIds(member);
          const hasPendingChanges = pendingRoleChanges.has(member.userId);

          return (
            <div key={member.userId} className="p-2 rounded hover:bg-interactive-hover">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Avatar
                    src={member.user.avatar}
                    name={displayName}
                    size={32}
                    status={member.user.status}
                    user={member.user}
                  />
                  <div>
                    <div className="text-sm font-medium">{displayName}</div>
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

                {canKick && member.userId !== currentUser?.id && !isOwner && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleKick(member.userId)}
                      className="px-2 py-1 text-xs text-txt-danger hover:bg-accent-rose/10 rounded transition-colors"
                    >
                      Kick
                    </button>
                  </div>
                )}
              </div>

              {/* Role checkboxes — shown for non-self, non-owner members when user can manage roles */}
              {canManageRoles && member.userId !== currentUser?.id && !isOwner && assignableRoles.length > 0 && (
                <div className="mt-2 ml-10 space-y-1">
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
  );
}
