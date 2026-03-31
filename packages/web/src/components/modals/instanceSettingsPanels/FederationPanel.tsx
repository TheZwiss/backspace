import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { Toggle } from '../../ui/Toggle';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { api } from '../../../api/client';
import type { InstanceAdminSettings } from '@backspace/shared';
import type { FederationPeer } from '../../../api/client';

// ─── Global Settings ─────────────────────────────────────────────────────────

function FederationGlobalSettings() {
  const instanceSettings = useSettingsStore((s) => s.instanceSettings);
  const updateInstanceSettings = useSettingsStore((s) => s.updateInstanceSettings);
  const addToast = useUIStore((s) => s.addToast);

  const [draft, setDraft] = useState<Pick<InstanceAdminSettings, 'federationRelayEnabled' | 'federationRelayTtlDays' | 'defaultAutoRotateIntervalDays'> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (instanceSettings) {
      setDraft({
        federationRelayEnabled: instanceSettings.federationRelayEnabled,
        federationRelayTtlDays: instanceSettings.federationRelayTtlDays,
        defaultAutoRotateIntervalDays: instanceSettings.defaultAutoRotateIntervalDays,
      });
    }
  }, [instanceSettings]);

  if (!draft) return null;

  const hasChanges = instanceSettings
    ? draft.federationRelayEnabled !== instanceSettings.federationRelayEnabled ||
      draft.federationRelayTtlDays !== instanceSettings.federationRelayTtlDays ||
      draft.defaultAutoRotateIntervalDays !== instanceSettings.defaultAutoRotateIntervalDays
    : false;

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await updateInstanceSettings(draft);
      addToast('Settings saved', 'success', 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (instanceSettings) {
      setDraft({
        federationRelayEnabled: instanceSettings.federationRelayEnabled,
        federationRelayTtlDays: instanceSettings.federationRelayTtlDays,
        defaultAutoRotateIntervalDays: instanceSettings.defaultAutoRotateIntervalDays,
      });
    }
    setSaveError('');
  };

  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Relay Settings</div>
      <p className="text-xs text-txt-tertiary mb-2">
        Control DM relay between federated instances. When enabled, DMs with users on peer instances are relayed server-to-server.
      </p>
      <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div className="text-sm font-medium text-txt-primary">Enable DM Relay</div>
            <div className="text-xs text-txt-tertiary mt-0.5">Relay direct messages to and from peer instances</div>
          </div>
          <Toggle enabled={draft.federationRelayEnabled} onChange={(v) => setDraft({ ...draft, federationRelayEnabled: v })} />
        </label>

        <div>
          <div className="text-sm font-medium text-txt-primary mb-1">Relay TTL (days)</div>
          <div className="text-xs text-txt-tertiary mb-2">How long relayed messages are retained in the outbox before cleanup</div>
          <input
            type="number"
            min={1}
            max={365}
            value={draft.federationRelayTtlDays}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1 && val <= 365) {
                setDraft({ ...draft, federationRelayTtlDays: val });
              }
            }}
            className="input-standard w-24"
          />
        </div>

        <div>
          <div className="text-sm font-medium text-txt-primary mb-1">Default Secret Rotation (days)</div>
          <div className="text-xs text-txt-tertiary mb-2">Auto-rotation interval for new peers. Existing peers keep their current setting.</div>
          <input
            type="number"
            min={1}
            max={365}
            value={draft.defaultAutoRotateIntervalDays}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val >= 1 && val <= 365) {
                setDraft({ ...draft, defaultAutoRotateIntervalDays: val });
              }
            }}
            className="input-standard w-24"
          />
        </div>
      </div>

      {saveError && (
        <div className="mt-2 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
      )}

      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
              <button onClick={handleReset} className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors">
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return 'Never';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatAbsoluteDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function peerStatusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-status-online/15 text-status-online';
    case 'pending': return 'bg-accent-lavender/15 text-accent-lavender';
    case 'unreachable': return 'bg-accent-amber/15 text-accent-amber';
    case 'revoked': return 'bg-white/5 text-txt-tertiary';
    default: return 'bg-white/5 text-txt-tertiary';
  }
}

function peerStatusDotColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-status-online';
    case 'pending': return 'bg-accent-lavender';
    case 'unreachable': return 'bg-accent-amber';
    default: return 'bg-txt-tertiary';
  }
}

type PeerView = 'active' | 'revoked';
type SortBy = 'name' | 'lastSeen' | 'dateAdded' | 'failures';
type StatusFilter = 'active' | 'unreachable' | 'pending';

// ─── Filter Dropdown ─────────────────────────────────────────────────────────

function FilterDropdown({
  view,
  statusFilter,
  setStatusFilter,
  sortBy,
  setSortBy,
}: {
  view: PeerView;
  statusFilter: Set<StatusFilter>;
  setStatusFilter: (f: Set<StatusFilter>) => void;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
}) {
  const [open, setOpen] = useState(false);

  const toggleStatus = (s: StatusFilter) => {
    const next = new Set(statusFilter);
    if (next.has(s)) {
      if (next.size > 1) next.delete(s);
    } else {
      next.add(s);
    }
    setStatusFilter(next);
  };

  const sortOptions: Array<{ key: SortBy; label: string }> = view === 'active'
    ? [
        { key: 'name', label: 'Name (A-Z)' },
        { key: 'lastSeen', label: 'Last seen' },
        { key: 'dateAdded', label: 'Date added' },
        { key: 'failures', label: 'Failures' },
      ]
    : [
        { key: 'name', label: 'Name (A-Z)' },
        { key: 'dateAdded', label: 'Revoked date' },
      ];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-txt-tertiary hover:text-txt-secondary bg-white/[0.04] hover:bg-white/[0.06] rounded transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="opacity-60">
          <path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Filter
        <span className="text-[10px]">▾</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 glass rounded-lg p-1.5 w-48">
            {view === 'active' && (
              <>
                <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-2 py-1">Status</div>
                {(['active', 'unreachable', 'pending'] as StatusFilter[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleStatus(s)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded ${
                      statusFilter.has(s) ? 'text-txt-primary bg-white/[0.04]' : 'text-txt-tertiary'
                    } hover:bg-white/[0.06] transition-colors`}
                  >
                    <div className={`w-2 h-2 rounded-full ${peerStatusDotColor(s)}`} />
                    <span className="capitalize">{s}</span>
                  </button>
                ))}
                <div className="h-px bg-white/[0.06] my-1" />
              </>
            )}
            <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-2 py-1">Sort by</div>
            {sortOptions.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => { setSortBy(opt.key); setOpen(false); }}
                className={`w-full text-left px-2 py-1.5 text-xs rounded ${
                  sortBy === opt.key ? 'text-accent-lavender bg-accent-lavender/[0.08]' : 'text-txt-primary'
                } hover:bg-white/[0.06] transition-colors`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Peer List Controls ──────────────────────────────────────────────────────

function PeerListControls({
  view,
  setView,
  activeCount,
  revokedCount,
  statusFilter,
  setStatusFilter,
  sortBy,
  setSortBy,
}: {
  view: PeerView;
  setView: (v: PeerView) => void;
  activeCount: number;
  revokedCount: number;
  statusFilter: Set<StatusFilter>;
  setStatusFilter: (f: Set<StatusFilter>) => void;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex bg-white/[0.04] rounded-md p-0.5">
        <button
          type="button"
          onClick={() => setView('active')}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            view === 'active' ? 'bg-white/[0.08] text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
        >
          Active <span className="text-[10px] text-txt-tertiary ml-0.5">{activeCount}</span>
        </button>
        <button
          type="button"
          onClick={() => setView('revoked')}
          className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
            view === 'revoked' ? 'bg-white/[0.08] text-txt-primary' : 'text-txt-tertiary hover:text-txt-secondary'
          }`}
        >
          Revoked <span className="text-[10px] text-txt-tertiary ml-0.5">{revokedCount}</span>
        </button>
      </div>
      <FilterDropdown
        view={view}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        sortBy={sortBy}
        setSortBy={setSortBy}
      />
    </div>
  );
}

// ─── Sorting ─────────────────────────────────────────────────────────────────

function sortPeers(peers: FederationPeer[], sortBy: SortBy, view: PeerView): FederationPeer[] {
  return [...peers].sort((a, b) => {
    switch (sortBy) {
      case 'name': {
        const nameA = (a.instanceName || new URL(a.origin).host).toLowerCase();
        const nameB = (b.instanceName || new URL(b.origin).host).toLowerCase();
        return nameA.localeCompare(nameB);
      }
      case 'lastSeen':
        return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
      case 'dateAdded':
        return b.createdAt - a.createdAt;
      case 'failures':
        return (b.consecutiveFailures ?? 0) - (a.consecutiveFailures ?? 0);
      default:
        return 0;
    }
  });
}

// ─── Peer Row ────────────────────────────────────────────────────────────────

function PeerRow({ peer, view, expanded, onToggleExpand, onAction, defaultAutoRotateIntervalDays }: {
  peer: FederationPeer;
  view: PeerView;
  expanded: boolean;
  onToggleExpand: () => void;
  onAction: (type: 'rotate' | 'revoke' | 'reinitiate' | 'delete') => void;
  defaultAutoRotateIntervalDays: number;
}) {
  const name = peer.instanceName || new URL(peer.origin).host;
  const isRevoked = view === 'revoked';

  return (
    <div
      className={`bg-white/[0.02] rounded-md px-3 py-2.5 cursor-pointer transition-colors hover:bg-white/[0.03] ${isRevoked ? 'opacity-70' : ''}`}
      onClick={onToggleExpand}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${isRevoked ? 'bg-txt-tertiary' : peerStatusDotColor(peer.status)}`} />
          <div className="min-w-0">
            <div className={`text-sm font-medium truncate ${isRevoked ? 'text-txt-tertiary line-through' : 'text-txt-primary'}`}>
              {name}
            </div>
            <div className="text-[11px] text-txt-tertiary truncate">
              {isRevoked
                ? `Revoked: ${formatAbsoluteDate(peer.lastSeenAt ?? peer.createdAt)} · Peered: ${formatAbsoluteDate(peer.createdAt)}`
                : peer.status === 'unreachable'
                  ? `Last seen: ${formatRelativeTime(peer.lastSeenAt)} · ${peer.consecutiveFailures ?? 0} failures`
                  : `Last seen: ${formatRelativeTime(peer.lastSeenAt)} · Synced: ${formatRelativeTime(peer.lastSyncedAt)}`
              }
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded ${peerStatusColor(peer.status)}`}>
            {peer.status}
          </span>
          <span className="text-txt-tertiary text-xs">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export function FederationPanel() {
  const addToast = useUIStore((s) => s.addToast);

  // Peer list state
  const [peers, setPeers] = useState<FederationPeer[]>([]);
  const [peersLoading, setPeersLoading] = useState(false);
  const [peersError, setPeersError] = useState('');
  const [view, setView] = useState<PeerView>('active');
  const [statusFilter, setStatusFilter] = useState<Set<StatusFilter>>(new Set(['active', 'unreachable', 'pending']));
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [expandedPeerId, setExpandedPeerId] = useState<string | null>(null);

  // Confirm dialog state (used in Task 10)
  const [confirmAction, setConfirmAction] = useState<{
    type: 'rotate' | 'revoke' | 'reinitiate' | 'delete';
    peer: FederationPeer;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchPeers = useCallback(async () => {
    setPeersLoading(true);
    setPeersError('');
    try {
      const result = await api.federation.peers();
      setPeers(result.peers);
    } catch (err) {
      setPeersError(err instanceof Error ? err.message : 'Failed to load peers');
    } finally {
      setPeersLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPeers();
  }, [fetchPeers]);

  // Derived peer lists
  const activePeers = peers.filter((p) => p.status !== 'revoked');
  const revokedPeers = peers.filter((p) => p.status === 'revoked');

  const filteredPeers = view === 'active'
    ? activePeers.filter((p) => statusFilter.has(p.status as StatusFilter))
    : revokedPeers;

  const sortedPeers = sortPeers(filteredPeers, sortBy, view);

  // Empty state message
  const emptyMessage = peers.length === 0
    ? 'No federation peers configured. Peers are created automatically when users connect to remote instances.'
    : view === 'active' && filteredPeers.length === 0
      ? 'No peers match the current filter.'
      : view === 'revoked' && revokedPeers.length === 0
        ? 'No revoked peers.'
        : null;

  return (
    <form className="space-y-5" onSubmit={(e) => e.preventDefault()}>
      <h2 className="text-lg font-semibold text-txt-primary">Federation</h2>
      <div className="text-xs text-txt-tertiary">
        Configure federation relay, secret rotation, and manage peered instances.
      </div>

      <FederationGlobalSettings />

      {/* Peered Instances */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider">Peered Instances</div>
          <button
            type="button"
            onClick={fetchPeers}
            disabled={peersLoading}
            className="text-[11px] text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
          >
            {peersLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        <div className="rounded-lg bg-white/[0.02] p-3.5">
          {peers.length > 0 && (
            <PeerListControls
              view={view}
              setView={setView}
              activeCount={activePeers.length}
              revokedCount={revokedPeers.length}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              sortBy={sortBy}
              setSortBy={setSortBy}
            />
          )}

          {peersError && (
            <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs mb-2">
              {peersError}
              <button type="button" onClick={fetchPeers} className="ml-2 underline">Retry</button>
            </div>
          )}

          {sortedPeers.length > 0 && (
            <div className="space-y-2">
              {sortedPeers.map((peer) => (
                <PeerRow
                  key={peer.id}
                  peer={peer}
                  view={view}
                  expanded={expandedPeerId === peer.id}
                  onToggleExpand={() => setExpandedPeerId(expandedPeerId === peer.id ? null : peer.id)}
                  onAction={(type) => setConfirmAction({ type, peer })}
                  defaultAutoRotateIntervalDays={useSettingsStore.getState().instanceSettings?.defaultAutoRotateIntervalDays ?? 90}
                />
              ))}
            </div>
          )}

          {emptyMessage && !peersError && !peersLoading && (
            <div className="text-xs text-txt-tertiary py-2">{emptyMessage}</div>
          )}
        </div>
      </div>
    </form>
  );
}
