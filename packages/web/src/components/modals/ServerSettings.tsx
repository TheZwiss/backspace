import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { Avatar } from '../ui/Avatar';
import { api } from '../../api/client';
import { useNavigate } from 'react-router-dom';
import type { MemberRole } from '@opencord/shared';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';

export function ServerSettingsModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentServerId = useServerStore((s) => s.currentServerId);
  const servers = useServerStore((s) => s.servers);
  const members = useServerStore((s) => s.members);
  const updateServer = useServerStore((s) => s.updateServer);
  const deleteServer = useServerStore((s) => s.deleteServer);
  const loadServerDetail = useServerStore((s) => s.loadServerDetail);
  const currentUser = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const [tab, setTab] = useState<'overview' | 'members'>('overview');
  const [serverName, setServerName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const serverPermissions = useServerStore((s) => s.serverPermissions);

  const isOpen = activeModal === 'serverSettings';
  const server = servers.find(s => s.id === currentServerId);
  const isOwnerUser = server?.ownerId === currentUser?.id;
  const myServerPerms = currentServerId ? serverPermissions.get(currentServerId) : undefined;
  const canManageServer = hasPermissionBit(myServerPerms, PermissionBits.MANAGE_SERVER);

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

  const handleRoleChange = async (userId: string, role: MemberRole) => {
    try {
      await api.servers.updateMember(currentServerId, userId, { role });
      await loadServerDetail(currentServerId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
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
                return (
                  <div key={member.userId} className="flex items-center justify-between p-2 rounded hover:bg-discord-bg-hover">
                    <div className="flex items-center gap-2">
                      <Avatar
                        src={member.user.avatar}
                        name={displayName}
                        size={32}
                        status={member.user.status}
                      />
                      <div>
                        <div className="text-sm font-medium">{displayName}</div>
                        <div className="text-xs text-discord-text-muted capitalize">{member.role}</div>
                      </div>
                    </div>

                    {isOwnerUser && member.userId !== currentUser?.id && (
                      <div className="flex items-center gap-2">
                        <select
                          value={member.role}
                          onChange={(e) => handleRoleChange(member.userId, e.target.value as MemberRole)}
                          className="px-2 py-1 bg-discord-bg-tertiary rounded text-xs text-discord-text-secondary outline-none"
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button
                          onClick={() => handleKick(member.userId)}
                          className="px-2 py-1 text-xs text-discord-red hover:bg-discord-red/10 rounded transition-colors"
                        >
                          Kick
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
