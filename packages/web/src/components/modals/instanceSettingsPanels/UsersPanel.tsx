import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../../api/client';
import { Avatar } from '../../ui/Avatar';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useAuthStore } from '../../../stores/authStore';
import type { AdminUser, AdminUserListResponse } from '@backspace/shared';

export function UsersPanel() {
  const currentUser = useAuthStore((s) => s.user);
  const [data, setData] = useState<AdminUserListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [query, setQuery] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const [instanceFilter, setInstanceFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [joinedAfter, setJoinedAfter] = useState('');
  const [joinedBefore, setJoinedBefore] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [instances, setInstances] = useState<string[]>([]);

  // Confirm dialogs
  const [confirmAction, setConfirmAction] = useState<{ type: 'demote' | 'delete'; user: AdminUser } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Temp password display
  const [tempPassword, setTempPassword] = useState<{ userId: string; password: string } | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    api.admin.listInstances().then(({ instances: inst }) => setInstances(inst)).catch(() => {});
  }, []);

  const filtersRef = useRef({ homeInstance: '', role: '', joinedAfter: '', joinedBefore: '', sort: 'newest' });
  filtersRef.current = { homeInstance: instanceFilter, role: roleFilter, joinedAfter, joinedBefore, sort: sortBy };

  const fetchUsers = useCallback(async (
    q: string, p: number, deleted: boolean,
    opts?: { homeInstance?: string; role?: string; joinedAfter?: string; joinedBefore?: string; sort?: string }
  ) => {
    setLoading(true);
    setError('');
    try {
      const result = await api.admin.listUsers({
        q: q || undefined, page: p, pageSize, showDeleted: deleted,
        homeInstance: opts?.homeInstance || undefined,
        role: opts?.role || undefined,
        joinedAfter: opts?.joinedAfter || undefined,
        joinedBefore: opts?.joinedBefore || undefined,
        sort: opts?.sort || undefined,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers(query, page, showDeleted, filtersRef.current);
  }, [fetchUsers, page, showDeleted, instanceFilter, roleFilter, joinedAfter, joinedBefore, sortBy]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearchChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      fetchUsers(value, 1, showDeleted, filtersRef.current);
    }, 300);
  };

  const handleToggleAdmin = async (user: AdminUser) => {
    if (user.isAdmin) {
      // Demoting — confirm first
      setConfirmAction({ type: 'demote', user });
      return;
    }
    // Promoting — no confirm needed
    setError('');
    try {
      await api.admin.setUserRole(user.id, true);
      fetchUsers(query, page, showDeleted, filtersRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  };

  const [resetConfirmUser, setResetConfirmUser] = useState<AdminUser | null>(null);
  const [resetLoading, setResetLoading] = useState(false);

  const handleResetPassword = (user: AdminUser) => {
    setResetConfirmUser(user);
  };

  const handleResetConfirm = async () => {
    if (!resetConfirmUser) return;
    setResetLoading(true);
    setError('');
    setTempPassword(null);
    try {
      const result = await api.admin.resetUserPassword(resetConfirmUser.id);
      setTempPassword({ userId: resetConfirmUser.id, password: result.temporaryPassword });
      setResetConfirmUser(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
      setResetConfirmUser(null);
    } finally {
      setResetLoading(false);
    }
  };

  const handleDeleteUser = (user: AdminUser) => {
    setConfirmAction({ type: 'delete', user });
  };

  const handleConfirm = async () => {
    if (!confirmAction) return;
    setActionLoading(true);
    setError('');
    try {
      if (confirmAction.type === 'demote') {
        await api.admin.setUserRole(confirmAction.user.id, false);
      } else {
        await api.admin.deleteUser(confirmAction.user.id);
      }
      setConfirmAction(null);
      fetchUsers(query, page, showDeleted, filtersRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
      setConfirmAction(null);
    } finally {
      setActionLoading(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-txt-primary">Users</h2>
      <div className="text-xs text-txt-tertiary">
        View and manage user accounts on this instance.
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={query}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search users..."
          className="input-search flex-1"
        />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={instanceFilter}
          onChange={(e) => { setInstanceFilter(e.target.value); setPage(1); }}
          className="input-search text-xs py-1"
        >
          <option value="">All instances</option>
          <option value="local">Local only</option>
          {instances.map((inst) => (
            <option key={inst} value={inst}>{inst}</option>
          ))}
        </select>

        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}
          className="input-search text-xs py-1"
        >
          <option value="">All roles</option>
          <option value="admin">Admin</option>
          <option value="non-admin">Non-admin</option>
        </select>

        <input
          type="date"
          value={joinedAfter}
          onChange={(e) => { setJoinedAfter(e.target.value); setPage(1); }}
          className="input-search text-xs py-1"
          title="Joined after"
        />
        <input
          type="date"
          value={joinedBefore}
          onChange={(e) => { setJoinedBefore(e.target.value); setPage(1); }}
          className="input-search text-xs py-1"
          title="Joined before"
        />

        <select
          value={sortBy}
          onChange={(e) => { setSortBy(e.target.value); setPage(1); }}
          className="input-search text-xs py-1"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="az">Name A-Z</option>
          <option value="za">Name Z-A</option>
        </select>

        <label className="flex items-center gap-1.5 text-xs text-txt-secondary cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => { setShowDeleted(e.target.checked); setPage(1); }}
            className="w-3 h-3 rounded border-border-soft accent-accent-primary"
          />
          Deleted
        </label>

        {(instanceFilter || roleFilter || joinedAfter || joinedBefore || sortBy !== 'newest' || showDeleted || query) && (
          <button
            onClick={() => {
              setQuery(''); setInstanceFilter(''); setRoleFilter('');
              setJoinedAfter(''); setJoinedBefore('');
              setSortBy('newest'); setShowDeleted(false); setPage(1);
              fetchUsers('', 1, false, { sort: 'newest' });
            }}
            className="text-xs text-accent-primary hover:text-accent-primary/80 whitespace-nowrap"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
      )}

      {/* Loading */}
      {loading && !data && (
        <div className="text-sm text-txt-tertiary py-4">Loading users...</div>
      )}

      {/* User list */}
      {data && (
        <div className="space-y-1.5">
          {data.users.length === 0 && (
            <div className="text-sm text-txt-tertiary py-4 text-center">No users found</div>
          )}
          {data.users.map((user) => {
            const isSelf = user.id === currentUser?.id;
            const isFederated = !!user.homeInstance;
            const isDeleted = user.isDeleted;

            const hasTempPassword = tempPassword?.userId === user.id;

            return (
              <div key={user.id}>
                <div className={`flex items-center gap-3 rounded-lg bg-white/[0.02] p-3.5 ${hasTempPassword ? 'rounded-b-none' : ''}`}>
                  {/* Avatar */}
                  <div className={isDeleted ? 'opacity-50' : ''}>
                    <Avatar
                      src={user.avatar ? api.uploads.url(user.avatar) : null}
                      name={user.displayName || user.username}
                      size={32}
                      avatarColor={user.avatarColor as any}
                    />
                  </div>

                  {/* Info */}
                  <div className={`flex-1 min-w-0 ${isDeleted ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium text-txt-primary truncate ${isDeleted ? 'line-through' : ''}`}>
                        {user.username}
                      </span>
                      {user.displayName && !isDeleted && (
                        <span className="text-xs text-txt-tertiary truncate">{user.displayName}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {user.isAdmin && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent-amber/20 text-accent-amber">
                          Admin
                        </span>
                      )}
                      {isFederated && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent-sky/20 text-accent-sky truncate max-w-[120px]">
                          {user.homeInstance}
                        </span>
                      )}
                      {isDeleted && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent-rose/20 text-accent-rose">
                          Deleted
                        </span>
                      )}
                      <span className="text-[10px] text-txt-tertiary">
                        {formatDate(user.createdAt)}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  {!isDeleted && (
                    <div className="flex items-center gap-1 shrink-0">
                      {/* Toggle admin */}
                      <button
                        onClick={() => handleToggleAdmin(user)}
                        disabled={isFederated && !user.isAdmin}
                        title={user.isAdmin ? 'Demote from admin' : isFederated ? 'Federated users cannot be admin' : 'Promote to admin'}
                        className={`p-1.5 rounded transition-colors ${
                          user.isAdmin
                            ? 'text-accent-amber hover:bg-accent-amber/10'
                            : isFederated
                              ? 'text-txt-tertiary/30 cursor-not-allowed'
                              : 'text-txt-tertiary hover:text-txt-secondary hover:bg-white/[0.06]'
                        }`}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                        </svg>
                      </button>

                      {/* Reset password */}
                      <button
                        onClick={() => handleResetPassword(user)}
                        disabled={isFederated}
                        title={isFederated ? 'Federated users authenticate via home instance' : 'Reset password'}
                        className={`p-1.5 rounded transition-colors ${
                          isFederated
                            ? 'text-txt-tertiary/30 cursor-not-allowed'
                            : 'text-txt-tertiary hover:text-txt-secondary hover:bg-white/[0.06]'
                        }`}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                        </svg>
                      </button>

                      {/* Delete user */}
                      <button
                        onClick={() => handleDeleteUser(user)}
                        disabled={isSelf}
                        title={isSelf ? 'Use account settings to delete your own account' : 'Delete user'}
                        className={`p-1.5 rounded transition-colors ${
                          isSelf
                            ? 'text-txt-tertiary/30 cursor-not-allowed'
                            : 'text-txt-tertiary hover:text-accent-rose hover:bg-accent-rose/10'
                        }`}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>

                {/* Inline temp password display */}
                {hasTempPassword && (
                  <div className="p-3 bg-status-online/10 border border-status-online/30 border-t-0 rounded-b-lg">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-txt-secondary">Temporary password:</div>
                      <button
                        onClick={() => setTempPassword(null)}
                        className="text-txt-tertiary hover:text-txt-secondary text-xs"
                      >
                        Dismiss
                      </button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <code className="px-2 py-1 bg-black/30 rounded text-sm font-mono text-status-online select-all">
                        {tempPassword.password}
                      </code>
                      <button
                        onClick={() => navigator.clipboard.writeText(tempPassword.password)}
                        className="px-2 py-1 bg-white/[0.06] hover:bg-white/[0.1] text-txt-secondary text-xs rounded transition-colors"
                      >
                        Copy
                      </button>
                    </div>
                    <div className="text-[10px] text-txt-tertiary mt-1">
                      Shown once. User has been disconnected and must log in again.
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <span className="text-xs text-txt-tertiary">
            Page {page} of {totalPages} ({data.total} user{data.total !== 1 ? 's' : ''})
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1 text-sm text-txt-secondary hover:text-txt-primary bg-white/[0.04] hover:bg-white/[0.08] rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      )}

      {/* Confirm dialogs */}
      <ConfirmDialog
        isOpen={!!resetConfirmUser}
        onClose={() => setResetConfirmUser(null)}
        onConfirm={handleResetConfirm}
        title="Reset Password"
        description={<>Reset the password for <strong>{resetConfirmUser?.username}</strong>? They will be disconnected immediately and must log in with the new temporary password.</>}
        confirmLabel="Reset Password"
        variant="warning"
        loading={resetLoading}
      />
      <ConfirmDialog
        isOpen={confirmAction?.type === 'demote'}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleConfirm}
        title="Demote Admin"
        description={<>Remove admin privileges from <strong>{confirmAction?.user.username}</strong>? They will lose access to instance settings.</>}
        confirmLabel="Demote"
        variant="warning"
        loading={actionLoading}
      />
      <ConfirmDialog
        isOpen={confirmAction?.type === 'delete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleConfirm}
        title="Delete User"
        description={<>Permanently delete <strong>{confirmAction?.user.username}</strong>? This will remove them from all spaces, DMs, and friends lists. This cannot be undone.</>}
        confirmLabel="Delete User"
        variant="danger"
        loading={actionLoading}
      />
    </div>
  );
}
