import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Avatar } from '../ui/Avatar';
import { api } from '../../api/client';
import { useNavigate } from 'react-router-dom';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import type { InstanceStreamingLimits } from '@backspace/shared';

const VALID_RESOLUTIONS = [540, 720, 1080] as const;
const VALID_FRAMERATES = [30, 45, 60] as const;

function formatKbps(kbps: number): string {
  return kbps >= 1000
    ? `${(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)} Mbps`
    : `${kbps} kbps`;
}

function StreamingLimitsPanel() {
  const limits = useSettingsStore((s) => s.streamingLimits);
  const updateStreamingLimits = useSettingsStore((s) => s.updateStreamingLimits);

  const [draft, setDraft] = useState<InstanceStreamingLimits | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (limits) setDraft({ ...limits });
  }, [limits]);

  if (!draft) return <div className="text-sm text-discord-text-muted">Loading settings...</div>;

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(limits);

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      await updateStreamingLimits(draft);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (limits) setDraft({ ...limits });
    setSaveError('');
  };

  const toggleResolution = (res: number) => {
    const current = new Set(draft.allowedResolutions);
    if (current.has(res)) {
      if (current.size <= 1) return; // Must have at least one
      current.delete(res);
    } else {
      current.add(res);
    }
    setDraft({ ...draft, allowedResolutions: Array.from(current).sort((a, b) => a - b) });
  };

  const toggleFramerate = (fps: number) => {
    const current = new Set(draft.allowedFramerates);
    if (current.has(fps)) {
      if (current.size <= 1) return;
      current.delete(fps);
    } else {
      current.add(fps);
    }
    setDraft({ ...draft, allowedFramerates: Array.from(current).sort((a, b) => a - b) });
  };

  const pillBase = 'px-3 py-1.5 rounded text-[13px] font-medium transition-colors cursor-pointer select-none';
  const pillOn = 'bg-discord-blurple text-white';
  const pillOff = 'bg-[#2b2d31] text-discord-text-secondary hover:bg-[#35373c]';

  return (
    <div className="space-y-4">
      <div className="text-xs text-discord-text-muted">
        These limits apply to all users on this instance. Users can pick values within these bounds.
      </div>

      {/* Bitrate Range */}
      <div>
        <div className="text-[11px] text-discord-text-muted font-semibold uppercase tracking-wider mb-2">
          Bitrate Range
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="text-[11px] text-discord-text-muted mb-1 block">Min</label>
            <input
              type="range"
              min={100}
              max={draft.maxBitrateKbps - 500}
              step={100}
              value={draft.minBitrateKbps}
              onChange={(e) => setDraft({ ...draft, minBitrateKbps: Number(e.target.value) })}
              className="w-full h-1.5 accent-discord-blurple cursor-pointer appearance-none bg-[#4e5058] rounded-full
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0"
            />
            <div className="text-[11px] text-discord-text-secondary mt-0.5">{formatKbps(draft.minBitrateKbps)}</div>
          </div>
          <div className="flex-1">
            <label className="text-[11px] text-discord-text-muted mb-1 block">Max</label>
            <input
              type="range"
              min={draft.minBitrateKbps + 500}
              max={50000}
              step={500}
              value={draft.maxBitrateKbps}
              onChange={(e) => setDraft({ ...draft, maxBitrateKbps: Number(e.target.value) })}
              className="w-full h-1.5 accent-discord-blurple cursor-pointer appearance-none bg-[#4e5058] rounded-full
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-0"
            />
            <div className="text-[11px] text-discord-text-secondary mt-0.5">{formatKbps(draft.maxBitrateKbps)}</div>
          </div>
        </div>
      </div>

      {/* Bitrate Step */}
      <div>
        <div className="text-[11px] text-discord-text-muted font-semibold uppercase tracking-wider mb-1.5">
          Slider Step
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={50}
            max={5000}
            step={50}
            value={draft.bitrateStepKbps}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= 50 && v <= 5000) setDraft({ ...draft, bitrateStepKbps: v });
            }}
            className="w-24 px-2 py-1 bg-discord-bg-tertiary rounded text-sm text-discord-text-primary outline-none focus:ring-1 focus:ring-discord-blurple"
          />
          <span className="text-[12px] text-discord-text-muted">kbps</span>
        </div>
      </div>

      {/* Allowed Resolutions */}
      <div>
        <div className="text-[11px] text-discord-text-muted font-semibold uppercase tracking-wider mb-1.5">
          Allowed Resolutions
        </div>
        <div className="flex gap-1.5">
          {VALID_RESOLUTIONS.map((res) => (
            <button
              key={res}
              onClick={() => toggleResolution(res)}
              className={`${pillBase} ${draft.allowedResolutions.includes(res) ? pillOn : pillOff}`}
            >
              {res}p
            </button>
          ))}
        </div>
      </div>

      {/* Allowed Frame Rates */}
      <div>
        <div className="text-[11px] text-discord-text-muted font-semibold uppercase tracking-wider mb-1.5">
          Allowed Frame Rates
        </div>
        <div className="flex gap-1.5">
          {VALID_FRAMERATES.map((fps) => (
            <button
              key={fps}
              onClick={() => toggleFramerate(fps)}
              className={`${pillBase} ${draft.allowedFramerates.includes(fps) ? pillOn : pillOff}`}
            >
              {fps} fps
            </button>
          ))}
        </div>
      </div>

      {/* Save / Reset */}
      {saveError && (
        <div className="p-2 bg-discord-red/10 border border-discord-red/30 rounded text-discord-text-danger text-sm">{saveError}</div>
      )}
      {saveSuccess && (
        <div className="p-2 bg-green-500/10 border border-green-500/30 rounded text-green-400 text-sm">Settings saved</div>
      )}
      {hasChanges && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleReset}
            className="px-4 py-1.5 text-sm text-discord-text-muted hover:text-discord-text-secondary transition-colors"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

export function ServerSettingsModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentServerId = useServerStore((s) => s.currentServerId);
  const servers = useServerStore((s) => s.servers);
  const members = useServerStore((s) => s.members);
  const roles = useServerStore((s) => s.roles);
  const updateServer = useServerStore((s) => s.updateServer);
  const deleteServer = useServerStore((s) => s.deleteServer);
  const loadServerDetail = useServerStore((s) => s.loadServerDetail);
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = useSettingsStore((s) => s.isAdmin);
  const navigate = useNavigate();

  const [tab, setTab] = useState<'overview' | 'members' | 'streaming'>('overview');
  const [serverName, setServerName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingRoleChanges, setPendingRoleChanges] = useState<Map<string, Set<string>>>(new Map());

  const serverPermissions = useServerStore((s) => s.serverPermissions);

  const isOpen = activeModal === 'serverSettings';
  const server = servers.find(s => s.id === currentServerId);
  const isOwnerUser = server?.ownerId === currentUser?.id;
  const myServerPerms = currentServerId ? serverPermissions.get(currentServerId) : undefined;
  const canManageServer = hasPermissionBit(myServerPerms, PermissionBits.MANAGE_SERVER);
  const canManageRoles = hasPermissionBit(myServerPerms, PermissionBits.MANAGE_ROLES);

  // Assignable roles: exclude @everyone (where role.id === serverId)
  const assignableRoles = roles.filter(r => r.id !== currentServerId);

  React.useEffect(() => {
    if (server) {
      setServerName(server.name);
    }
  }, [server]);

  if (!server || !currentServerId) return null;

  const handleSave = async () => {
    setError('');
    setIsLoading(true);
    try {
      await updateServer(currentServerId, { name: serverName.trim() });
      setIsLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update server');
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await deleteServer(currentServerId);
      closeModal();
      navigate('/channels/@me');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete server');
    }
  };

  const getMemberRoleIds = (member: typeof members[number]): Set<string> => {
    // Check for pending (unsaved) changes first
    const pending = pendingRoleChanges.get(member.userId);
    if (pending) return pending;
    return new Set(member.roles?.map(r => r.id) ?? []);
  };

  const handleRoleToggle = (userId: string, roleId: string, currentRoleIds: Set<string>) => {
    const updated = new Set(currentRoleIds);
    if (updated.has(roleId)) {
      updated.delete(roleId);
    } else {
      updated.add(roleId);
    }
    setPendingRoleChanges(prev => new Map(prev).set(userId, updated));
  };

  const handleSaveRoles = async (userId: string) => {
    const roleIds = pendingRoleChanges.get(userId);
    if (!roleIds) return;

    try {
      await api.servers.updateMember(currentServerId, userId, { roleIds: Array.from(roleIds) });
      setPendingRoleChanges(prev => {
        const next = new Map(prev);
        next.delete(userId);
        return next;
      });
      await loadServerDetail(currentServerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update roles');
    }
  };

  const handleCancelRoleChange = (userId: string) => {
    setPendingRoleChanges(prev => {
      const next = new Map(prev);
      next.delete(userId);
      return next;
    });
  };

  const handleKick = async (userId: string) => {
    try {
      await api.servers.removeMember(currentServerId, userId);
      await loadServerDetail(currentServerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to kick member');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Server Settings" maxWidth="max-w-xl">
      <div className="flex gap-4">
        {/* Tabs */}
        <div className="w-32 flex-shrink-0 space-y-1">
          <button
            onClick={() => setTab('overview')}
            className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
              tab === 'overview' ? 'bg-discord-bg-active text-discord-text-primary' : 'text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-bg-hover'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setTab('members')}
            className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
              tab === 'members' ? 'bg-discord-bg-active text-discord-text-primary' : 'text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-bg-hover'
            }`}
          >
            Members
          </button>
          {isAdmin && (
            <button
              onClick={() => setTab('streaming')}
              className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                tab === 'streaming' ? 'bg-discord-bg-active text-discord-text-primary' : 'text-discord-text-muted hover:text-discord-text-secondary hover:bg-discord-bg-hover'
              }`}
            >
              Streaming
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {error && (
            <div className="mb-3 p-2 bg-discord-red/10 border border-discord-red/30 rounded text-discord-text-danger text-sm">{error}</div>
          )}

          {tab === 'overview' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-discord-text-secondary uppercase mb-2">
                  Server Name
                </label>
                <input
                  type="text"
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  className="w-full px-3 py-2 bg-discord-bg-tertiary rounded text-discord-text-primary outline-none focus:ring-2 focus:ring-discord-blurple"
                  disabled={!canManageServer}
                />
              </div>

              {canManageServer && (
                <>
                  <button
                    onClick={handleSave}
                    disabled={isLoading}
                    className="px-4 py-2 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
                  >
                    {isLoading ? 'Saving...' : 'Save Changes'}
                  </button>

                  <div className="pt-4 border-t border-discord-bg-tertiary">
                    <h3 className="text-sm font-bold text-discord-red mb-2">Danger Zone</h3>
                    <button
                      onClick={handleDelete}
                      className="px-4 py-2 bg-discord-red hover:bg-discord-red-hover text-white text-sm font-medium rounded transition-colors"
                    >
                      {confirmDelete ? 'Click again to confirm deletion' : 'Delete Server'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'members' && (
            <div className="space-y-2 max-h-[400px] overflow-y-auto scrollbar-thin">
              {members.map((member) => {
                const displayName = member.user.displayName ?? member.user.username;
                const isOwner = member.userId === server.ownerId;
                const memberRoleIds = getMemberRoleIds(member);
                const hasPendingChanges = pendingRoleChanges.has(member.userId);

                return (
                  <div key={member.userId} className="p-2 rounded hover:bg-discord-bg-hover">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Avatar
                          src={member.user.avatar}
                          name={displayName}
                          size={32}
                          status={member.user.status}
                        />
                        <div>
                          <div className="text-sm font-medium">{displayName}</div>
                          <div className="flex items-center gap-1 flex-wrap">
                            {isOwner && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-discord-red/20 text-discord-red font-medium">
                                Owner
                              </span>
                            )}
                            {member.roles?.filter(r => r.id !== currentServerId).map(r => (
                              <span
                                key={r.id}
                                className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                                style={{ backgroundColor: `${r.color}20`, color: r.color }}
                              >
                                {r.name}
                              </span>
                            ))}
                            {!isOwner && (!member.roles || member.roles.filter(r => r.id !== currentServerId).length === 0) && (
                              <span className="text-[10px] text-discord-text-muted">No roles</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {canManageRoles && member.userId !== currentUser?.id && !isOwner && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleKick(member.userId)}
                            className="px-2 py-1 text-xs text-discord-red hover:bg-discord-red/10 rounded transition-colors"
                          >
                            Kick
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Role checkboxes — shown for non-self, non-owner members when user can manage roles */}
                    {canManageRoles && member.userId !== currentUser?.id && !isOwner && assignableRoles.length > 0 && (
                      <div className="mt-2 ml-10 space-y-1">
                        {assignableRoles.map(role => (
                          <label key={role.id} className="flex items-center gap-2 cursor-pointer group/role">
                            <input
                              type="checkbox"
                              checked={memberRoleIds.has(role.id)}
                              onChange={() => handleRoleToggle(member.userId, role.id, memberRoleIds)}
                              className="w-3.5 h-3.5 rounded border-discord-text-muted accent-discord-blurple"
                            />
                            <span
                              className="text-xs font-medium"
                              style={{ color: role.color !== '#b9bbbe' ? role.color : undefined }}
                            >
                              {role.name}
                            </span>
                          </label>
                        ))}
                        {hasPendingChanges && (
                          <div className="flex items-center gap-2 mt-1.5">
                            <button
                              onClick={() => handleSaveRoles(member.userId)}
                              className="px-2 py-0.5 text-xs bg-discord-blurple hover:bg-discord-blurple-hover text-white rounded transition-colors"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => handleCancelRoleChange(member.userId)}
                              className="px-2 py-0.5 text-xs text-discord-text-muted hover:text-discord-text-secondary transition-colors"
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
          )}

          {tab === 'streaming' && isAdmin && (
            <StreamingLimitsPanel />
          )}
        </div>
      </div>
    </Modal>
  );
}
