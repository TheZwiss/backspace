import { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Avatar } from '../ui/Avatar';
import { api } from '../../api/client';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { OverviewPanel } from './spaceSettingsPanels/OverviewPanel';
import { MembersPanel } from './spaceSettingsPanels/MembersPanel';
import { RolesPanel } from './spaceSettingsPanels/RolesPanel';
import { BansPanel } from './spaceSettingsPanels/BansPanel';
import type { SpaceVisibility, JoinRequest } from '@backspace/shared';

function DiscoveryPanel({ spaceId }: { spaceId: string }) {
  const spaces = useSpaceStore((s) => s.spaces);
  const updateSpace = useSpaceStore((s) => s.updateSpace);
  const discoveryEnabled = useSettingsStore((s) => s.streamingLimits?.discoveryEnabled ?? true);

  const space = spaces.find(s => s.id === spaceId);

  const [visibility, setVisibility] = useState<SpaceVisibility>(
    (space?.visibility as SpaceVisibility) ?? 'private'
  );
  const [description, setDescription] = useState(space?.description ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (space) {
      setVisibility((space.visibility as SpaceVisibility) ?? 'private');
      setDescription(space.description ?? '');
    }
  }, [space]);

  if (!space) return null;

  const hasChanges =
    visibility !== ((space.visibility as SpaceVisibility) ?? 'private') ||
    description !== (space.description ?? '');

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      await api.spaces.update(spaceId, { visibility, description: description.trim() });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setVisibility((space.visibility as SpaceVisibility) ?? 'private');
    setDescription(space.description ?? '');
    setSaveError('');
  };

  const visibilityOptions: { value: SpaceVisibility; label: string; desc: string }[] = [
    { value: 'private', label: 'Private', desc: 'Only people with an invite link can join' },
    { value: 'request', label: 'Request to Join', desc: 'Visible in Explore — people can request to join' },
    { value: 'public', label: 'Public', desc: 'Visible in Explore — anyone can join instantly' },
  ];

  return (
    <div className="space-y-5">
      {!discoveryEnabled && (
        <div className="p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber">
          Space discovery is disabled by the instance administrator. Changing visibility will have no effect until discovery is re-enabled.
        </div>
      )}

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Visibility</div>
        <p className="text-xs text-txt-tertiary mb-2">Control who can discover and join this space.</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <div className="space-y-1.5">
            {visibilityOptions.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-2.5 rounded cursor-pointer transition-colors ${
                  visibility === opt.value
                    ? 'bg-interactive-selected'
                    : 'hover:bg-interactive-hover'
                }`}
              >
                <input
                  type="radio"
                  name="visibility"
                  value={opt.value}
                  checked={visibility === opt.value}
                  onChange={() => setVisibility(opt.value)}
                  className="mt-0.5 accent-accent-primary"
                />
                <div>
                  <div className="text-sm font-medium text-txt-primary">{opt.label}</div>
                  <div className="text-xs text-txt-tertiary">{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Description</div>
        <p className="text-xs text-txt-tertiary mb-2">A short summary shown on the Explore page.</p>
        <div className="rounded-lg bg-white/[0.02] p-3.5">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 200))}
            placeholder="A short description for the Explore page..."
            rows={3}
            className="input-standard w-full resize-none"
          />
          <div className="text-[11px] text-txt-tertiary text-right">{description.length}/200</div>
        </div>
      </div>

      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}
      {saveSuccess && (
        <div className="p-2 bg-status-online/10 border border-status-online/30 rounded text-status-online text-sm">Settings saved</div>
      )}

      {/* Pending Join Requests — only shown when visibility is 'request' */}
      {(visibility === 'request' || (space.visibility as SpaceVisibility) === 'request') && (
        <JoinRequestsSection spaceId={spaceId} />
      )}

      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
              <button
                onClick={handleReset}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                Reset
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

function JoinRequestsSection({ spaceId }: { spaceId: string }) {
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.explore.getJoinRequests(spaceId, 'pending')
      .then(({ requests: reqs }) => {
        if (!cancelled) {
          setRequests(reqs);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [spaceId]);

  const handleDecide = async (requestId: string, action: 'accept' | 'decline') => {
    setActionError('');
    try {
      await api.explore.decideJoinRequest(spaceId, requestId, action);
      setRequests(prev => prev.filter(r => r.id !== requestId));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    }
  };

  return (
    <div className="pt-4 border-t border-border-soft">
      <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider mb-2">
        Pending Join Requests
      </div>

      {actionError && (
        <div className="mb-2 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs">
          {actionError}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-txt-tertiary">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="text-sm text-txt-tertiary">No pending join requests</div>
      ) : (
        <div className="space-y-2 max-h-[240px] overflow-y-auto scrollbar-thin">
          {requests.map((req) => {
            const user = req.user;
            const displayName = user?.displayName ?? user?.username ?? 'Unknown';

            return (
              <div key={req.id} className="flex items-start gap-3 p-2.5 rounded bg-surface-base">
                <Avatar
                  src={user?.avatar}
                  name={displayName}
                  size={32}
                  userId={user?.homeUserId ?? user?.id}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-txt-primary truncate">{displayName}</span>
                    {user?.username && (
                      <span className="text-xs text-txt-tertiary">@{user.username}</span>
                    )}
                  </div>
                  {req.message && (
                    <p className="text-xs text-txt-secondary mt-0.5 line-clamp-2">{req.message}</p>
                  )}
                  <span className="text-[10px] text-txt-tertiary">
                    {new Date(req.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleDecide(req.id, 'accept')}
                    className="p-1.5 rounded text-status-online hover:bg-status-online/20 transition-colors"
                    title="Accept"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDecide(req.id, 'decline')}
                    className="p-1.5 rounded text-txt-danger hover:bg-accent-rose/20 transition-colors"
                    title="Decline"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SpaceSettingsModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const spaces = useSpaceStore((s) => s.spaces);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);

  const [tab, setTab] = useState<'overview' | 'discovery' | 'members' | 'roles' | 'bans'>('overview');

  const isOpen = activeModal === 'spaceSettings';
  const space = spaces.find(s => s.id === currentSpaceId);
  const mySpacePerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;
  const canManageSpace = hasPermissionBit(mySpacePerms, PermissionBits.MANAGE_SPACE);
  const canManageRoles = hasPermissionBit(mySpacePerms, PermissionBits.MANAGE_ROLES);
  const canBanMembers = hasPermissionBit(mySpacePerms, PermissionBits.BAN_MEMBERS);

  if (!space || !currentSpaceId) return null;

  const tabClass = (t: typeof tab) =>
    `w-full text-left px-2.5 py-1.5 rounded text-sm transition-colors ${
      tab === t ? 'bg-interactive-selected text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Space Settings" maxWidth="max-w-2xl" mobileStyle="fullscreen">
      <div className="flex gap-4 h-[min(520px,70vh)]">
        {/* Tabs */}
        <div className="w-32 flex-shrink-0 self-start z-10">
          <div className="glass-bubble rounded-lg p-1.5 space-y-0.5">
            <button onClick={() => setTab('overview')} className={tabClass('overview')}>
              Overview
            </button>
            {canManageSpace && (
              <button onClick={() => setTab('discovery')} className={tabClass('discovery')}>
                Discovery
              </button>
            )}
            <button onClick={() => setTab('members')} className={tabClass('members')}>
              Members
            </button>
            {canManageRoles && (
              <button onClick={() => setTab('roles')} className={tabClass('roles')}>
                Roles
              </button>
            )}
            {canBanMembers && (
              <button onClick={() => setTab('bans')} className={tabClass('bans')}>
                Bans
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin">
          {tab === 'overview' && <OverviewPanel spaceId={currentSpaceId} />}
          {tab === 'discovery' && canManageSpace && <DiscoveryPanel spaceId={currentSpaceId} />}
          {tab === 'members' && <MembersPanel spaceId={currentSpaceId} />}
          {tab === 'roles' && canManageRoles && <RolesPanel spaceId={currentSpaceId} />}
          {tab === 'bans' && canBanMembers && <BansPanel spaceId={currentSpaceId} />}
        </div>
      </div>
    </Modal>
  );
}
