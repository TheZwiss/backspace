import React, { useState } from 'react';
import { useSpaceStore } from '../../../stores/spaceStore';
import { api } from '../../../api/client';
import { PermissionBits, stringToPermissions, permissionsToString } from '../../../utils/permissions';
import type { Role } from '@backspace/shared';

// ─── Permission display groups ─────────────────────────────────────────────

interface PermDef {
  bit: bigint;
  label: string;
}

const PERMISSION_GROUPS: { name: string; perms: PermDef[] }[] = [
  {
    name: 'General',
    perms: [
      { bit: PermissionBits.ADMINISTRATOR, label: 'Administrator' },
      { bit: PermissionBits.VIEW_CHANNEL, label: 'View Channels' },
      { bit: PermissionBits.MANAGE_CHANNELS, label: 'Manage Channels' },
      { bit: PermissionBits.MANAGE_ROLES, label: 'Manage Roles' },
      { bit: PermissionBits.MANAGE_SPACE, label: 'Manage Space' },
      { bit: PermissionBits.CREATE_INVITE, label: 'Create Invite' },
      { bit: PermissionBits.KICK_MEMBERS, label: 'Kick Members' },
      { bit: PermissionBits.BAN_MEMBERS, label: 'Ban Members' },
    ],
  },
  {
    name: 'Text',
    perms: [
      { bit: PermissionBits.SEND_MESSAGES, label: 'Send Messages' },
      { bit: PermissionBits.MANAGE_MESSAGES, label: 'Manage Messages' },
      { bit: PermissionBits.ATTACH_FILES, label: 'Attach Files' },
      { bit: PermissionBits.READ_MESSAGE_HISTORY, label: 'Read Message History' },
      { bit: PermissionBits.ADD_REACTIONS, label: 'Add Reactions' },
    ],
  },
  {
    name: 'Voice',
    perms: [
      { bit: PermissionBits.CONNECT, label: 'Connect' },
      { bit: PermissionBits.SPEAK, label: 'Speak' },
      { bit: PermissionBits.MUTE_MEMBERS, label: 'Mute Members' },
      { bit: PermissionBits.DEAFEN_MEMBERS, label: 'Deafen Members' },
      { bit: PermissionBits.MOVE_MEMBERS, label: 'Move Members' },
      { bit: PermissionBits.USE_VOICE_ACTIVITY, label: 'Voice Activity' },
      { bit: PermissionBits.STREAM, label: 'Stream' },
    ],
  },
];

const PRESET_COLORS = [
  '#b9bbbe', '#a5f3c4', '#ffc9a9', '#c4b5fd', '#93c5fd',
  '#fbbf24', '#fda4af', '#f87171', '#60a5fa', '#34d399',
];

// ─── Component ──────────────────────────────────────────────────────────────

interface RolesPanelProps {
  spaceId: string;
}

export function RolesPanel({ spaceId }: RolesPanelProps) {
  const roles = useSpaceStore((s) => s.roles);
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);

  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Sort: non-everyone roles by position desc, @everyone always last
  const sortedRoles = [...roles].sort((a, b) => {
    const aIsEveryone = a.id === spaceId;
    const bIsEveryone = b.id === spaceId;
    if (aIsEveryone) return 1;
    if (bIsEveryone) return -1;
    return b.position - a.position;
  });

  const handleCreateRole = async () => {
    setCreating(true);
    setError('');
    try {
      const newRole = await api.roles.create(spaceId, { name: 'new role' });
      await loadSpaceDetail(spaceId);
      setEditingRoleId(newRole.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create role');
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
        role={role}
        spaceId={spaceId}
        onBack={() => setEditingRoleId(null)}
        onDeleted={() => setEditingRoleId(null)}
      />
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
      )}

      <div className="sticky top-0 z-10 pointer-events-none pb-3">
        <button
          onClick={handleCreateRole}
          disabled={creating}
          className="glass-bubble rounded-full px-3 py-1.5 flex items-center gap-1.5 text-sm text-txt-primary hover:text-txt-secondary transition-colors pointer-events-auto disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {creating ? 'Creating...' : 'Create Role'}
        </button>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Roles</div>
        <p className="text-xs text-txt-tertiary mb-2">Roles define what permissions members have. Higher roles take priority.</p>
        <div className="rounded-lg bg-white/[0.02] p-2">
          <div className="space-y-0.5">
            {sortedRoles.map((role) => {
              const isEveryone = role.id === spaceId;
              return (
                <button
                  key={role.id}
                  onClick={() => setEditingRoleId(role.id)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded hover:bg-interactive-hover transition-colors text-left group"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: role.color }}
                    />
                    <span className="text-sm text-txt-primary truncate">
                      {isEveryone ? '@everyone' : role.name}
                    </span>
                  </div>
                  <svg
                    className="w-4 h-4 text-txt-tertiary group-hover:text-txt-secondary transition-colors flex-shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Role Edit View ─────────────────────────────────────────────────────────

interface RoleEditViewProps {
  role: Role;
  spaceId: string;
  onBack: () => void;
  onDeleted: () => void;
}

function RoleEditView({ role, spaceId, onBack, onDeleted }: RoleEditViewProps) {
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);
  const isEveryone = role.id === spaceId;

  const [draftName, setDraftName] = useState(role.name);
  const [draftColor, setDraftColor] = useState(role.color);
  const [draftPermissions, setDraftPermissions] = useState<bigint>(
    stringToPermissions(role.permissions)
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hasNameChange = !isEveryone && draftName.trim() !== role.name;
  const hasColorChange = !isEveryone && draftColor !== role.color;
  const hasPermChange = permissionsToString(draftPermissions) !== (role.permissions ?? '0');
  const hasChanges = hasNameChange || hasColorChange || hasPermChange;
  const showPill = hasChanges || !isEveryone;

  const togglePermission = (bit: bigint) => {
    setDraftPermissions((prev) => (prev & bit) !== 0n ? prev & ~bit : prev | bit);
  };

  const handleSave = async () => {
    setConfirmDelete(false);
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      const data: { name?: string; color?: string; permissions?: string } = {};
      if (hasNameChange) data.name = draftName.trim();
      if (hasColorChange) data.color = draftColor;
      if (hasPermChange) data.permissions = permissionsToString(draftPermissions);
      await api.roles.update(spaceId, role.id, data);
      await loadSpaceDetail(spaceId);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save role');
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
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setSaveError('');
    try {
      await api.roles.delete(spaceId, role.id);
      await loadSpaceDetail(spaceId);
      onDeleted();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to delete role');
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
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
          Back to roles
        </button>
      </div>

      {/* Identity card (Name + Color — not shown for @everyone) */}
      {!isEveryone && (
        <div>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Identity</div>
          <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
            <div>
              <label className="block text-xs text-txt-secondary mb-1.5">
                Role Name
              </label>
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-txt-secondary mb-1.5">
                Role Color
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
                  className="w-20 px-2 py-1 bg-surface-input rounded text-xs text-txt-primary outline-none focus:ring-1 focus:ring-accent-primary font-mono"
                  maxLength={7}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Permission groups — each gets its own section card */}
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.name}>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            {group.name}
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="space-y-1">
              {group.perms.map((perm) => {
                const isAdminBit = perm.bit === PermissionBits.ADMINISTRATOR;
                const hasAdmin = (draftPermissions & PermissionBits.ADMINISTRATOR) !== 0n;
                const isOn = isAdminBit ? hasAdmin : hasAdmin || (draftPermissions & perm.bit) !== 0n;
                const isInherited = !isAdminBit && hasAdmin;
                return (
                  <label
                    key={perm.label}
                    className={`flex items-center justify-between py-1.5 px-2 rounded cursor-pointer group/perm ${
                      isInherited ? 'opacity-50 cursor-default' : 'hover:bg-interactive-hover'
                    }`}
                  >
                    <span className={`text-sm ${isAdminBit ? 'text-txt-danger font-medium' : 'text-txt-primary'}`}>
                      {perm.label}
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

      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}
      {saveSuccess && (
        <div className="p-2 bg-status-online/10 border border-status-online/30 rounded text-status-online text-sm">Role saved</div>
      )}
      {showPill && (
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
                    Discard
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving || (!isEveryone && !draftName.trim())}
                    className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </>
              )}
              {!isEveryone && hasChanges && (
                <div className="w-px h-5 bg-white/10" />
              )}
              {!isEveryone && (
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors disabled:opacity-50 ${
                    confirmDelete
                      ? 'bg-accent-rose/15 text-accent-rose'
                      : 'text-accent-rose hover:bg-accent-rose/10'
                  }`}
                >
                  {deleting ? 'Deleting...' : confirmDelete ? 'Confirm?' : 'Delete Role'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
